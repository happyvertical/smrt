/**
 * Schema path parity (#2359, epic #2382).
 *
 * SMRT derives a table's schema through two families of code:
 *
 * - the **manifest paths** — `generateSTISchemaFromManifest` and
 *   `generateCTISchemaFromManifest`, driven by `ManifestGenerator.generateSchemas()`.
 *   They populate `manifest.json` and are therefore what production and
 *   `smrt db:migrate` see (via `ObjectRegistry.getAllSchemasAsDefinitions()`);
 * - the **registry paths** — `generateSchemaFromRegistry` and
 *   `generateSTISchemaFromRegistry`, driven by `getTestDatabase()` and the
 *   runtime `ensureSchema()` helper. They are what 195 test files run against.
 *
 * Before #2359 the two families disagreed on indexes: the registry paths
 * emitted foreign-key indexes and the manifest paths did not (196/231 FK and
 * 91/92 cross-package-ref columns unindexed in production, #2356's missing
 * `tenant_id` index, `unique: true` dropped on STI). Tests passed against a
 * schema production never got, and the comment in `testing/database.ts`
 * claiming the test path was "same as migrations" was false.
 *
 * #2363 added the third rule the fixture now pins: every table carries an
 * index for its own default list ordering — `(tenant_id, created_at)` when the
 * table is tenant-scoped, `(created_at)` otherwise — and that composite
 * replaces the standalone tenant index rather than sitting beside it.
 *
 * This suite is the guard: for a representative set of classes it runs the
 * SAME manifest through the manifest paths, through the registry paths (after
 * `ObjectRegistry.registerFromManifest`) and through
 * `getAllSchemasAsDefinitions()`, and asserts identical column and index sets.
 * Any generator change must keep the three legs equal — extend the fixture
 * rather than special-casing a path.
 *
 * Documented, deliberate non-parity (not asserted here):
 * - the build-time AST path (`generateSchema(objectDef)`) feeds only an
 *   unconsumed vite virtual module and is not held to parity (assessment A8);
 * - custom primary keys (`@field({ primaryKey: true })`) are handled by the
 *   registry CTI path only (assessment A4, #2360);
 * - column metadata that only one family carries (`foreignKey`,
 *   `description`) is not compared; column NAME, TYPE and `referenceKind` are.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeIndexPredicate } from '../migrations/differ.js';
import { ObjectRegistry } from '../registry.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { SchemaGenerator } from './generator.js';
import type { IndexDefinition, SchemaDefinition } from './types.js';

const PKG = '@happyvertical/smrt-parity';

function objectDef(
  className: string,
  fields: Record<string, FieldDefinition>,
  decoratorConfig: Record<string, unknown> = {},
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/parity/src/${className}.ts`,
    packageName: PKG,
    packageVersion: '0.0.0',
    fields,
    methods: {},
    decoratorConfig:
      decoratorConfig as SmartObjectDefinition['decoratorConfig'],
    extends: extendsName,
  } as SmartObjectDefinition;
}

/**
 * Representative fixture, keyed the way the scanner keys a manifest
 * (`@pkg:ClassName`), with each class's OWN fields only — the pipeline steps
 * below merge inherited fields and inject the tenant column exactly as
 * `ManifestGenerator.generateManifest()` does.
 */
