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
import type {
  ColumnDefinition,
  ForeignKeyDefinition,
  IndexDefinition,
  SchemaDefinition,
  TableCheckDefinition,
  TriggerDefinition,
} from '../../schema/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { collectMigrateRecordInput } from '../migrate-record.js';
import {
  computeManifestSchemaFingerprint,
  computeSchemaFingerprint,
  tryComputeManifestSchemaFingerprint,
} from '../schema-fingerprint.js';

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

  it('keeps the stamp of an ordinary column when calculated fields exist (#4915)', () => {
    const plain = schema();
    const marked = structuredClone(plain);
    marked.columns.score.generated = undefined;
    marked.columns.score.generatedInputTypes = { score: 'number' };
    expect(computeSchemaFingerprint([marked])).toBe(
      computeSchemaFingerprint([plain]),
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

describe('a table whose contributors disagree on an index (#4929)', () => {
  const table = (className: string, unique: boolean) => ({
    name: className,
    className,
    packageName: '@scope/pkg',
    schema: {
      tableName: 'shared_rows',
      columns: {
        id: { type: 'UUID', primaryKey: true },
        slug: { type: 'TEXT' },
      },
      indexes: [{ name: 'shared_rows_slug_idx', columns: ['slug'], unique }],
      foreignKeys: [],
      dependencies: [],
    },
  });
  const conflicting = {
    objects: {
      '@scope/pkg:Alpha': table('Alpha', true),
      '@scope/pkg:Beta': table('Beta', false),
    },
  } as unknown as SmartObjectManifest;

  it('names both classes and what each declares', () => {
    expect(() => computeManifestSchemaFingerprint(conflicting)).toThrow(
      /@scope\/pkg:Alpha declares it as unique \(slug\) but @scope\/pkg:Beta declares it as \(slug\)/,
    );
  });

  it('does not fail manifest generation; the fingerprint is left out', () => {
    const warnings: string[] = [];
    expect(
      tryComputeManifestSchemaFingerprint(conflicting, (error) =>
        warnings.push(error.message),
      ),
    ).toBeUndefined();
    expect(warnings).toHaveLength(1);

    const sharedTable = (className: string, tenantScoped: boolean) => ({
      ...declaration(className, '@fixture/shared', {
        code: { type: 'text', default: '' },
      }),
      name: className.toLowerCase(),
      className,
      collection: `${className.toLowerCase()}s`,
      decoratorConfig: {
        tableName: 'shared_rows',
        ...(tenantScoped
          ? { tenantScoped: { mode: 'optional' as const } }
          : {}),
      },
    });
    let manifest: SmartObjectManifest | undefined;
    expect(() => {
      manifest = new ManifestGenerator().generateManifest([
        {
          filePath: '/fixture',
          errors: [],
          objects: [sharedTable('Alpha', false), sharedTable('Beta', true)],
        },
      ]);
    }).not.toThrow();
    expect(manifest?.schemaFingerprint).toBeUndefined();
  });
});

/**
 * Every attribute of the schema definition, listed once. A `Record` over
 * `keyof` makes a new attribute a type error until someone decides whether it
 * is part of the stamp, and the generated test below holds each decision: an
 * attribute marked `stamp` must change the fingerprint, any other must not
 * (and says why). The reasons are written up in the coverage table in
 * `agents/schema-paths.md`.
 */
interface Decision {
  /** True: changing it must change the stamp. */
  stamp: boolean;
  /** For attributes left out of the stamp: why migrate never acts on them. */
  reason?: string;
  change: (s: SchemaDefinition) => void;
}

function richSchema(): SchemaDefinition {
  const base = schema();
  base.indexes.push({
    name: 'entries_json',
    columns: [],
    jsonPath: { column: 'payload', path: '$.a' },
  });
  base.columns.payload = { type: 'JSON' };
  base.foreignKeys = [
    {
      column: 'id',
      referencesTable: 'others',
      referencesColumn: 'id',
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      engines: ['postgres', 'sqlite'],
    },
  ];
  base.checks = [
    {
      name: 'smrt_ck_entries_a1b2c3',
      columns: ['score'],
      expression: '_meta_type NOT IN (\'A\') OR "score" IS NOT NULL',
    },
  ];
  return base;
}

const columnAttributes: Record<keyof ColumnDefinition, Decision> = {
  type: {
    stamp: true,
    change: (s) => {
      s.columns.score.type = 'REAL';
    },
  },
  primaryKey: {
    stamp: true,
    change: (s) => {
      s.columns.id.primaryKey = false;
    },
  },
  notNull: {
    stamp: true,
    change: (s) => {
      s.columns.score.notNull = false;
    },
  },
  unique: {
    stamp: true,
    change: (s) => {
      s.columns.score.unique = true;
    },
  },
  defaultValue: {
    stamp: true,
    change: (s) => {
      s.columns.score.defaultValue = 7;
    },
  },
  check: {
    stamp: true,
    change: (s) => {
      s.columns.score.check = 'score >= 5';
    },
  },
  foreignKey: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = { table: 'x', column: 'id' };
    },
  },
  referenceKind: {
    stamp: false,
    reason:
      'only widens how the differ reads a live UUID/TEXT difference; the declared type and foreign key, which are stamped, decide the shape',
    change: (s) => {
      s.columns.parent_id.referenceKind = 'crossPackageRef';
    },
  },
  backfill: {
    stamp: false,
    reason:
      'a data step for rows already in the table; the column shape it fills (NOT NULL) is stamped',
    change: (s) => {
      s.columns.score.backfill = '99';
    },
  },
  description: {
    stamp: false,
    reason: 'a label',
    change: (s) => {
      s.columns.score.description = 'Other label';
    },
  },
  generated: {
    stamp: true,
    change: (s) => {
      s.columns.doubled.generated = {
        op: 'add',
        left: { col: 'score' },
        right: { value: 2 },
      } as unknown as ColumnDefinition['generated'];
    },
  },
  generatedInputTypes: {
    stamp: true,
    change: (s) => {
      s.columns.doubled.generatedInputTypes = { score: 'text' };
    },
  },
};

const foreignKeyOnColumn: Record<
  keyof NonNullable<ColumnDefinition['foreignKey']>,
  Decision
> = {
  table: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = { table: 'x', column: 'id' };
    },
  },
  column: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = {
        table: 'parents',
        column: 'other',
      };
    },
  },
  onDelete: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = {
        table: 'parents',
        column: 'id',
        onDelete: 'SET NULL',
      };
    },
  },
  onUpdate: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = {
        table: 'parents',
        column: 'id',
        onUpdate: 'CASCADE',
      };
    },
  },
  engines: {
    stamp: true,
    change: (s) => {
      s.columns.parent_id.foreignKey = {
        table: 'parents',
        column: 'id',
        engines: ['sqlite'],
      };
    },
  },
};

