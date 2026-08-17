/**
 * SchemaGenerator branch coverage.
 *
 * uuid-schema-generator.test.ts and schema-generation.test.ts cover the
 * runtime/CTI manifest paths and UUID reconciliation. This file targets the
 * remaining branches:
 * - generateSchema(objectDef): the build-time AST path (columns, FK column +
 *   index + dependency extraction, triggers, slug/email unique, transient and
 *   relationship-field skipping, version hashing, package extraction).
 * - generateSchemaFromRegistry: custom-PK handling, explicit timestamp fields,
 *   indexed regular columns, multi-column conflictColumns truncation.
 * - generateSTISchemaFromRegistry with an injected fake registry (descendants,
 *   FK partial indexes, meta-field JSON-path indexes, indexed columns).
 * - generateSTISchemaFromManifest descendant aggregation + self-reference guard.
 * - generateSQL / formatDefaultValue across TEXT/INTEGER/BOOLEAN/TIMESTAMP/JSON.
 */

import { describe, expect, it } from 'vitest';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { SchemaGenerator } from './generator.js';
import type { SchemaDefinition } from './types.js';

function objectDef(
  className: string,
  fields: Record<string, FieldDefinition> = {},
  decoratorConfig: Record<string, unknown> = {},
  extendsName?: string,
  filePath = `packages/test/src/${className}.ts`,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath,
    packageName: '@happyvertical/smrt-test',
    packageVersion: '0.0.0',
    fields,
    methods: {},
    decoratorConfig:
      decoratorConfig as SmartObjectDefinition['decoratorConfig'],
    extends: extendsName,
  } as SmartObjectDefinition;
}

describe('SchemaGenerator.generateSchema (build-time AST path)', () => {
  it('maps field types, emits FK column/index/dependency, and slug/email unique', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef('Comment', {
        body: { type: 'text' },
        score: { type: 'integer' },
        rating: { type: 'decimal' },
        active: { type: 'boolean' },
        publishedAt: { type: 'datetime' },
        payload: { type: 'json' },
        authorId: { type: 'foreignKey', related: 'users.id' },
        slug: { type: 'text' },
        email: { type: 'text' },
        // Relationship + transient + meta fields must be skipped.
        replies: { type: 'oneToMany', related: 'Comment' },
        tags: { type: 'manyToMany', related: 'Tag' },
        computed: { type: 'text', transient: true },
        extra: { type: 'meta' },
      }),
    );

    // SQL type mapping.
    expect(schema.columns.body.type).toBe('TEXT');
    expect(schema.columns.score.type).toBe('INTEGER');
    expect(schema.columns.rating.type).toBe('REAL');
    expect(schema.columns.active.type).toBe('BOOLEAN');
    expect(schema.columns.publishedAt.type).toBe('TIMESTAMP');
    expect(schema.columns.payload.type).toBe('JSON');
    expect(schema.columns.authorId.type).toBe('UUID');

    // FK column carries a foreignKey + the table-level FK list + dependency.
    expect(schema.columns.authorId.foreignKey).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });
    expect(schema.foreignKeys).toEqual([
      expect.objectContaining({ column: 'authorId', referencesTable: 'users' }),
    ]);
    expect(schema.dependencies).toContain('users');

    // FK index + updated_at index + slug/email unique indexes are generated.
    // The FK loop's own `idx_` index already leads with the column, so the
    // shared reference-column helper adds no duplicate.
    const indexNames = schema.indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_comments_authorId');
    expect(
      schema.indexes.filter((i) => i.columns[0] === 'authorId'),
    ).toHaveLength(1);
    expect(indexNames).toContain('idx_comments_updated_at');
    expect(
      schema.indexes.some((i) => i.unique && i.columns[0] === 'slug'),
    ).toBe(true);
    expect(
      schema.indexes.some((i) => i.unique && i.columns[0] === 'email'),
    ).toBe(true);

    // slug/email are forced unique.
    expect(schema.columns.slug.unique).toBe(true);
    expect(schema.columns.email.unique).toBe(true);

    // Skipped fields produce no columns.
    expect(schema.columns.replies).toBeUndefined();
    expect(schema.columns.tags).toBeUndefined();
    expect(schema.columns.computed).toBeUndefined();
    expect(schema.columns.extra).toBeUndefined();

    // A trigger is emitted for updated_at.
    expect(schema.triggers).toHaveLength(1);
    expect(schema.triggers[0].event).toBe('UPDATE');

    // Version is an 8-char hash, package extracted from the path.
    expect(schema.version).toMatch(/^[a-f0-9]{8}$/);
    expect(schema.packageName).toBe('test');
  });

  it('falls back to "unknown" package when the path has no packages/ segment', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef(
        'Loose',
        { name: { type: 'text' } },
        {},
        undefined,
        '/tmp/Loose.ts',
      ),
    );
    expect(schema.packageName).toBe('unknown');
  });

  it('records a base-class dependency for inheriting classes', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef('Meeting', { topic: { type: 'text' } }, {}, 'Event'),
    );
    // extends Event -> events table dependency; SmrtObject/SmrtCollection excluded.
    expect(schema.dependencies).toContain('events');
    expect(schema.baseClass).toBe('Event');
  });

  it('honors a field-level default value', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef('Defaulted', {
        status: { type: 'text', default: 'draft' },
      }),
    );
    expect(schema.columns.status.defaultValue).toBe('draft');
  });
});