function buildFixtureManifest(): SmartObjectManifest {
  const objects: Record<string, SmartObjectDefinition> = {};
  const add = (def: SmartObjectDefinition) => {
    objects[`${PKG}:${def.className}`] = def;
  };

  // Plain CTI object.
  add(
    objectDef('ParityPlain', {
      title: { type: 'text', required: true },
      score: { type: 'integer', default: 0 },
      note: { type: 'text', _meta: { nullable: true } },
    }),
  );

  // CTI with an inline-unique column (CTI keeps column-level UNIQUE).
  add(
    objectDef('ParityAuthor', {
      name: { type: 'text', required: true },
      email: { type: 'text', _meta: { unique: true } },
    }),
  );

  // CTI with same-package FK, cross-package ref and an `indexed: true` opt-in.
  add(
    objectDef('ParityPost', {
      body: { type: 'text' },
      authorId: { type: 'foreignKey', related: 'ParityAuthor' },
      profileId: {
        type: 'crossPackageRef',
        related: '@happyvertical/smrt-profiles:Profile',
      },
      status: { type: 'text', _meta: { indexed: true } },
    }),
  );

  // Tenant-scoped CTI whose custom conflict key leads with the tenant column
  // (leads-with suppression) — also exercises the slug lookup index (A7).
  add(
    objectDef(
      'ParityScoped',
      { externalId: { type: 'text', required: true } },
      {
        tenantScoped: { mode: 'required' },
        conflictColumns: ['tenant_id', 'external_id'],
      },
    ),
  );

  // Tenant-scoped CTI with two declared composites (#2357). One already leads
  // with `(tenant_id, created_at)`, so the default list-ordering index is
  // suppressed; the other sorts on a different column and therefore stands
  // beside it — it cannot order the default page (#2363).
  add(
    objectDef(
      'ParityCovered',
      {
        externalId: { type: 'text', required: true },
        publishDate: { type: 'datetime', _meta: { nullable: true } },
        status: { type: 'text' },
      },
      {
        tenantScoped: { mode: 'required' },
        indexes: [
          {
            name: 'parity_covereds_tenant_id_created_at_status_idx',
            columns: ['tenantId', 'created_at', 'status'],
          },
          {
            name: 'parity_covereds_tenant_id_publish_date_idx',
            columns: ['tenantId', 'publishDate'],
          },
        ],
      },
    ),
  );

  // Junction-shaped CTI: custom conflict key over two FKs. `left_id` leads the
  // unique conflict index (suppressed), `right_id` does not (indexed).
  add(
    objectDef(
      'ParityLink',
      {
        leftId: { type: 'foreignKey', related: 'ParityAuthor', required: true },
        rightId: { type: 'foreignKey', related: 'ParityPost', required: true },
      },
      { conflictColumns: ['left_id', 'right_id'] },
    ),
  );

  // Self-referencing FK.
  add(
    objectDef('ParityNode', {
      label: { type: 'text' },
      parentId: {
        type: 'foreignKey',
        related: 'ParityNode',
        _meta: { nullable: true },
      },
    }),
  );

  // Report-shaped CTI: conflict key is the primary key itself.
  add(
    objectDef(
      'ParityReport',
      { total: { type: 'integer', default: 0 } },
      { conflictColumns: ['id'] },
    ),
  );

  // STI hierarchy: base with a base-declared unique field and tenant scope,
  // two children — one with a same-package FK, an `@meta` field, a
  // descendant-only unique field and an indexed meta field; the sibling
  // shares the descendant-unique column name WITHOUT the flag and adds a
  // cross-package ref.
  add(objectDef('ParityRoom', { number: { type: 'text' } }));
  add(
    objectDef(
      'ParityEvent',
      {
        title: { type: 'text', required: true },
        code: { type: 'text', _meta: { unique: true } },
      },
      { tableStrategy: 'sti', tenantScoped: { mode: 'optional' } },
    ),
  );
  add(
    objectDef(
      'ParityMeeting',
      {
        roomId: { type: 'foreignKey', related: 'ParityRoom' },
        agenda: { type: 'meta' },
        priority: { type: 'meta', _meta: { indexed: true } },
        bookingRef: { type: 'text', _meta: { unique: true } },
      },
      {},
      'ParityEvent',
    ),
  );
  add(
    objectDef(
      'ParityWebinar',
      {
        bookingRef: { type: 'text' },
        hostProfileId: {
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-profiles:Profile',
        },
      },
      {},
      'ParityEvent',
    ),
  );

  return {
    version: '1.0.0',
    timestamp: 0,
    packageName: PKG,
    packageVersion: '0.0.0',
    objects,
  };
}

/** Column view compared across paths: name → `type/referenceKind`. */
function columnSet(
  columns: Record<string, { type: string; referenceKind?: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, col] of Object.entries(columns).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    out[name] = `${String(col.type).toUpperCase()}/${col.referenceKind ?? '-'}`;
  }
  return out;
}

