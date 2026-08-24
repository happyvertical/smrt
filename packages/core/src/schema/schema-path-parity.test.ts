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
 * `getAllSchemasAsDefinitions()`, and asserts identical column, foreign-key,
 * dependency, and index sets.
 * Any generator change must keep the three legs equal — extend the fixture
 * rather than special-casing a path.
 *
 * Since #2360 it also asserts that every table's `ObjectRegistry
 * .getConflictColumns()` — what `save()` upserts on — is backed by exactly one
 * unique index on every path (or is the primary key), and that a tenant-scoped
 * table's default key leads with the tenant column on the build AND runtime
 * paths, so a second tenant's `save()` of the same slug can never adopt the
 * first tenant's row.
 *
 * Documented, deliberate non-parity (not asserted here):
 * - the build-time AST path (`generateSchema(objectDef)`) feeds only an
 *   unconsumed vite virtual module and is not held to parity (assessment A8);
 * - custom primary keys (`@field({ primaryKey: true })`) are handled by the
 *   registry CTI path only (assessment A4, #2360);
 * - descriptive column metadata is not compared; physical foreign-key metadata
 *   is part of the parity contract.
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
import { identifierByteLength, MAX_IDENTIFIER_BYTES } from './index-utils.js';
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

  // Polymorphic-association-shaped CTI (#2364, epic #2382 finding A3):
  // `SmrtPolymorphicAssociation` merges `metaType`/`metaId`/`role`/
  // `sortOrder` into a concrete subclass's manifest (the abstract base
  // carries no `@smrt()` decorator of its own to declare an index on — see
  // `AssetAssociation` in smrt-assets for the real shape this mirrors). The
  // conflict key leads with the class's own FK, so `meta_type`/`meta_id` sit
  // in the middle of that unique index — an owner lookup like
  // `AssetAssociationCollection.byLeft(metaType, metaId)` ("what points at
  // this target") filters columns 2-3 of a 4-column index and needs its own
  // composite.
  add(
    objectDef(
      'ParityAssociation',
      {
        ownerId: {
          type: 'foreignKey',
          related: 'ParityAuthor',
          required: true,
        },
        metaType: { type: 'text', required: true },
        metaId: { type: 'text', required: true },
        role: { type: 'text', required: true, default: 'default' },
        sortOrder: { type: 'integer', default: 0 },
      },
      { conflictColumns: ['owner_id', 'meta_type', 'meta_id', 'role'] },
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

  // Long-named CTI whose generated conflict index overflows PostgreSQL's
  // 63-byte identifier limit — the shape that shipped as the 66-byte
  // `content_contribution_revisions_contribution_id_revision_number_idx`
  // (#2374, C5). Only that one index overflows, so the rest of the table's
  // index set doubles as a check that the guard leaves short names alone.
  add(
    objectDef(
      'ParityContentContributionRevision',
      {
        contributionId: { type: 'text', required: true },
        revisionNumber: { type: 'integer', default: 0 },
      },
      { conflictColumns: ['contribution_id', 'revision_number'] },
    ),
  );

  // Tenant-scoped CTI with the DEFAULT natural key (#2360): the conflict
  // target becomes (tenant_id, slug, context) under the stable
  // `_slug_context_idx` name, and that index also serves the tenant column.
  add(
    objectDef(
      'ParityScopedDoc',
      { title: { type: 'text', required: true } },
      { tenantScoped: { mode: 'required' } },
    ),
  );

  // Optional-tenancy CTI (NULL-tenant rows allowed): same key shape.
  add(
    objectDef(
      'ParityScopedNote',
      { body: { type: 'text' } },
      { tenantScoped: { mode: 'optional' } },
    ),
  );

  // `@report` object: no explicit conflict key; the report passes give it
  // optional tenancy and derive `[tenant_id, ...group/bucket columns]`
  // (finding A4 — the manifest CTI path used to emit (slug, context) here
  // while the runtime upserted on the report key).
  add(
    objectDef(
      'ParityDailyTotal',
      {
        storeId: {
          type: 'text',
          _meta: { __report: { kind: 'group', sourceColumn: 'storeId' } },
        },
        day: {
          type: 'datetime',
          _meta: {
            __report: { kind: 'bucket', unit: 'day', sourceColumn: 'soldAt' },
          },
        },
        revenue: {
          type: 'decimal',
          _meta: {
            __report: { kind: 'aggregate', fn: 'sum', column: 'amount' },
          },
        },
      },
      { report: { source: 'ParityPlain' } },
    ),
  );

  // Tenant-scoped STI root with a CUSTOM conflict key plus a child: the
  // STI paths must honour the root's `conflictColumns` (they used to
  // hard-code (slug, context, _meta_type), finding A4), keep slug lookups
  // served (A7), and lead nothing else with tenant_id.
  add(
    objectDef(
      'ParityTicket',
      { code: { type: 'text', required: true } },
      {
        tableStrategy: 'sti',
        tenantScoped: { mode: 'required' },
        conflictColumns: ['tenant_id', 'code'],
      },
    ),
  );
  add(
    objectDef(
      'ParityBugTicket',
      { severity: { type: 'text' } },
      {},
      'ParityTicket',
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
  // A third child whose class name is long enough that the descendant-scoped
  // partial unique index blows the 63-byte limit (#2374). The NAME carries a
  // short class token; the PREDICATE keeps the fully qualified discriminator,
  // which is what `_meta_type` actually holds.
  add(
    objectDef(
      'ParityStakeholderCoordinationWorkshop',
      { bookingRef: { type: 'text', _meta: { unique: true } } },
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

/** Column view compared across paths, including physical FK metadata. */
function columnSet(
  columns: Record<
    string,
    {
      type: string;
      referenceKind?: string;
      foreignKey?: {
        table: string;
        column: string;
        onDelete?: string;
        onUpdate?: string;
      };
    }
  >,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, col] of Object.entries(columns).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const fk = col.foreignKey
      ? `${col.foreignKey.table}.${col.foreignKey.column}/${col.foreignKey.onDelete ?? '-'}/${col.foreignKey.onUpdate ?? '-'}`
      : '-';
    out[name] =
      `${String(col.type).toUpperCase()}/${col.referenceKind ?? '-'}/${fk}`;
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
          foreignKey: col.foreignKey ? { ...col.foreignKey } : undefined,
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
    foreignKeys: Object.entries(schema.columns).flatMap(
      ([column, definition]) =>
        definition.foreignKey
          ? [
              {
                column,
                referencesTable: definition.foreignKey.table,
                referencesColumn: definition.foreignKey.column,
                onDelete: definition.foreignKey.onDelete,
                onUpdate: definition.foreignKey.onUpdate,
              },
            ]
          : [],
    ),
    dependencies: Object.values(schema.columns)
      .flatMap((definition) =>
        definition.foreignKey ? [definition.foreignKey.table] : [],
      )
      .filter((dependency) => dependency !== schema.tableName),
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

    // 1. Manifest paths — THE production pass sequence (report tenancy and
    //    conflict-key normalization included, #2360), exactly what
    //    `generateManifest()`, `ManifestBuilder` and the Vite plugin run.
    manifest = buildFixtureManifest();
    const manifestGenerator = new ManifestGenerator();
    manifestGenerator.applyGenerationPasses(manifest);

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
    'parity_associations',
    'parity_nodes',
    'parity_reports',
    'parity_content_contribution_revisions',
    'parity_scoped_docs',
    'parity_scoped_notes',
    'parity_daily_totals',
    'parity_tickets',
    'parity_rooms',
    'parity_events',
  ];

  /** The class whose key the table upserts on (STI root or the class). */
  const schemaOwnerOf: Record<string, string> = {
    parity_plains: 'ParityPlain',
    parity_authors: 'ParityAuthor',
    parity_posts: 'ParityPost',
    parity_scopeds: 'ParityScoped',
    parity_covereds: 'ParityCovered',
    parity_links: 'ParityLink',
    parity_associations: 'ParityAssociation',
    parity_nodes: 'ParityNode',
    parity_reports: 'ParityReport',
    parity_content_contribution_revisions: 'ParityContentContributionRevision',
    parity_scoped_docs: 'ParityScopedDoc',
    parity_scoped_notes: 'ParityScopedNote',
    parity_daily_totals: 'ParityDailyTotal',
    parity_tickets: 'ParityTicket',
    parity_rooms: 'ParityRoom',
    parity_events: 'ParityEvent',
  };

  it('backs `ObjectRegistry.getConflictColumns()` with exactly one unique index on every path (unique index == conflict target, #2360)', () => {
    for (const table of expectedTables) {
      const owner = `${PKG}:${schemaOwnerOf[table]}`;
      const conflictColumns = ObjectRegistry.getConflictColumns(owner);
      const primaryKey = Object.entries(
        manifestSchemas.get(table)?.columns ?? {},
      )
        .filter(([, column]) => column.primaryKey)
        .map(([name]) => name);
      const conflictIsPrimaryKey =
        primaryKey.length === conflictColumns.length &&
        primaryKey.every((column) => conflictColumns.includes(column));
      for (const [leg, schema] of [
        ['manifest', manifestSchemas.get(table)],
        ['registry', registrySchemas.get(table)],
        ['migrate', migrateSchemas[table]],
      ] as const) {
        const backing = (schema?.indexes ?? []).filter(
          (i) =>
            i.unique === true &&
            !i.where &&
            !i.jsonPath &&
            i.columns.length === conflictColumns.length &&
            i.columns.every((column) => conflictColumns.includes(column)),
        );
        expect(
          backing.length,
          `${leg} ${table}: conflict target ${JSON.stringify(conflictColumns)} should be backed by exactly one unique index (or be the primary key), got ${JSON.stringify(backing.map((i) => i.name))}`,
        ).toBe(conflictIsPrimaryKey ? 0 : 1);
      }
    }
  });

  it("keeps every generated index name inside PostgreSQL's 63-byte limit on every path (#2374, C5)", () => {
    for (const table of expectedTables) {
      for (const [leg, schema] of [
        ['manifest', manifestSchemas.get(table)],
        ['registry', registrySchemas.get(table)],
        ['migrate', migrateSchemas[table]],
      ] as const) {
        expect(schema).toBeDefined();
        if (!schema) continue;
        // Table and column names are deliberately NOT asserted: PostgreSQL
        // truncates identifiers consistently on every reference, so a long
        // table name round-trips fine, and `smrt-users` ships an intentional
        // 80-byte `@smrt({ tableName })`. Only generator-composed names have
        // to be brought back inside the limit.
        for (const index of schema.indexes) {
          expect(
            identifierByteLength(index.name),
            `${leg} ${table} index ${index.name}`,
          ).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
        }
        // Distinctness is the point of the guard: PostgreSQL would have
        // collapsed two names sharing a 63-byte prefix into one index and
        // silently skipped the second CREATE INDEX IF NOT EXISTS.
        const names = schema.indexes.map((i) => i.name);
        expect(
          new Set(names).size,
          `${leg} ${table} duplicate index names`,
        ).toBe(names.length);
      }
    }
  });

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
      expect(migrateColumns).toEqual(manifestColumns);
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

    it('has the same foreign keys and dependencies on every path', () => {
      const shape = (schema: SchemaDefinition | undefined) => ({
        foreignKeys: [...(schema?.foreignKeys ?? [])].sort((a, b) =>
          `${a.column}.${a.referencesTable}`.localeCompare(
            `${b.column}.${b.referencesTable}`,
          ),
        ),
        dependencies: [...(schema?.dependencies ?? [])].sort(),
      });
      const manifestShape = shape(manifestSchemas.get(table));
      expect(shape(registrySchemas.get(table))).toEqual(manifestShape);
      expect(shape(migrateSchemas[table])).toEqual(manifestShape);
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
      expect(
        manifestSchemas.get('parity_posts')?.columns.author_id.foreignKey,
      ).toEqual({
        table: 'parity_authors',
        column: 'id',
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
      });
      expect(
        manifestSchemas.get('parity_posts')?.columns.profile_id.foreignKey,
      ).toBeUndefined();
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
      expect(
        manifestSchemas.get('parity_scopeds')?.columns.tenant_id.foreignKey,
      ).toBeUndefined();
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
      for (const column of ['left_id', 'right_id']) {
        expect(
          manifestSchemas.get('parity_links')?.columns[column].foreignKey
            ?.onDelete,
        ).toBe('CASCADE');
        expect(migrateSchemas.parity_links.columns[column].foreignKey).toEqual(
          manifestSchemas.get('parity_links')?.columns[column].foreignKey,
        );
      }
    });

    it('polymorphic-association-shaped conflict key: owner lookup (meta_type, meta_id) indexed despite sitting mid-index (#2364, A3)', () => {
      // The conflict index NAME is shortened to its first two columns
      // (generator convention, #2359 review) but its `columns` still cover
      // the full 4-column key — asserted separately below.
      expect(names('parity_associations')).toEqual([
        'parity_associations_created_at_idx',
        'parity_associations_meta_type_meta_id_idx',
        'parity_associations_owner_id_meta_type_idx',
        'parity_associations_slug_context_idx',
      ]);
      // The leading owner_id FK is already served by the conflict index
      // (position 0), so no redundant standalone `owner_id_idx` (mirrors the
      // junction-shaped case above).
      expect(names('parity_associations')).not.toContain(
        'parity_associations_owner_id_idx',
      );
      expect(
        idx('parity_associations').find(
          (i) => i.name === 'parity_associations_meta_type_meta_id_idx',
        )?.columns,
      ).toEqual(['meta_type', 'meta_id']);
      // The 4-column conflict index leads with owner_id, not meta_type — it
      // does not serve the owner lookup as a prefix, so both indexes coexist.
      const conflictIndex = idx('parity_associations').find(
        (i) => i.name === 'parity_associations_owner_id_meta_type_idx',
      );
      expect(conflictIndex?.unique).toBe(true);
      expect(conflictIndex?.columns).toEqual([
        'owner_id',
        'meta_type',
        'meta_id',
        'role',
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

    it('tenant-scoped CTI default key: (tenant_id, slug, context) UNIQUE under the stable name, no standalone tenant index, no extra slug index (#2360)', () => {
      for (const table of ['parity_scoped_docs', 'parity_scoped_notes']) {
        // The conflict index leads with tenant_id but not with (tenant_id,
        // created_at) — its second column is slug, not created_at — so it
        // does not suppress the default list-ordering index (#2363); the two
        // together still suppress the standalone tenant index.
        expect(names(table)).toEqual([
          `${table}_slug_context_idx`,
          `${table}_tenant_id_created_at_idx`,
        ]);
        const conflict = idx(table).find(
          (i) => i.name === `${table}_slug_context_idx`,
        );
        expect(conflict?.unique).toBe(true);
        expect(conflict?.columns).toEqual(['tenant_id', 'slug', 'context']);
        expect(
          ObjectRegistry.getConflictColumns(`${PKG}:${schemaOwnerOf[table]}`),
        ).toEqual(['tenant_id', 'slug', 'context']);
        expect(
          manifest.objects[`${PKG}:${schemaOwnerOf[table]}`].decoratorConfig
            .conflictColumns,
        ).toEqual(['tenant_id', 'slug', 'context']);
      }
    });

    it('report default key: (tenant_id, group, bucket) UNIQUE on the manifest path too, slug lookup kept', () => {
      expect(names('parity_daily_totals')).toEqual([
        'parity_daily_totals_slug_context_idx',
        'parity_daily_totals_tenant_id_created_at_idx',
        'parity_daily_totals_tenant_id_store_id_idx',
      ]);
      const conflict = idx('parity_daily_totals').find(
        (i) => i.name === 'parity_daily_totals_tenant_id_store_id_idx',
      );
      expect(conflict?.unique).toBe(true);
      expect(conflict?.columns).toEqual(['tenant_id', 'store_id', 'day']);
      expect(
        ObjectRegistry.getConflictColumns(`${PKG}:ParityDailyTotal`),
      ).toEqual(['tenant_id', 'store_id', 'day']);
    });

    it('an over-long conflict index is shortened; its siblings are untouched (#2374)', () => {
      const table = 'parity_content_contribution_revisions';
      // The natural name is
      // `..._contribution_id_revision_number_idx` — 73 bytes. The literal is
      // pinned rather than recomputed: if the shortening ever changed, every
      // deployed database would drop and recreate this index on migrate.
      expect(names(table)).toEqual([
        'parity_content_contribution_revisions_contributi_7dccee80ed_idx',
        'parity_content_contribution_revisions_created_at_idx',
        'parity_content_contribution_revisions_slug_context_idx',
      ]);
      // Shortened, but still the conflict index: same columns, still UNIQUE.
      const conflict = idx(table).find((i) => i.unique);
      expect(conflict?.columns).toEqual(['contribution_id', 'revision_number']);
      expect(conflict?.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    });

    it('STI root with custom conflictColumns: honoured on both STI paths, slug lookup kept, child resolves the same key (#2360)', () => {
      expect(names('parity_tickets')).toEqual([
        'parity_tickets_meta_type_idx',
        'parity_tickets_slug_context_idx',
        'parity_tickets_tenant_id_code_idx',
        'parity_tickets_tenant_id_created_at_idx',
      ]);
      const conflict = idx('parity_tickets').find(
        (i) => i.name === 'parity_tickets_tenant_id_code_idx',
      );
      expect(conflict?.unique).toBe(true);
      expect(conflict?.columns).toEqual(['tenant_id', 'code']);
      expect(
        idx('parity_tickets').find(
          (i) => i.name === 'parity_tickets_slug_context_idx',
        )?.unique,
      ).toBeFalsy();
      expect(ObjectRegistry.getConflictColumns(`${PKG}:ParityTicket`)).toEqual([
        'tenant_id',
        'code',
      ]);
      // An STI child upserts on the ROOT's key — the table has one index.
      expect(
        ObjectRegistry.getConflictColumns(`${PKG}:ParityBugTicket`),
      ).toEqual(['tenant_id', 'code']);
    });

    it('STI: plain FK/xref indexes, tenant-led default key serves tenant_id, base-declared unique full, descendant-declared unique partial per class, meta JSON-path index', () => {
      expect(names('parity_events')).toEqual([
        'parity_events_booking_ref_parity_meeting_unique_idx',
        'parity_events_booking_ref_parity_stakehol_dacfd5775b_unique_idx',
        'parity_events_code_unique_idx',
        'parity_events_host_profile_id_idx',
        'parity_events_meta_priority_idx',
        'parity_events_meta_type_idx',
        'parity_events_room_id_idx',
        'parity_events_slug_context_meta_type_idx',
        'parity_events_tenant_id_created_at_idx',
      ]);
      const conflict = idx('parity_events').find(
        (i) => i.name === 'parity_events_slug_context_meta_type_idx',
      );
      expect(conflict?.unique).toBe(true);
      expect(conflict?.columns).toEqual([
        'tenant_id',
        'slug',
        'context',
        '_meta_type',
      ]);
      expect(ObjectRegistry.getConflictColumns(`${PKG}:ParityEvent`)).toEqual([
        'tenant_id',
        'slug',
        'context',
        '_meta_type',
      ]);
      expect(ObjectRegistry.getConflictColumns(`${PKG}:ParityMeeting`)).toEqual(
        ['tenant_id', 'slug', 'context', '_meta_type'],
      );
      // One list-ordering index for the shared table, unqualified: the base
      // class's polymorphic list carries no `_meta_type` predicate, so a
      // per-subtype composite could not serve it (same reasoning as the plain
      // STI reference indexes above, #2359). It leads with tenant_id but not
      // with `created_at` second, so it does not suppress the ordering index
      // (#2363), and the two together suppress the standalone tenant index.
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

    it('STI partial unique: a long subtype name is shortened but the predicate keeps the qualified discriminator (#2374)', () => {
      // The natural name,
      // `parity_events_booking_ref_parity_stakeholder_coordination_workshop_unique_idx`,
      // is 77 bytes. What must NOT be shortened is the `WHERE` clause: the
      // `_meta_type` column stores the fully qualified name, so a predicate
      // built from the simple class name would match zero rows and the
      // "unique" index would enforce nothing (finding C5).
      const partial = idx('parity_events').find(
        (i) =>
          i.name ===
          'parity_events_booking_ref_parity_stakehol_dacfd5775b_unique_idx',
      );
      expect(partial?.unique).toBe(true);
      expect(partial?.columns).toEqual(['booking_ref']);
      expect(partial?.where).toBe(
        `_meta_type = '${PKG}:ParityStakeholderCoordinationWorkshop'`,
      );
      expect(identifierByteLength(partial?.name ?? '')).toBeLessThanOrEqual(
        MAX_IDENTIFIER_BYTES,
      );
    });
  });
});