describe('SchemaGenerator.generateSchemaFromRegistry', () => {
  const generator = new SchemaGenerator();

  it('emits default id/slug/context plus conflict index for a standard class', () => {
    const fields = new Map<string, any>([
      ['title', { type: 'text', _meta: { required: true } }],
    ]);
    const schema = generator.generateSchemaFromRegistry(
      'Post',
      'posts',
      fields,
    );

    expect(schema.columns.id.primaryKey).toBe(true);
    expect(schema.columns.slug).toBeDefined();
    expect(schema.columns.context).toBeDefined();
    expect(schema.columns.title.notNull).toBe(true);

    const conflict = schema.indexes.find((i) => i.unique);
    expect(conflict?.columns).toEqual(['slug', 'context']);
  });

  it('respects a custom primary key and skips synthetic slug/context', () => {
    const fields = new Map<string, any>([
      [
        'externalId',
        { type: 'text', _meta: { primaryKey: true, required: true } },
      ],
      ['label', { type: 'text' }],
    ]);
    const schema = generator.generateSchemaFromRegistry(
      'External',
      'externals',
      fields,
    );

    expect(schema.columns.external_id.primaryKey).toBe(true);
    // No synthetic defaults when a custom PK is present.
    expect(schema.columns.slug).toBeUndefined();
    expect(schema.columns.context).toBeUndefined();
    // No redundant index on the primary key column: the PK constraint is
    // already a unique index on every engine (#2359, A5).
    expect(schema.indexes.some((i) => i.columns[0] === 'external_id')).toBe(
      false,
    );
    // No unique conflict index in custom-PK mode.
    expect(schema.indexes.some((i) => i.unique)).toBe(false);
  });

  it('does not emit a <table>_id_idx beside the primary key (#2359, A5)', () => {
    const fields = new Map<string, any>([['title', { type: 'text' }]]);
    const schema = generator.generateSchemaFromRegistry(
      'Post',
      'posts',
      fields,
    );
    expect(schema.indexes.some((i) => i.name === 'posts_id_idx')).toBe(false);
    expect(
      schema.indexes.some(
        (i) => i.columns.length === 1 && i.columns[0] === 'id',
      ),
    ).toBe(false);
  });

  it('skips the conflict index when conflictColumns is exactly the primary key', () => {
    const fields = new Map<string, any>([['title', { type: 'text' }]]);
    const schema = generator.generateSchemaFromRegistry(
      'Report',
      'reports',
      fields,
      { conflictColumns: ['id'] },
    );
    // `ON CONFLICT (id)` binds to the PK constraint; no second unique index.
    expect(schema.indexes.some((i) => i.unique)).toBe(false);
    expect(schema.indexes.some((i) => i.columns[0] === 'id')).toBe(false);
  });

  it('keeps a plain (slug, context) lookup index when conflictColumns are custom (#2359, A7)', () => {
    const fields = new Map<string, any>([
      ['leftId', { type: 'text' }],
      ['rightId', { type: 'text' }],
    ]);
    const schema = generator.generateSchemaFromRegistry(
      'Link',
      'links',
      fields,
      { conflictColumns: ['left_id', 'right_id'] },
    );
    const slugLookup = schema.indexes.find(
      (i) => i.name === 'links_slug_context_idx',
    );
    expect(slugLookup?.columns).toEqual(['slug', 'context']);
    expect(Boolean(slugLookup?.unique)).toBe(false);
    // The custom conflict index is still the only unique one.
    expect(schema.indexes.filter((i) => i.unique)).toHaveLength(1);
  });

  it('does not add the slug lookup index when the conflict key already leads with slug', () => {
    const fields = new Map<string, any>([['tenantId', { type: 'text' }]]);
    const schema = generator.generateSchemaFromRegistry(
      'Scoped',
      'scoped',
      fields,
      { conflictColumns: ['slug', 'context', 'tenant_id'] },
    );
    expect(schema.indexes.filter((i) => i.columns[0] === 'slug')).toHaveLength(
      1,
    );
  });

  it('uses explicit timestamp fields and dedupes them', () => {
    const fields = new Map<string, any>([
      ['createdAt', { type: 'datetime' }],
      ['created_at', { type: 'datetime' }],
      ['updatedAt', { type: 'datetime' }],
    ]);
    const schema = generator.generateSchemaFromRegistry('T', 'ts', fields);
    expect(schema.columns.created_at).toBeDefined();
    expect(schema.columns.updated_at).toBeDefined();
  });

  it('emits a plain column index for fields tagged indexed:true', () => {
    const fields = new Map<string, any>([
      ['lookupKey', { type: 'text', _meta: { indexed: true } }],
    ]);
    const schema = generator.generateSchemaFromRegistry('L', 'lk', fields);
    expect(schema.indexes.some((i) => i.columns[0] === 'lookup_key')).toBe(
      true,
    );
  });

  it('truncates multi-column conflict index names beyond two columns', () => {
    const fields = new Map<string, any>([['a', { type: 'text' }]]);
    const schema = generator.generateSchemaFromRegistry(
      'Multi',
      'multi',
      fields,
      {
        conflictColumns: ['one', 'two', 'three'],
      },
    );
    const conflict = schema.indexes.find((i) => i.unique);
    // Index name uses only the first two columns, but indexes all three.
    expect(conflict?.name).toBe('multi_one_two_idx');
    expect(conflict?.columns).toEqual(['one', 'two', 'three']);
  });

  it('skips transient, relationship, and meta fields', () => {
    const fields = new Map<string, any>([
      ['gone', { type: 'text', transient: true }],
      ['many', { type: 'oneToMany', related: 'X' }],
      ['m2m', { type: 'manyToMany', related: 'Y' }],
      ['flex', { type: 'meta' }],
      ['kept', { type: 'text' }],
    ]);
    const schema = generator.generateSchemaFromRegistry('S', 's', fields);
    expect(schema.columns.gone).toBeUndefined();
    expect(schema.columns.many).toBeUndefined();
    expect(schema.columns.m2m).toBeUndefined();
    expect(schema.columns.flex).toBeUndefined();
    expect(schema.columns.kept).toBeDefined();
  });

  it('emits a foreign key column + index from a registry foreignKey field', () => {
    const fields = new Map<string, any>([
      [
        'ownerId',
        {
          type: 'foreignKey',
          related: 'User',
          _meta: { onDelete: 'SET NULL' },
        },
      ],
    ]);
    const schema = generator.generateSchemaFromRegistry('Doc', 'docs', fields);
    expect(schema.columns.owner_id.foreignKey).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
    // Reference columns share one naming scheme across every path (#2359).
    expect(schema.indexes.some((i) => i.name === 'docs_owner_id_idx')).toBe(
      true,
    );
  });

  it('indexes @crossPackageRef columns like foreign keys (#2359, A1)', () => {
    const fields = new Map<string, any>([
      [
        'profileId',
        {
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-profiles:Profile',
        },
      ],
    ]);
    const schema = generator.generateSchemaFromRegistry('Doc', 'docs', fields);
    expect(schema.columns.profile_id.referenceKind).toBe('crossPackageRef');
    const idx = schema.indexes.find((i) => i.name === 'docs_profile_id_idx');
    expect(idx?.columns).toEqual(['profile_id']);
  });

  it('does not duplicate a reference index that already leads a unique conflict index', () => {
    const fields = new Map<string, any>([
      ['leftId', { type: 'foreignKey', related: 'Left' }],
      ['rightId', { type: 'foreignKey', related: 'Right' }],
    ]);
    const schema = generator.generateSchemaFromRegistry(
      'Link',
      'links',
      fields,
      { conflictColumns: ['left_id', 'right_id'] },
    );
    // left_id leads the conflict index → no standalone index; right_id does
    // not lead anything → it gets one.
    expect(
      schema.indexes.filter((i) => i.columns[0] === 'left_id'),
    ).toHaveLength(1);
    expect(schema.indexes.some((i) => i.name === 'links_right_id_idx')).toBe(
      true,
    );
  });

  it('does not add a reference index for a column that is already inline UNIQUE', () => {
    // A unique reference column (e.g. a one-to-one crossPackageRef) renders
    // an inline UNIQUE on CTI tables — an implicit unique index on every
    // engine — so a second plain index would be redundant.
    const fields = new Map<string, any>([
      [
        'profileId',
        {
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-profiles:Profile',
          _meta: { unique: true },
        },
      ],
    ]);
    const schema = generator.generateSchemaFromRegistry(
      'User',
      'users',
      fields,
    );
    expect(schema.columns.profile_id.unique).toBe(true);
    expect(schema.indexes.some((i) => i.columns[0] === 'profile_id')).toBe(
      false,
    );
  });
});