/** Index view compared across paths: sorted `name` and shape signatures. */
function indexSet(indexes: ReadonlyArray<IndexDefinition>): {
  names: string[];
  signatures: string[];
} {
  const names = indexes.map((i) => i.name).sort();
  const signatures = indexes
    .map((i) => {
      const target = i.jsonPath
        ? `json:${i.jsonPath.column}.${i.jsonPath.path}`
        : (i.columns ?? []).join(',');
      return `${target}|${Boolean(i.unique)}|${normalizeIndexPredicate(i.where)}`;
    })
    .sort();
  return { names, signatures };
}

function manifestSchemaAsDefinition(
  schema: NonNullable<SmartObjectDefinition['schema']>,
): SchemaDefinition {
  return {
    tableName: schema.tableName,
    ddl: schema.ddl,
    columns: Object.fromEntries(
      Object.entries(schema.columns).map(([name, col]) => [
        name,
        {
          type: col.type as SchemaDefinition['columns'][string]['type'],
          primaryKey: col.primaryKey,
          referenceKind: col.referenceKind,
          notNull: col.notNull,
          unique: col.unique,
          defaultValue: col.default,
        },
      ]),
    ),
    indexes: schema.indexes.map((idx) => ({
      name: idx.name,
      columns: idx.columns,
      unique: idx.unique,
      where: idx.where,
      jsonPath: idx.jsonPath,
    })),
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: schema.version,
  };
}