const indexAttributes: Record<keyof IndexDefinition, Decision> = {
  name: {
    stamp: true,
    change: (s) => {
      s.indexes[0].name = 'renamed';
    },
  },
  columns: {
    stamp: true,
    change: (s) => {
      s.indexes[0].columns = ['id', 'score'];
    },
  },
  unique: {
    stamp: true,
    change: (s) => {
      s.indexes[0].unique = false;
    },
  },
  nullsNotDistinct: {
    stamp: true,
    change: (s) => {
      s.indexes[0].nullsNotDistinct = true;
    },
  },
  where: {
    stamp: true,
    change: (s) => {
      s.indexes[0].where = 'score > 9';
    },
  },
  jsonPath: {
    stamp: true,
    change: (s) => {
      s.indexes[1].jsonPath = { column: 'payload', path: '$.b' };
    },
  },
  description: {
    stamp: false,
    reason:
      'a label; the one marker value only makes DuckDB refuse an STI conflict index, and the index it marks is stamped',
    change: (s) => {
      s.indexes[0].description = 'Other label';
    },
  },
};

const jsonPathAttributes: Record<
  keyof NonNullable<IndexDefinition['jsonPath']>,
  Decision
> = {
  column: {
    stamp: true,
    change: (s) => {
      s.indexes[1].jsonPath = { column: 'other', path: '$.a' };
    },
  },
  path: {
    stamp: true,
    change: (s) => {
      s.indexes[1].jsonPath = { column: 'payload', path: '$.z' };
    },
  },
};

const foreignKeyAttributes: Record<keyof ForeignKeyDefinition, Decision> = {
  column: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].column = 'score';
    },
  },
  referencesTable: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].referencesTable = 'elsewhere';
    },
  },
  referencesColumn: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].referencesColumn = 'uid';
    },
  },
  onDelete: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].onDelete = 'RESTRICT';
    },
  },
  onUpdate: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].onUpdate = 'RESTRICT';
    },
  },
  engines: {
    stamp: true,
    change: (s) => {
      s.foreignKeys[0].engines = ['duckdb'];
    },
  },
};