describe('SchemaGenerator.generateSTISchemaFromRegistry (injected registry)', () => {
  const generator = new SchemaGenerator();

  function fakeRegistry(
    fieldsByClass: Record<string, Map<string, any>>,
    descendants: string[],
  ) {
    return {
      getDescendants: () => descendants,
      getAllFields: async (className: string) =>
        fieldsByClass[className] ?? new Map(),
    };
  }

  it('aggregates descendant FK columns, meta indexes, and plain indexes', async () => {
    const baseFields = new Map<string, any>([
      ['title', { type: 'text' }],
      // meta field opted into JSON-path indexing
      ['priority', { type: 'meta', indexed: true }],
    ]);
    const childFields = new Map<string, any>([
      ['title', { type: 'text' }], // duplicate -> inherited skip
      ['roomId', { type: 'foreignKey', related: 'Room' }],
      ['searchKey', { type: 'text', _meta: { indexed: true } }],
    ]);

    const registry = fakeRegistry({ Event: baseFields, Meeting: childFields }, [
      'Meeting',
    ]);

    const schema = await generator.generateSTISchemaFromRegistry(
      'Event',
      'events',
      new Map(),
      { registry: registry as any },
    );

    // STI discriminator + meta columns.
    expect(schema.columns._meta_type).toBeDefined();
    expect(schema.columns._meta_data).toBeDefined();
    // All aggregated columns are nullable.
    expect(schema.columns.title.notNull).toBe(false);
    expect(schema.columns.room_id.notNull).toBe(false);

    const indexNames = schema.indexes.map((i) => i.name);
    // Base STI indexes — no `<table>_id_idx` beside the PK (#2359, A5).
    expect(indexNames).not.toContain('events_id_idx');
    expect(indexNames).toContain('events_slug_context_meta_type_idx');
    expect(indexNames).toContain('events_meta_type_idx');
    // One plain (unqualified) FK index — not a per-class partial index, so
    // base-class polymorphic queries can use it too (#2359).
    const fkIndexes = schema.indexes.filter((i) => i.columns[0] === 'room_id');
    expect(fkIndexes).toHaveLength(1);
    expect(fkIndexes[0].name).toBe('events_room_id_idx');
    expect(fkIndexes[0].where).toBeUndefined();
    // JSON-path index for the @meta indexed field.
    const jsonIdx = schema.indexes.find((i) => i.jsonPath);
    expect(jsonIdx?.jsonPath).toEqual({
      column: '_meta_data',
      path: 'priority',
    });
    // Plain column index for the indexed regular field.
    expect(indexNames).toContain('events_search_key_idx');
  });

  it('emits a full unique index for a unique field declared on the STI base (#2359, A4)', async () => {
    const baseFields = new Map<string, any>([
      ['email', { type: 'text', _meta: { unique: true } }],
    ]);
    // Descendants re-list inherited fields with the same metadata.
    const childFields = new Map<string, any>([
      ['email', { type: 'text', _meta: { unique: true } }],
      ['nickname', { type: 'text' }],
    ]);
    const registry = fakeRegistry(
      { Profile: baseFields, Person: childFields },
      ['Person'],
    );

    const schema = await generator.generateSTISchemaFromRegistry(
      'Profile',
      'profiles',
      new Map(),
      { registry: registry as any },
    );

    const unique = schema.indexes.filter(
      (i) => i.unique && i.columns[0] === 'email',
    );
    expect(unique).toHaveLength(1);
    expect(unique[0].name).toBe('profiles_email_unique_idx');
    expect(unique[0].where).toBeUndefined();
    // Enforced through the index, not an inline column constraint the differ
    // could never add to an existing table.
    expect(schema.columns.email.unique).toBe(false);
  });

  it('emits per-class partial unique indexes for a unique field declared only on descendants', async () => {
    const baseFields = new Map<string, any>([['title', { type: 'text' }]]);
    const meetingFields = new Map<string, any>([
      ['title', { type: 'text' }],
      ['bookingRef', { type: 'text', _meta: { unique: true } }],
    ]);
    // Sibling shares the column name without the unique flag → unaffected.
    const webinarFields = new Map<string, any>([
      ['title', { type: 'text' }],
      ['bookingRef', { type: 'text' }],
    ]);
    const registry = fakeRegistry(
      {
        Event: baseFields,
        '@test/pkg:Meeting': meetingFields,
        '@test/pkg:Webinar': webinarFields,
      },
      ['@test/pkg:Meeting', '@test/pkg:Webinar'],
    );

    const schema = await generator.generateSTISchemaFromRegistry(
      'Event',
      'events',
      new Map(),
      { registry: registry as any },
    );

    const unique = schema.indexes.filter(
      (i) => i.unique && i.columns[0] === 'booking_ref',
    );
    expect(unique).toHaveLength(1);
    expect(unique[0].name).toBe('events_booking_ref_meeting_unique_idx');
    expect(unique[0].where).toBe("_meta_type = '@test/pkg:Meeting'");
  });

  it('disambiguates per-class unique index names when two packages share a simple class name', async () => {
    const uniqueField = new Map<string, any>([
      ['code', { type: 'text', _meta: { unique: true } }],
    ]);
    const registry = fakeRegistry(
      {
        Event: new Map(),
        '@a/pkg:Meeting': uniqueField,
        '@b/pkg:Meeting': uniqueField,
      },
      ['@a/pkg:Meeting', '@b/pkg:Meeting'],
    );
    const schema = await generator.generateSTISchemaFromRegistry(
      'Event',
      'events',
      new Map(),
      { registry: registry as any },
    );
    const unique = schema.indexes.filter((i) => i.unique && i.where);
    expect(unique).toHaveLength(2);
    expect(new Set(unique.map((i) => i.name)).size).toBe(2);
    expect(unique.map((i) => i.where).sort()).toEqual([
      "_meta_type = '@a/pkg:Meeting'",
      "_meta_type = '@b/pkg:Meeting'",
    ]);
  });

  it('is not rendered as a table-wide UNIQUE by the DuckDB strategy (no partial indexes there)', async () => {
    const { getDDLStrategy } = await import('./ddl/index.js');
    const registry = fakeRegistry(
      {
        Event: new Map(),
        Meeting: new Map<string, any>([
          ['bookingRef', { type: 'text', _meta: { unique: true } }],
        ]),
      },
      ['Meeting'],
    );
    const schema = await generator.generateSTISchemaFromRegistry(
      'Event',
      'events',
      new Map(),
      { registry: registry as any },
    );
    const duckdb = getDDLStrategy('duckdb').generateIndexes(schema).join('\n');
    // Widening the descendant-scoped unique to the whole table would reject
    // sibling rows; DuckDB simply does not get this constraint.
    expect(duckdb).not.toContain('booking_ref');
    expect(getDDLStrategy('duckdb').generateCreateTable(schema)).not.toContain(
      'UNIQUE("booking_ref")',
    );
    // SQLite/PostgreSQL keep the predicate.
    const sqlite = getDDLStrategy('sqlite').generateIndexes(schema).join('\n');
    expect(sqlite).toContain('UNIQUE INDEX');
    expect(sqlite).toContain("WHERE _meta_type = 'Meeting'");
  });

  it('loads ObjectRegistry from config when none is injected (default branch covered elsewhere)', async () => {
    // Provide a registry to avoid importing the real one, but with no
    // descendants and only the base — exercises the empty-descendants path
    // and the timestamp-fallback branch.
    const registry = {
      getDescendants: () => [],
      getAllFields: async () => new Map(),
    };
    const schema = await generator.generateSTISchemaFromRegistry(
      'Solo',
      'solos',
      new Map(),
      { registry: registry as any },
    );
    expect(schema.columns.created_at).toBeDefined();
    expect(schema.columns.updated_at).toBeDefined();
    expect(schema.tableName).toBe('solos');
  });
});