describe('schema path parity (#2359)', () => {
  let restoreRegistry: () => void;
  let manifest: SmartObjectManifest;
  /** tableName → schema as the manifest paths produced it. */
  const manifestSchemas = new Map<string, SchemaDefinition>();
  /** tableName → schema as the registry paths produced it. */
  const registrySchemas = new Map<string, SchemaDefinition>();
  /** tableName → schema as db:migrate consumes it. */
  let migrateSchemas: Record<string, SchemaDefinition>;

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();

    // 1. Manifest paths — the production pipeline steps that shape schema.
    manifest = buildFixtureManifest();
    const manifestGenerator = new ManifestGenerator();
    manifestGenerator.injectTenantScopedFields(manifest);
    manifestGenerator.mergeInheritedFields(manifest);
    manifestGenerator.generateSchemas(manifest);

    for (const obj of Object.values(manifest.objects)) {
      if (!obj.schema) continue;
      const definition = manifestSchemaAsDefinition(obj.schema);
      const existing = manifestSchemas.get(obj.schema.tableName);
      if (existing) {
        // Every class of an STI hierarchy carries the schema of the ONE
        // shared table; they must be generated against the same root.
        expect(
          columnSet(definition.columns),
          `${obj.className} column set for ${obj.schema.tableName}`,
        ).toEqual(columnSet(existing.columns));
        expect(
          indexSet(definition.indexes),
          `${obj.className} index set for ${obj.schema.tableName}`,
        ).toEqual(indexSet(existing.indexes));
        continue;
      }
      manifestSchemas.set(obj.schema.tableName, definition);
    }

    // 2. Registry paths — feed the SAME manifest into the ObjectRegistry the
    //    way an external package's manifest is loaded, then generate through
    //    the registry twins with the config getTestDatabase() builds.
    for (const [name, obj] of Object.entries(manifest.objects)) {
      ObjectRegistry.registerFromManifest(name, obj, PKG);
    }

    const generator = new SchemaGenerator();
    for (const [name, obj] of Object.entries(manifest.objects)) {
      const registered = ObjectRegistry.getClass(name);
      expect(registered, `registered ${name}`).toBeDefined();
      const strategy = ObjectRegistry.getTableStrategy(name);
      const stiBase = ObjectRegistry.getSTIBase(name);
      const isStiChild =
        strategy === 'sti' && stiBase !== null && stiBase !== name;
      if (isStiChild) continue;

      const tableName = ObjectRegistry.getTableName(name);
      expect(tableName, `table for ${name}`).toBeDefined();
      const fields = await ObjectRegistry.getAllFields(name);
      const runtimeSchemaConfig = {
        conflictColumns: ObjectRegistry.getConflictColumns(name),
        idType: registered?.config.idType,
        // Every option that affects schema must be threaded here as well as in
        // `schema/utils.ts` and `testing/database.ts`; dropping one is exactly
        // what made `indexes` unreachable at runtime (#2357, rule 8).
        indexes: registered?.config.indexes,
        registry: ObjectRegistry,
      };
      const schema =
        strategy === 'sti'
          ? await generator.generateSTISchemaFromRegistry(
              name,
              tableName as string,
              fields,
              runtimeSchemaConfig,
            )
          : generator.generateSchemaFromRegistry(
              name,
              tableName as string,
              fields,
              runtimeSchemaConfig,
            );
      registrySchemas.set(schema.tableName, schema);
      expect(obj.className).toBeDefined();
    }

    // 3. What `smrt db:migrate` compares against the live database.
    migrateSchemas = ObjectRegistry.getAllSchemasAsDefinitions();
  });

  afterAll(() => {
    restoreRegistry?.();
  });

  const expectedTables = [
    'parity_plains',
    'parity_authors',
    'parity_posts',
    'parity_scopeds',
    'parity_covereds',
    'parity_links',
    'parity_nodes',
    'parity_reports',
    'parity_rooms',
    'parity_events',
  ];

  it('generates every fixture table on every path', () => {
    for (const table of expectedTables) {
      expect(manifestSchemas.has(table), `manifest ${table}`).toBe(true);
      expect(registrySchemas.has(table), `registry ${table}`).toBe(true);
      expect(migrateSchemas[table], `migrate ${table}`).toBeDefined();
    }
  });

  it('never emits a redundant <table>_id_idx on any path (A5)', () => {
    for (const table of expectedTables) {
      for (const [leg, schema] of [
        ['manifest', manifestSchemas.get(table)],
        ['registry', registrySchemas.get(table)],
        ['migrate', migrateSchemas[table]],
      ] as const) {
        expect(
          schema?.indexes.some(
            (i) => i.columns.length === 1 && i.columns[0] === 'id',
          ),
          `${leg} ${table} has an index on the primary key column`,
        ).toBe(false);
      }
    }
  });

  it('indexes every FK / cross-package-ref / tenant column on every path unless an unqualified index already leads with it (A1)', () => {
    for (const table of expectedTables) {
      for (const [leg, schema] of [
        ['manifest', manifestSchemas.get(table)],
        ['registry', registrySchemas.get(table)],
        ['migrate', migrateSchemas[table]],
      ] as const) {
        expect(schema).toBeDefined();
        if (!schema) continue;
        for (const [column, def] of Object.entries(schema.columns)) {
          const kind = def.referenceKind;
          if (
            kind !== 'foreignKey' &&
            kind !== 'crossPackageRef' &&
            kind !== 'tenantId'
          ) {
            continue;
          }
          const serving = schema.indexes.filter(
            (i) => !i.where && !i.jsonPath && i.columns[0] === column,
          );
          expect(
            serving.length,
            `${leg} ${table}.${column} (${kind}) should have at least one unqualified leading index`,
          ).toBeGreaterThanOrEqual(1);
          // ...and never a standalone `<table>_<column>_idx` beside a wider
          // index that already leads with the column: a B-tree serves every
          // prefix of its column list, so the duplicate would only cost
          // writes (#2359 leads-with suppression, extended by #2363's
          // `(tenant_id, created_at)` composite).
          if (serving.length > 1) {
            expect(
              serving.map((i) => i.name),
              `${leg} ${table}.${column} (${kind}) keeps a redundant standalone index beside ${JSON.stringify(serving.map((i) => i.name))}`,
            ).not.toContain(`${table}_${column}_idx`);
          }
        }
      }
    }
  });

  it('serves the default list ordering from an index on every path (#2363, A2)', () => {
    for (const table of expectedTables) {
      for (const [leg, schema] of [
        ['manifest', manifestSchemas.get(table)],
        ['registry', registrySchemas.get(table)],
        ['migrate', migrateSchemas[table]],
      ] as const) {
        expect(schema).toBeDefined();
        if (!schema) continue;
        const tenantColumn = Object.entries(schema.columns).find(
          ([, def]) => def.referenceKind === 'tenantId',
        )?.[0];
        // Tenant-scoped tables order inside the interceptor's tenant filter;
        // everything else orders straight off created_at.
        const expected = tenantColumn
          ? [tenantColumn, 'created_at']
          : ['created_at'];
        const serving = schema.indexes.filter(
          (i) =>
            !i.where &&
            !i.jsonPath &&
            expected.every(
              (column, position) => i.columns[position] === column,
            ),
        );
        expect(
          serving.map((i) => i.name),
          `${leg} ${table} has no index leading with ${expected.join(', ')}`,
        ).not.toEqual([]);
      }
    }
  });

  describe.each(expectedTables)('%s', (table) => {
    it('has the same column set on the manifest, registry and migrate paths', () => {
      const manifestColumns = columnSet(
        manifestSchemas.get(table)?.columns ?? {},
      );
      const registryColumns = columnSet(
        registrySchemas.get(table)?.columns ?? {},
      );
      const migrateColumns = columnSet(migrateSchemas[table]?.columns ?? {});

      expect(registryColumns).toEqual(manifestColumns);
      // getAllSchemasAsDefinitions() merges the manifest schema with the
      // registry's base columns; the NAME set must match exactly.
      expect(Object.keys(migrateColumns)).toEqual(Object.keys(manifestColumns));
    });

    it('has the same index set on the manifest, registry and migrate paths', () => {
      const manifestIndexes = indexSet(
        manifestSchemas.get(table)?.indexes ?? [],
      );
      const registryIndexes = indexSet(
        registrySchemas.get(table)?.indexes ?? [],
      );
      const migrateIndexes = indexSet(migrateSchemas[table]?.indexes ?? []);

      expect(registryIndexes).toEqual(manifestIndexes);
      expect(migrateIndexes).toEqual(manifestIndexes);
    });
  });

  describe('fixture-specific expectations (documents the intended index set)', () => {
    const idx = (table: string) => manifestSchemas.get(table)?.indexes ?? [];
    const names = (table: string) =>
      idx(table)
        .map((i) => i.name)
        .sort();

    it('plain CTI: the (slug, context) conflict index and the list-ordering index', () => {
      expect(names('parity_plains')).toEqual([
        'parity_plains_created_at_idx',
        'parity_plains_slug_context_idx',
      ]);
    });

    it('CTI references: FK + cross-package ref indexed, indexed:true honoured, inline unique kept on the column', () => {
      expect(names('parity_posts')).toEqual([
        'parity_posts_author_id_idx',
        'parity_posts_created_at_idx',
        'parity_posts_profile_id_idx',
        'parity_posts_slug_context_idx',
        'parity_posts_status_idx',
      ]);
      expect(manifestSchemas.get('parity_authors')?.columns.email.unique).toBe(
        true,
      );
    });

    it('tenant-scoped + custom conflict key leading with tenant_id: (tenant_id, created_at) instead of a standalone tenant index, slug lookup kept (A7, #2363)', () => {
      expect(names('parity_scopeds')).toEqual([
        'parity_scopeds_slug_context_idx',
        'parity_scopeds_tenant_id_created_at_idx',
        'parity_scopeds_tenant_id_external_id_idx',
      ]);
      // The conflict key serves the tenant equality filter, so #2359 adds no
      // standalone `tenant_id` index; the list page still needs the ordering
      // composite, which the unique conflict key cannot serve.
      expect(names('parity_scopeds')).not.toContain(
        'parity_scopeds_tenant_id_idx',
      );
      const ordering = idx('parity_scopeds').find(
        (i) => i.name === 'parity_scopeds_tenant_id_created_at_idx',
      );
      expect(ordering?.columns).toEqual(['tenant_id', 'created_at']);
      expect(Boolean(ordering?.unique)).toBe(false);
      const slugLookup = idx('parity_scopeds').find(
        (i) => i.name === 'parity_scopeds_slug_context_idx',
      );
      expect(Boolean(slugLookup?.unique)).toBe(false);
    });

    it('a declared composite leading with (tenant_id, created_at) suppresses the list-ordering index; one on another sort column does not (#2357/#2363)', () => {
      expect(names('parity_covereds')).toEqual([
        'parity_covereds_slug_context_idx',
        'parity_covereds_tenant_id_created_at_status_idx',
        'parity_covereds_tenant_id_publish_date_idx',
      ]);
      // No generated `parity_covereds_tenant_id_created_at_idx` — the declared
      // three-column index has it as a prefix. And no standalone tenant index
      // either: both declared composites lead with the tenant column.
      expect(names('parity_covereds')).not.toContain(
        'parity_covereds_tenant_id_created_at_idx',
      );
      expect(names('parity_covereds')).not.toContain(
        'parity_covereds_tenant_id_idx',
      );
      expect(
        idx('parity_covereds').find(
          (i) => i.name === 'parity_covereds_tenant_id_created_at_status_idx',
        )?.columns,
      ).toEqual(['tenant_id', 'created_at', 'status']);
      expect(
        idx('parity_covereds').find(
          (i) => i.name === 'parity_covereds_tenant_id_publish_date_idx',
        )?.columns,
      ).toEqual(['tenant_id', 'publish_date']);
    });

    it('junction-shaped conflict key: leading FK suppressed, trailing FK indexed', () => {
      expect(names('parity_links')).toEqual([
        'parity_links_created_at_idx',
        'parity_links_left_id_right_id_idx',
        'parity_links_right_id_idx',
        'parity_links_slug_context_idx',
      ]);
    });

    it('self-referencing FK is indexed', () => {
      expect(names('parity_nodes')).toEqual([
        'parity_nodes_created_at_idx',
        'parity_nodes_parent_id_idx',
        'parity_nodes_slug_context_idx',
      ]);
    });

    it('conflictColumns [id]: no conflict index beside the primary key, slug lookup kept', () => {
      expect(names('parity_reports')).toEqual([
        'parity_reports_created_at_idx',
        'parity_reports_slug_context_idx',
      ]);
      expect(idx('parity_reports').some((i) => i.unique)).toBe(false);
    });

    it('STI: plain FK/xref/tenant indexes, base-declared unique full, descendant-declared unique partial per class, meta JSON-path index', () => {
      expect(names('parity_events')).toEqual([
        'parity_events_booking_ref_parity_meeting_unique_idx',
        'parity_events_code_unique_idx',
        'parity_events_host_profile_id_idx',
        'parity_events_meta_priority_idx',
        'parity_events_meta_type_idx',
        'parity_events_room_id_idx',
        'parity_events_slug_context_meta_type_idx',
        'parity_events_tenant_id_created_at_idx',
      ]);
      // One list-ordering index for the shared table, unqualified: the base
      // class's polymorphic list carries no `_meta_type` predicate, so a
      // per-subtype composite could not serve it (same reasoning as the plain
      // STI reference indexes above, #2359).
      const ordering = idx('parity_events').find(
        (i) => i.name === 'parity_events_tenant_id_created_at_idx',
      );
      expect(ordering?.where).toBeUndefined();
      expect(ordering?.columns).toEqual(['tenant_id', 'created_at']);
      expect(names('parity_events')).not.toContain(
        'parity_events_tenant_id_idx',
      );
      const partialUnique = idx('parity_events').find(
        (i) => i.name === 'parity_events_booking_ref_parity_meeting_unique_idx',
      );
      expect(partialUnique?.unique).toBe(true);
      expect(partialUnique?.where).toBe(`_meta_type = '${PKG}:ParityMeeting'`);
      const fullUnique = idx('parity_events').find(
        (i) => i.name === 'parity_events_code_unique_idx',
      );
      expect(fullUnique?.unique).toBe(true);
      expect(fullUnique?.where).toBeUndefined();
      // The FK index is unqualified — usable by base-class polymorphic queries.
      expect(
        idx('parity_events').find((i) => i.name === 'parity_events_room_id_idx')
          ?.where,
      ).toBeUndefined();
    });
  });
});
