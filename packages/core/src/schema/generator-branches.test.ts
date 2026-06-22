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
    const indexNames = schema.indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_comments_authorId');
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
    // PK index points at the custom column.
    expect(schema.indexes.some((i) => i.columns[0] === 'external_id')).toBe(
      true,
    );
    // No unique conflict index in custom-PK mode.
    expect(schema.indexes.some((i) => i.unique)).toBe(false);
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
    expect(schema.indexes.some((i) => i.name === 'idx_docs_owner_id')).toBe(
      true,
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
    // Base STI indexes.
    expect(indexNames).toContain('events_id_idx');
    expect(indexNames).toContain('events_slug_context_meta_type_idx');
    expect(indexNames).toContain('events_meta_type_idx');
    // Partial FK index filtered by discriminator.
    const partial = schema.indexes.find((i) => i.where?.includes('Meeting'));
    expect(partial?.columns).toEqual(['room_id']);
    // JSON-path index for the @meta indexed field.
    const jsonIdx = schema.indexes.find((i) => i.jsonPath);
    expect(jsonIdx?.jsonPath).toEqual({
      column: '_meta_data',
      path: 'priority',
    });
    // Plain column index for the indexed regular field.
    expect(indexNames).toContain('events_search_key_idx');
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