describe('SchemaGenerator.generateSTISchemaFromManifest', () => {
  const generator = new SchemaGenerator();

  function manifest(
    objects: Record<string, SmartObjectDefinition>,
  ): SmartObjectManifest {
    return {
      version: '1.0.0',
      timestamp: 0,
      packageName: '@happyvertical/smrt-test',
      objects,
    };
  }

  it('aggregates base + descendant fields and emits STI structure', () => {
    const m = manifest({
      Animal: objectDef('Animal', { name: { type: 'text' } }),
      Dog: objectDef(
        'Dog',
        {
          breed: { type: 'text' },
          ownerId: { type: 'foreignKey', related: 'Owner' },
        },
        {},
        'Animal',
      ),
    });

    const schema = generator.generateSTISchemaFromManifest(
      'Animal',
      'animals',
      m.objects.Animal.fields,
      m,
    );

    expect(schema.columns._meta_type).toBeDefined();
    expect(schema.columns.name).toBeDefined();
    expect(schema.columns.breed).toBeDefined();
    expect(schema.columns.owner_id).toBeDefined();
    // DDL is generated and the version is hashed.
    expect(schema.ddl).toContain('CREATE TABLE');
    expect(schema.version).toMatch(/^[a-f0-9]{8}$/);
    // STI unique index present.
    expect(
      schema.indexes.some(
        (i) => i.name === 'animals_slug_context_meta_type_idx',
      ),
    ).toBe(true);
  });

  it('skips a self-referential descendant (same name extends same name)', () => {
    const m = manifest({
      PolyEvent: objectDef('PolyEvent', { title: { type: 'text' } }),
      // A class whose className == extends (cross-package same-name) is skipped.
      Self: {
        ...objectDef('PolyEvent', { dup: { type: 'text' } }, {}, 'PolyEvent'),
      },
    });

    const schema = generator.generateSTISchemaFromManifest(
      'PolyEvent',
      'poly_events',
      m.objects.PolyEvent.fields,
      m,
    );

    // The self-referential entry's `dup` field must not be aggregated.
    expect(schema.columns.dup).toBeUndefined();
    expect(schema.columns.title).toBeDefined();
  });

  it('captures indexed meta fields and indexed regular columns from the manifest', () => {
    const m = manifest({
      Note: objectDef('Note', {
        tag: { type: 'meta', indexed: true } as FieldDefinition,
        lookup: { type: 'text', indexed: true } as FieldDefinition,
      }),
    });

    const schema = generator.generateSTISchemaFromManifest(
      'Note',
      'notes',
      m.objects.Note.fields,
      m,
    );

    expect(schema.indexes.some((i) => i.jsonPath?.path === 'tag')).toBe(true);
    expect(schema.indexes.some((i) => i.name === 'notes_lookup_idx')).toBe(
      true,
    );
  });
});

