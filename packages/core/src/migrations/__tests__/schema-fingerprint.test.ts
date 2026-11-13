import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import corePackage from '../../../package.json' with { type: 'json' };
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { manifestSchemaToDefinition } from '../../schema/manifest-schema.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { collectMigrateRecordInput } from '../migrate-record.js';
import { computeSchemaFingerprint } from '../schema-fingerprint.js';

function schema(): SchemaDefinition {
  return {
    tableName: 'entries',
    columns: {
      id: { type: 'UUID', primaryKey: true },
      score: {
        type: 'INTEGER',
        notNull: true,
        defaultValue: 0,
        check: 'score >= 0',
      },
      parent_id: {
        type: 'UUID',
        foreignKey: { table: 'parents', column: 'id' },
      },
    },
    indexes: [
      {
        name: 'entries_score',
        columns: ['score', 'id'],
        unique: true,
        where: 'score > 0',
      },
    ],
    foreignKeys: [],
    triggers: [
      {
        name: 'entry_trigger',
        when: 'AFTER',
        event: 'UPDATE',
        body: 'SELECT 1;',
      },
    ],
    dependencies: [],
    version: '',
  };
}

function declaration(
  className: string,
  packageName: string,
  fields: SmartObjectDefinition['fields'],
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/fixture/${className}.ts`,
    fields,
    methods: {},
    decoratorConfig: {},
    packageName,
    extends: 'SmrtObject',
  } as SmartObjectDefinition;
}

function builtManifest(): SmartObjectManifest {
  const manifest = new ManifestGenerator().generateManifest([
    {
      filePath: '/fixture',
      errors: [],
      objects: [
        declaration('FingerprintParent', '@fixture/library', {
          title: { type: 'text', required: true, default: '' },
        }),
        declaration('FingerprintEntry', '@fixture/app', {
          count: { type: 'integer', default: 0 },
          parentId: {
            type: 'foreignKey',
            related: '@fixture/library:FingerprintParent',
          },
        }),
      ],
    },
  ]);
  // These are the JSON bytes a manifest build produces, without registry use.
  return JSON.parse(JSON.stringify(manifest)) as SmartObjectManifest;
}

describe('whole-schema fingerprint (#4926)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  it('matches the built manifest and registry loaded from that exact package set, including app models', () => {
    const manifest = builtManifest();
    const definitions = Object.values(manifest.objects).flatMap((object) =>
      object.schema ? [manifestSchemaToDefinition(object.schema)] : [],
    );
    const expected = computeSchemaFingerprint(definitions);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(definitions).toHaveLength(2);
    for (const [name, object] of Object.entries(manifest.objects).reverse()) {
      ObjectRegistry.registerFromManifest(name, object, object.packageName);
    }
    expect(
      computeSchemaFingerprint(ObjectRegistry.getAllSchemasAsDefinitions()),
    ).toBe(expected);
    const input = collectMigrateRecordInput();
    expect(input).toEqual({
      release: corePackage.version,
      packages: ['@fixture/app', '@fixture/library'],
      fingerprint: expected,
    });
    expect(computeSchemaFingerprint(definitions.slice(1))).not.toBe(expected);
  });

  it('ignores presentation metadata, source data, DDL previews and declaration order', () => {
    const original = schema();
    const changed = structuredClone(original);
    changed.version = 'different';
    changed.packageName = '/absolute/source/path';
    changed.ddl = 'stale preview';
    changed.columns = Object.fromEntries(
      Object.entries(changed.columns).reverse(),
    );
    changed.columns.score.description = 'A new label';
    Object.assign(changed.columns.score, {
      label: 'Score',
      ui: { order: 9 },
      source: '/absolute/path.ts',
    });
    changed.columns.score.backfill = '42';
    changed.columns.parent_id.referenceKind = 'foreignKey';
    changed.indexes[0].description = 'UI label';
    changed.triggers[0].description = 'Docs';
    expect(computeSchemaFingerprint([original])).toBe(
      computeSchemaFingerprint([changed]),
    );
    const other = { ...schema(), tableName: 'others' };
    expect(computeSchemaFingerprint([original, other])).toBe(
      computeSchemaFingerprint([other, changed]),
    );
    expect(computeSchemaFingerprint([original, original])).toBe(
      computeSchemaFingerprint([original]),
    );
  });

  it('canonicalizes nested JSON defaults and unordered index, trigger and FK lists', () => {
    const original = schema();
    original.columns.payload = {
      type: 'JSON',
      defaultValue: { z: 1, nested: { b: 2, a: 1 } },
    };
    original.indexes.push({ name: 'entries_parent', columns: ['parent_id'] });
    original.triggers.push({
      name: 'entry_insert',
      when: 'AFTER',
      event: 'INSERT',
      body: 'SELECT 2;',
    });
    original.foreignKeys = [
      {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
      { column: 'id', referencesTable: 'other', referencesColumn: 'id' },
    ];
    const changed = structuredClone(original);
    changed.columns.payload.defaultValue = { nested: { a: 1, b: 2 }, z: 1 };
    changed.indexes.reverse();
    changed.triggers.reverse();
    changed.foreignKeys.reverse();
    expect(computeSchemaFingerprint([changed])).toBe(
      computeSchemaFingerprint([original]),
    );
    changed.foreignKeys[0].referencesColumn = 'other_id';
    expect(computeSchemaFingerprint([changed])).not.toBe(
      computeSchemaFingerprint([original]),
    );
  });

  it('normalizes defaults through the DDL formatter and ignores dynamic timestamp values', () => {
    const original = schema();
    original.columns.clock = {
      type: 'TIMESTAMP',
      defaultValue: new Date('2025-01-01'),
    };
    const changed = structuredClone(original);
    changed.columns.clock.defaultValue = new Date('2026-01-01');
    changed.columns.score.defaultValue = '0';
    expect(computeSchemaFingerprint([changed])).toBe(
      computeSchemaFingerprint([original]),
    );
    changed.columns.clock.defaultValue = '2026-01-01';
    expect(computeSchemaFingerprint([changed])).not.toBe(
      computeSchemaFingerprint([original]),
    );
  });

  it('is stable across registration order and non-database manifest changes', () => {
    const manifest = builtManifest();
    const register = () => {
      for (const [name, object] of Object.entries(manifest.objects))
        ObjectRegistry.registerFromManifest(name, object, object.packageName);
      return collectMigrateRecordInput();
    };
    const first = register();
    ObjectRegistry.clear();
    manifest.objects = Object.fromEntries(
      Object.entries(manifest.objects).reverse(),
    );
    for (const object of Object.values(manifest.objects)) {
      object.filePath = '/different/absolute/path';
      object.description = 'Different docs';
      for (const field of Object.values(object.fields)) {
        field.description = 'Changed label';
        field._meta = { ...field._meta, ui: { group: 'Hello' } };
      }
    }
    expect(register()).toEqual(first);
  });

  it.each([
    [
      'column type',
      (s: SchemaDefinition) => {
        s.columns.score.type = 'REAL';
      },
    ],
    [
      'nullability',
      (s: SchemaDefinition) => {
        s.columns.score.notNull = false;
      },
    ],
    [
      'default',
      (s: SchemaDefinition) => {
        s.columns.score.defaultValue = 2;
      },
    ],
    [
      'primary key',
      (s: SchemaDefinition) => {
        s.columns.id.primaryKey = false;
      },
    ],
    [
      'unique column',
      (s: SchemaDefinition) => {
        s.columns.score.unique = true;
      },
    ],
    [
      'CHECK',
      (s: SchemaDefinition) => {
        s.columns.score.check = 'score >= 1';
      },
    ],
    [
      'index order',
      (s: SchemaDefinition) => {
        s.indexes[0].columns.reverse();
      },
    ],
    [
      'index unique',
      (s: SchemaDefinition) => {
        s.indexes[0].unique = false;
      },
    ],
    [
      'index predicate',
      (s: SchemaDefinition) => {
        s.indexes[0].where = 'score > 1';
      },
    ],
    [
      'nulls not distinct',
      (s: SchemaDefinition) => {
        s.indexes[0].nullsNotDistinct = true;
      },
    ],
    [
      'JSON path',
      (s: SchemaDefinition) => {
        s.indexes[0].jsonPath = { column: 'score', path: '$.x' };
      },
    ],
    [
      'foreign key',
      (s: SchemaDefinition) => {
        s.columns.parent_id.foreignKey = {
          table: 'other_parents',
          column: 'id',
        };
      },
    ],
    [
      'FK action',
      (s: SchemaDefinition) => {
        s.columns.parent_id.foreignKey = {
          table: 'parents',
          column: 'id',
          onDelete: 'CASCADE',
        };
      },
    ],
    [
      'FK engine',
      (s: SchemaDefinition) => {
        s.columns.parent_id.foreignKey = {
          table: 'parents',
          column: 'id',
          engines: ['postgres'],
        };
      },
    ],
    [
      'trigger body',
      (s: SchemaDefinition) => {
        s.triggers[0].body = 'SELECT 2;';
      },
    ],
    [
      'trigger event',
      (s: SchemaDefinition) => {
        s.triggers[0].event = 'DELETE';
      },
    ],
    [
      'table name',
      (s: SchemaDefinition) => {
        s.tableName = 'other_entries';
      },
    ],
  ])('changes for %s', (_name, change) => {
    const original = schema();
    const changed = structuredClone(original);
    change(changed);
    expect(computeSchemaFingerprint([changed])).not.toBe(
      computeSchemaFingerprint([original]),
    );
  });

  it('uses SHA-256 hex of canonical JSON, not a schema version or engine string', () => {
    expect(computeSchemaFingerprint([])).toBe(
      createHash('sha256').update('[]').digest('hex'),
    );
  });

  it('uses a stable placeholder for classes registered without a package', () => {
    ObjectRegistry.registerFromManifest(
      'LocalOnly',
      declaration('LocalOnly', '', { name: { type: 'text' } }),
    );
    expect(collectMigrateRecordInput().packages).toEqual(['<unqualified>']);
  });
});