const triggerAttributes: Record<keyof TriggerDefinition, Decision> = {
  name: {
    stamp: true,
    change: (s) => {
      s.triggers[0].name = 'renamed';
    },
  },
  when: {
    stamp: true,
    change: (s) => {
      s.triggers[0].when = 'BEFORE';
    },
  },
  event: {
    stamp: true,
    change: (s) => {
      s.triggers[0].event = 'DELETE';
    },
  },
  condition: {
    stamp: true,
    change: (s) => {
      s.triggers[0].condition = 'NEW.score > 1';
    },
  },
  body: {
    stamp: true,
    change: (s) => {
      s.triggers[0].body = 'SELECT 3;';
    },
  },
  description: {
    stamp: false,
    reason: 'a label',
    change: (s) => {
      s.triggers[0].description = 'Other label';
    },
  },
};

const checkAttributes: Record<keyof TableCheckDefinition, Decision> = {
  name: {
    stamp: true,
    change: (s) => {
      (s.checks ?? [])[0].name = 'smrt_ck_entries_zzzzzz';
    },
  },
  expression: {
    stamp: true,
    change: (s) => {
      (s.checks ?? [])[0].expression = '"score" > 0';
    },
  },
  columns: {
    stamp: false,
    reason:
      'says which columns the expression reads (for messages); the expression is stamped',
    change: (s) => {
      (s.checks ?? [])[0].columns = ['score', 'id'];
    },
  },
};

const tableAttributes: Record<keyof SchemaDefinition, Decision> = {
  tableName: {
    stamp: true,
    change: (s) => {
      s.tableName = 'other_entries';
    },
  },
  columns: {
    stamp: true,
    change: (s) => {
      s.columns.extra = { type: 'TEXT' };
    },
  },
  indexes: {
    stamp: true,
    change: (s) => void s.indexes.push({ name: 'extra_idx', columns: ['id'] }),
  },
  foreignKeys: {
    stamp: true,
    change: (s) =>
      void s.foreignKeys.push({
        column: 'score',
        referencesTable: 'z',
        referencesColumn: 'id',
      }),
  },
  triggers: {
    stamp: true,
    change: (s) =>
      void s.triggers.push({
        name: 'extra',
        when: 'AFTER',
        event: 'INSERT',
        body: 'SELECT 9;',
      }),
  },
  checks: {
    stamp: true,
    change: (s) =>
      void (s.checks ?? []).push({
        name: 'smrt_ck_entries_extra',
        columns: ['id'],
        expression: '"id" IS NOT NULL',
      }),
  },
  ddl: {
    stamp: false,
    reason:
      'a non-authoritative preview; only a table with no structured columns is stamped by it',
    change: (s) => {
      s.ddl = 'CREATE TABLE preview (x)';
    },
  },
  version: {
    stamp: false,
    reason: 'a hash of the declarations above, derived from them',
    change: (s) => {
      s.version = 'other';
    },
  },
  dependencies: {
    stamp: false,
    reason: 'derived from the foreign keys, which are stamped',
    change: (s) => void s.dependencies.push('elsewhere'),
  },
  packageName: {
    stamp: false,
    reason: 'which package declared it; tables are stamped, not their owners',
    change: (s) => {
      s.packageName = '@other/pkg';
    },
  },
  baseClass: {
    stamp: false,
    reason: 'a class label; no statement migrate runs reads it',
    change: (s) => {
      s.baseClass = 'SmrtObject';
    },
  },
};

/**
 * A column's own `foreignKey` counts only while the table lists no foreign
 * keys of its own (the differ and DDL read them the same way), so those two
 * tables of attributes start from a schema without the list.
 */
const columnForeignKeyBase = (): SchemaDefinition => {
  const base = richSchema();
  base.foreignKeys = [];
  base.columns.doubled = {
    type: 'INTEGER',
    generated: {
      op: 'mul',
      left: { col: 'score' },
      right: { value: 2 },
    } as unknown as ColumnDefinition['generated'],
    generatedInputTypes: { score: 'number' },
  };
  return base;
};

describe.each([
  ['schema', tableAttributes, richSchema],
  ['column', columnAttributes, columnForeignKeyBase],
  ['column foreign key', foreignKeyOnColumn, columnForeignKeyBase],
  ['index', indexAttributes, richSchema],
  ['index JSON path', jsonPathAttributes, richSchema],
  ['foreign key', foreignKeyAttributes, richSchema],
  ['trigger', triggerAttributes, richSchema],
  ['table check', checkAttributes, richSchema],
] as const)('every %s attribute is decided (#4929, #4932)', (_kind, table, base) => {
  it.each(Object.entries(table))('%s', (_name, decision) => {
    const original = base();
    const changed = structuredClone(original);
    (decision as Decision).change(changed);
    const same =
      computeSchemaFingerprint([changed]) ===
      computeSchemaFingerprint([original]);
    expect(same, (decision as Decision).reason ?? 'must change the stamp').toBe(
      !(decision as Decision).stamp,
    );
  });
});