describe('SchemaGenerator.generateSQL / formatDefaultValue', () => {
  const generator = new SchemaGenerator();

  function schemaWith(columns: SchemaDefinition['columns']): SchemaDefinition {
    return {
      tableName: 'defaults',
      columns,
      indexes: [],
      triggers: [],
      foreignKeys: [],
      version: '',
      dependencies: [],
    };
  }

  it('renders SQL keyword and function defaults verbatim', () => {
    const sql = generator.generateSQL(
      schemaWith({
        a: { type: 'TIMESTAMP', defaultValue: 'current_timestamp' },
        b: { type: 'TEXT', defaultValue: "datetime('now')" },
        c: { type: 'TEXT', defaultValue: 'uuid_generate_v4()' },
      }),
    );
    expect(sql).toContain('DEFAULT current_timestamp');
    expect(sql).toContain("DEFAULT datetime('now')");
    expect(sql).toContain('DEFAULT uuid_generate_v4()');
  });

  it('quotes/escapes TEXT, formats INTEGER/REAL, NULL, and BOOLEAN defaults', () => {
    const sql = generator.generateSQL(
      schemaWith({
        t: { type: 'TEXT', defaultValue: "O'Hara" },
        i: { type: 'INTEGER', defaultValue: 42 },
        r: { type: 'REAL', defaultValue: null },
        bTrue: { type: 'BOOLEAN', defaultValue: true },
        bFalse: { type: 'BOOLEAN', defaultValue: false },
      }),
    );
    expect(sql).toContain(`DEFAULT 'O''Hara'`);
    expect(sql).toContain('DEFAULT 42');
    expect(sql).toContain('DEFAULT NULL');
    expect(sql).toContain('DEFAULT TRUE');
    expect(sql).toContain('DEFAULT FALSE');
  });

  it('formats TIMESTAMP string vs non-string defaults', () => {
    const sql = generator.generateSQL(
      schemaWith({
        s: { type: 'TIMESTAMP', defaultValue: '2024-01-01T00:00:00Z' },
        n: { type: 'TIMESTAMP', defaultValue: 12345 },
      }),
    );
    expect(sql).toContain(`DEFAULT '2024-01-01T00:00:00Z'`);
    // Non-string timestamp falls back to current_timestamp.
    expect(sql).toContain('DEFAULT current_timestamp');
  });

  it('handles JSON defaults: null, empty string, [object Object], valid + invalid JSON, objects', () => {
    const nullSql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: null } }),
    );
    expect(nullSql).toContain(`DEFAULT 'null'`);

    const emptySql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: '' } }),
    );
    expect(emptySql).toContain(`DEFAULT 'null'`);

    const objStrSql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: '[object Object]' } }),
    );
    expect(objStrSql).toContain(`DEFAULT '{}'`);

    const validSql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: '{"k":1}' } }),
    );
    expect(validSql).toContain(`DEFAULT '{"k":1}'`);

    const invalidSql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: 'not json' } }),
    );
    // Non-JSON string is encoded as a JSON string literal.
    expect(invalidSql).toContain(`DEFAULT '"not json"'`);

    const objSql = generator.generateSQL(
      schemaWith({ a: { type: 'JSON', defaultValue: { k: 2 } } }),
    );
    expect(objSql).toContain(`DEFAULT '{"k":2}'`);
  });

  it('delegates to the engine strategy when an engine is supplied', () => {
    const sql = generator.generateSQL(
      schemaWith({ id: { type: 'UUID', primaryKey: true, notNull: true } }),
      'sqlite',
    );
    // SQLite maps UUID -> TEXT.
    expect(sql).toContain('"id" TEXT');
  });

  it('emits PRIMARY KEY, NOT NULL, and UNIQUE column constraints', () => {
    const sql = generator.generateSQL(
      schemaWith({
        id: { type: 'TEXT', primaryKey: true, notNull: true },
        email: { type: 'TEXT', unique: true, notNull: true },
      }),
    );
    expect(sql).toContain('"id" TEXT PRIMARY KEY NOT NULL');
    expect(sql).toContain('"email" TEXT NOT NULL UNIQUE');
  });
});

describe('SchemaGenerator tenant_id auto-index (#2356)', () => {
  it('indexes a tenancy-injected tenant_id column', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef('Note', {
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true } },
        },
        title: { type: 'text' },
      }),
    );

    // Derive the tenant column rather than assuming its spelling: the
    // build-time path keeps the field name, the registry path snake_cases it.
    const tenantColumn = Object.entries(schema.columns).find(
      ([, column]) => column.referenceKind === 'tenantId',
    )?.[0];
    expect(tenantColumn).toBeDefined();
    expect(
      schema.indexes.some((index) => index.columns[0] === tenantColumn),
    ).toBe(true);
  });

  it('adds nothing when the object is not tenant-scoped', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchema(
      objectDef('Plain', { title: { type: 'text' } }),
    );

    expect(
      Object.values(schema.columns).some(
        (column) => column.referenceKind === 'tenantId',
      ),
    ).toBe(false);
    expect(schema.indexes.some((index) => /tenant/i.test(index.name))).toBe(
      false,
    );
  });

  // The build-time AST path never emits the conflictColumns composite, so a
  // suppression test there cannot fail. Exercise the paths that do emit it:
  // the registry CTI path and both manifest paths.
  const tenantField = {
    type: 'text' as const,
    _meta: { __tenancy: { isTenantIdField: true } },
  };

  it('does not duplicate when the registry conflict index already leads with tenant_id', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateSchemaFromRegistry(
      'Scoped',
      'scoped',
      new Map<string, any>([
        ['tenantId', tenantField],
        ['externalId', { type: 'text' }],
      ]),
      { conflictColumns: ['tenant_id', 'external_id'] },
    );

    const leading = schema.indexes.filter(
      (index) => index.columns[0] === 'tenant_id',
    );
    expect(leading).toHaveLength(1);
    expect(leading[0].unique).toBe(true);
  });

  it('does not duplicate when the manifest CTI conflict index already leads with tenant_id', () => {
    const generator = new SchemaGenerator();
    const schema = generator.generateCTISchemaFromManifest(
      'Scoped',
      'scoped',
      {
        tenantId: tenantField,
        externalId: { type: 'text' },
      },
      { conflictColumns: ['tenant_id', 'external_id'] },
    );

    const leading = schema.indexes.filter(
      (index) => index.columns[0] === 'tenant_id',
    );
    expect(leading).toHaveLength(1);
    expect(leading[0].unique).toBe(true);
  });

  it('adds the tenant index on the manifest STI path (the STI conflict index leads with slug)', () => {
    const generator = new SchemaGenerator();
    const m: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: 0,
      packageName: '@happyvertical/smrt-test',
      objects: {
        Note: objectDef('Note', {
          tenantId: tenantField,
          body: { type: 'text' },
        }),
      },
    };
    const schema = generator.generateSTISchemaFromManifest(
      'Note',
      'notes',
      m.objects.Note.fields,
      m,
    );
    const leading = schema.indexes.filter(
      (index) => index.columns[0] === 'tenant_id',
    );
    expect(leading).toHaveLength(1);
    expect(leading[0].name).toBe('notes_tenant_id_idx');
  });

  it('is not suppressed by a PARTIAL index that leads with the reference column', async () => {
    // A `WHERE _meta_type = ...` index cannot serve a base-class polymorphic
    // query, which carries no subtype predicate — only an unqualified leading
    // index counts as coverage (#2359, review of #2384). A descendant-only
    // unique FK produces exactly such a partial index on the STI path.
    const generator = new SchemaGenerator();
    const registry = {
      getDescendants: () => ['Meeting'],
      getAllFields: async (className: string) =>
        className === 'Meeting'
          ? new Map<string, any>([
              [
                'roomId',
                {
                  type: 'foreignKey',
                  related: 'Room',
                  _meta: { unique: true },
                },
              ],
            ])
          : new Map<string, any>(),
    };
    const schema = await generator.generateSTISchemaFromRegistry(
      'Event',
      'events',
      new Map(),
      { registry: registry as any },
    );

    const onRoom = schema.indexes.filter((i) => i.columns[0] === 'room_id');
    expect(onRoom.map((i) => i.name).sort()).toEqual([
      'events_room_id_idx',
      'events_room_id_meeting_unique_idx',
    ]);
    expect(onRoom.find((i) => i.name === 'events_room_id_idx')?.where).toBe(
      undefined,
    );
  });
});
