import { readFileSync } from 'node:fs';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
} from '../../schema/types.js';
import {
  planUuidConvergence,
  type UuidConvergenceInput,
} from '../../schema/uuid-convergence.js';
import {
  classifySchemaChange,
  decideSchemaChange,
  hasExecutableSchemaSql,
  SCHEMA_CHANGE_KINDS,
  type SchemaChangeKind,
  type SchemaChangeKindId,
  UNRESOLVED_NON_DATA_STOPS,
  validateChangeKindTable,
} from '../change-kinds.js';
import {
  hasActionableChanges,
  isManualOrAdvisoryChange,
  SchemaComparer,
} from '../differ.js';
import { collectUnactionableChanges } from '../orchestrate.js';

const schema = (columns: SchemaDefinition['columns']): SchemaDefinition => ({
  tableName: 'items',
  columns: { id: { type: 'TEXT', primaryKey: true }, ...columns },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '4925',
});
const asDiff = (changes: SchemaChange[]): SchemaDiff => ({
  added_tables: [],
  dropped_tables: [],
  changes,
  has_changes: true,
});

// Copy the emitted shapes, including producer hints where SQL alone is ambiguous.
const postgresShapes: Array<[SchemaChangeKindId, SchemaChange]> = [
  [
    'type.uuid-constraints-unavailable',
    {
      type: 'type_upgrade',
      kindHint: 'type.uuid-constraints-unavailable',
      table: 'items',
      name: 'id',
      phase: 'pre_foreign_key',
      advisory: {
        severity: 'warning',
        message: 'Live foreign keys depend on the conversion targets.',
      },
    },
  ],
  [
    'type.uuid-probe-unavailable',
    {
      type: 'type_upgrade',
      kindHint: 'type.uuid-probe-unavailable',
      table: 'items',
      name: 'id',
      phase: 'pre_foreign_key',
      advisory: {
        severity: 'warning',
        message: 'The UUID shape probe could not run.',
      },
    },
  ],
  [
    'column.required-nulls',
    {
      type: 'alter_column',
      table: 'items',
      name: 'value',
      alteration: 'set_not_null',
      mismatch: { expected: 'NOT NULL', actual: 'NULL' },
      sql: '-- live rows hold NULL',
      advisory: { severity: 'warning', message: 'No default to backfill.' },
    },
  ],
  [
    'column.set-not-null',
    {
      type: 'alter_column',
      table: 'items',
      name: 'value',
      alteration: 'set_not_null',
      sql: 'ALTER TABLE items ALTER COLUMN value SET NOT NULL',
    },
  ],
  [
    'type.narrow-float',
    {
      type: 'type_upgrade',
      kindHint: 'type.narrow-float',
      table: 'items',
      name: 'value',
      column: { type: 'REAL' },
      mismatch: { expected: 'REAL', actual: 'double precision' },
      advisory: { severity: 'warning', message: 'Narrowing loses precision.' },
    },
  ],
  [
    'type.invalid-json',
    {
      type: 'type_upgrade',
      kindHint: 'type.invalid-json',
      table: 'items',
      name: 'value',
      column: { type: 'JSON' },
      mismatch: { expected: 'JSON', actual: 'text' },
      advisory: {
        severity: 'warning',
        message: 'Live values are not valid JSON.',
      },
    },
  ],
  [
    'type.invalid-timestamp',
    {
      type: 'type_upgrade',
      kindHint: 'type.invalid-timestamp',
      table: 'items',
      name: 'value',
      column: { type: 'TIMESTAMP' },
      mismatch: { expected: 'TIMESTAMP', actual: 'text' },
      advisory: {
        severity: 'warning',
        message: 'Live values do not parse as an unambiguous timestamp.',
      },
    },
  ],
  [
    'type.uuid-blocked',
    {
      type: 'type_upgrade',
      table: 'items',
      name: 'id',
      column: { type: 'UUID' },
      phase: 'pre_foreign_key',
      mismatch: { expected: 'UUID', actual: 'mixed uuid/text' },
      advisory: { severity: 'warning', message: 'Incompatible column types.' },
    },
  ],
  [
    'foreign-key.orphans',
    {
      type: 'add_foreign_key',
      table: 'items',
      name: 'items_parent_fk',
      foreignKey: {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
      orphanBlocked: true,
      orphanNullable: true,
      advisory: {
        severity: 'warning',
        message: 'Existing rows do not match parents.id.',
      },
    },
  ],
  [
    'foreign-key.incompatible-types',
    {
      type: 'add_foreign_key',
      kindHint: 'foreign-key.incompatible-types',
      table: 'items',
      name: 'items_parent_fk',
      foreignKey: {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
      advisory: { severity: 'warning', message: 'Incompatible column types.' },
    },
  ],
  [
    'foreign-key.parent-data-missing',
    {
      type: 'add_foreign_key',
      kindHint: 'foreign-key.parent-data-missing',
      table: 'items',
      name: 'items_parent_fk',
      foreignKey: {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
      advisory: {
        severity: 'warning',
        message:
          'Child table is not empty and planned parent does not exist yet.',
      },
    },
  ],
  [
    'foreign-key.drop-unavailable',
    {
      type: 'drop_foreign_key',
      table: 'items',
      name: 'items_parent_fk',
      foreignKey: {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
      advisory: {
        severity: 'warning',
        message: 'Live constraint name is unavailable.',
      },
    },
  ],
  [
    'type.default-relaxation-report',
    {
      type: 'type_upgrade',
      kindHint: 'type.default-relaxation-report',
      table: 'items',
      name: 'value',
      advisory: {
        severity: 'warning',
        message: 'Live default needs relaxColumns.',
      },
    },
  ],
  [
    'type.preservation-unverified',
    {
      type: 'type_upgrade',
      kindHint: 'type.preservation-unverified',
      table: 'items',
      name: 'value',
      advisory: {
        severity: 'warning',
        message: 'Preservation probe did not finish.',
      },
    },
  ],
  // #4932 shapes: the shared-table CHECK changes the differ emits.
  [
    'check.add',
    {
      type: 'alter_column',
      table: 'items',
      name: 'title',
      alteration: 'set_check',
      mismatch: { expected: 'CHECK (x)', actual: '(none)' },
      sqlStatements: ['ALTER TABLE items ADD CONSTRAINT smrt_ck_x CHECK (x)'],
    },
  ],
  [
    'check.violated',
    {
      type: 'alter_column',
      table: 'items',
      name: 'title',
      alteration: 'set_check',
      mismatch: { expected: 'CHECK (x)', actual: '(none)' },
      sql: '-- items.title is required for some classes but live rows hold NULL',
      advisory: { severity: 'warning', message: 'Live rows break the rule.' },
    },
  ],
  [
    'check.drop',
    {
      type: 'alter_column',
      table: 'items',
      name: 'smrt_ck_x',
      alteration: 'drop_check',
      mismatch: { expected: '(not declared)', actual: 'smrt_ck_x' },
      sqlStatements: ['ALTER TABLE items DROP CONSTRAINT IF EXISTS smrt_ck_x'],
    },
  ],
];

describe('schema change policy coverage (#4925)', () => {
  it('covers exactly the SchemaChange union and every differ type literal', () => {
    const differ = readFileSync(
      new URL('../differ.ts', import.meta.url),
      'utf8',
    );
    const types = readFileSync(
      new URL('../../schema/types.ts', import.meta.url),
      'utf8',
    );
    const union = types.slice(
      types.indexOf('export interface SchemaChange {'),
      types.indexOf('  /** Affected table name */'),
    );
    const declared = new Set(
      [...union.matchAll(/\| '([^']+)'/g)].map((m) => m[1]),
    );
    // `type: 'UUID'` also occurs in a fallback column definition; it is
    // not a SchemaChange. Exclude only the declared SQLDataType literals.
    const sqlTypeSource = types.slice(
      types.indexOf('export type SQLDataType ='),
      types.indexOf('export interface ColumnDefinition'),
    );
    const sqlTypes = new Set(
      [...sqlTypeSource.matchAll(/\| '([^']+)'/g)].map((match) => match[1]),
    );
    const produced = new Set(
      [...differ.matchAll(/\btype:\s*'([^']+)'/g)]
        .map((match) => match[1])
        .filter((type) => !sqlTypes.has(type)),
    );
    const covered = new Set(
      Object.values(SCHEMA_CHANGE_KINDS).map((entry) => entry.type),
    );
    expect([...covered].sort()).toEqual([...declared].sort());
    expect(
      [...produced].filter(
        (type) => !covered.has(type as SchemaChange['type']),
      ),
    ).toEqual([]);
    expect(produced.size).toBeGreaterThan(10);
    const rebuild = readFileSync(
      new URL('../sqlite-rebuild.ts', import.meta.url),
      'utf8',
    );
    const hints = [
      ...`${differ}\n${rebuild}`.matchAll(
        /'(column\.[a-z.-]+|type\.[a-z.-]+|foreign-key\.[a-z.-]+)'/g,
      ),
    ].map((match) => match[1]);
    expect(hints.length).toBeGreaterThan(10);
    expect(hints.filter((hint) => !(hint in SCHEMA_CHANGE_KINDS))).toEqual([]);
  });

  it('differs by engine only for the shared-table CHECK kinds (#4937)', () => {
    // Every other kind applies, reports or stops the same way on all three
    // engines. The CHECK is PostgreSQL only: the rule stays in smrt's
    // save-time check on SQLite and DuckDB (#4932).
    const differing = Object.entries(SCHEMA_CHANGE_KINDS)
      .filter(
        ([, entry]) =>
          new Set(Object.values(entry.engines).map((policy) => policy.decision))
            .size > 1,
      )
      .map(([kind]) => kind)
      .sort();
    expect(differing).toEqual(['check.add', 'check.drop', 'check.violated']);
  });

  it('validates every engine policy and rejects a synthetic non-data stop', () => {
    expect(validateChangeKindTable(SCHEMA_CHANGE_KINDS)).toEqual([]);
    const bad: SchemaChangeKind = {
      type: 'add_column',
      engines: {
        postgres: { decision: 'stop', why: 'Needs approval.' },
        sqlite: { decision: 'stop', why: '' },
        duckdb: {
          decision: 'stop',
          why: 'Unsupported.',
          exception: 'An unrecorded exception.',
        },
      },
    };
    expect(validateChangeKindTable({ invalid: bad })).toHaveLength(4);
    expect(UNRESOLVED_NON_DATA_STOPS.length).toBeGreaterThan(0);
    for (const exception of UNRESOLVED_NON_DATA_STOPS)
      expect(exception.reason.trim()).not.toBe('');
  });

  it.each(
    postgresShapes,
  )('classifies the PostgreSQL %s producer shape', (kind, change) => {
    expect(classifySchemaChange(change)).toBe(kind);
    const verdict = decideSchemaChange(change, 'postgres');
    expect(verdict.message).toContain(
      `${change.table}.${change.foreignKey?.column ?? change.name}`,
    );
    if (verdict.stop?.reason === 'loses-data')
      expect(verdict.message).toContain('would lose data');
    if (verdict.stop?.reason === 'invents-data')
      expect(verdict.message).toContain('would invent data');
  });

  it('keeps UUID planner failures distinct from incompatible stored values', async () => {
    const input: UuidConvergenceInput = {
      manifestSchemas: {
        items: schema({ id: { type: 'UUID' }, parent_id: { type: 'UUID' } }),
      },
      relationships: [
        {
          childTable: 'items',
          childColumn: 'parent_id',
          parentTable: 'items',
          parentColumn: 'id',
        },
      ],
      getLiveColumn: (_table, column) => ({
        normalizedType: column === 'id' ? 'TEXT' : 'UUID',
        rawType: column === 'id' ? 'text' : 'uuid',
        exists: true,
        hasDefault: false,
      }),
      liveForeignKeys: [],
      probeUuidShape: async () => ({
        status: 'unavailable',
        reason: 'probe failed',
      }),
    };
    expect((await planUuidConvergence(input)).blocks[0]?.cause).toBe(
      'probe-unavailable',
    );
    expect(
      (
        await planUuidConvergence({
          ...input,
          probeUuidShape: async () => ({ status: 'dirty', count: 1 }),
        })
      ).blocks[0]?.cause,
    ).toBe('invalid-values');
    expect(
      (
        await planUuidConvergence({
          ...input,
          liveForeignKeys: [
            {
              table: 'legacy',
              column: 'item_id',
              referencesTable: 'items',
              referencesColumn: 'id',
            },
          ],
        })
      ).blocks[0]?.cause,
    ).toBe('live-constraints');
  });

  it('refuses unknown types and alterations and never executes comment-only SQL', () => {
    for (const change of [
      {
        type: 'future_change',
        table: 'items',
        name: 'value',
      } as unknown as SchemaChange,
      {
        type: 'alter_column',
        table: 'items',
        name: 'value',
        alteration: 'future_alteration',
        sql: 'ALTER TABLE items ...',
      } as unknown as SchemaChange,
    ]) {
      expect(decideSchemaChange(change, 'sqlite')).toMatchObject({
        kind: 'unlisted',
        decision: 'stop',
        stop: { reason: 'unlisted' },
      });
    }
    expect(
      hasExecutableSchemaSql({ sql: '/* advisory */\n-- no change needed' }),
    ).toBe(false);
    expect(
      classifySchemaChange({
        type: 'type_upgrade',
        table: 'items',
        sql: '/* no change needed */',
      }),
    ).toBe('type.noop');
    expect(
      hasExecutableSchemaSql({
        sql: '-- note\nALTER TABLE items ADD COLUMN label TEXT',
      }),
    ).toBe(true);
    expect(
      hasExecutableSchemaSql({
        sql: '-- placeholder',
        sqlStatements: ['ALTER TABLE items ADD COLUMN label TEXT'],
      }),
    ).toBe(true);
  });

  it('the differ, orchestrator, and CLI agree on exactly the same stop set', async () => {
    const { partitionSchemaChanges } = await import(
      '../../../../cli/src/commands/db-migrate-actions.js'
    );
    const allChanges: SchemaChange[] = [
      ...postgresShapes.map(([, change]) => change),
      {
        type: 'orphan_column',
        table: 'items',
        name: 'legacy',
        advisory: {
          severity: 'warning',
          message: 'NOT NULL orphan can break inserts.',
        },
      },
      {
        type: 'add_column',
        table: 'items',
        name: 'label',
        column: { type: 'TEXT' },
        sql: 'ALTER TABLE items ADD COLUMN label TEXT',
      },
      {
        type: 'type_upgrade',
        table: 'items',
        name: 'covered',
        sql: '-- rebuilt with sibling (no change needed)',
      },
    ];
    for (const engine of ['postgres', 'sqlite', 'duckdb'] as const) {
      // Only PostgreSQL carries the shared-table CHECK changes (#4932).
      const changes = allChanges.filter(
        (change) =>
          engine === 'postgres' ||
          (change.alteration !== 'set_check' &&
            change.alteration !== 'drop_check'),
      );
      const expected = changes.filter(
        (change) => decideSchemaChange(change, engine).decision === 'stop',
      );
      const actual = partitionSchemaChanges(changes, (table) => table, engine);
      expect(
        actual.manualInterventions.map((change) => change.decisionMessage),
      ).toEqual(
        expected.map((change) => decideSchemaChange(change, engine).message),
      );
      expect(collectUnactionableChanges(asDiff(changes), engine)).toEqual(
        expected,
      );
      expect(
        changes.filter((change) => !isManualOrAdvisoryChange(change)),
      ).toEqual(
        changes.filter(
          (change) =>
            decideSchemaChange(change, engine).decision === 'apply' &&
            hasExecutableSchemaSql(change),
        ),
      );
      expect(hasActionableChanges(asDiff(changes))).toBe(true);
      expect(actual.advisories.map((change) => change.name)).toEqual([
        'value',
        'legacy',
        'covered',
      ]);
    }
  });
});

describe.each([
  'sqlite',
  'duckdb',
] as const)('real %s comparer output', (engine) => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  beforeEach(async () => {
    db = await getDatabase({ type: engine, url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });
  async function diff(current: SchemaDefinition, options = {}) {
    const result = await new SchemaComparer(db, {
      engineHint: engine,
      ...options,
    }).compare({ items: current });
    for (const change of result.changes)
      expect(classifySchemaChange(change), JSON.stringify(change)).not.toBe(
        'unlisted',
      );
    return result;
  }

  it('reports orphan columns, NOT NULL orphans, unique indexes, stale defaults and unrequested relaxations', async () => {
    await db.query(
      "CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT DEFAULT 'old', relaxed TEXT NOT NULL, legacy TEXT, legacy_required TEXT NOT NULL, email TEXT UNIQUE)",
    );
    await db.query('CREATE INDEX legacy_idx ON items (legacy)');
    await db.query('CREATE UNIQUE INDEX items_email_key ON items (email)');
    const result = await diff(
      schema({
        value: { type: 'TEXT' },
        relaxed: { type: 'TEXT' },
        email: { type: 'TEXT' },
      }),
    );
    const kinds = result.changes.map(classifySchemaChange);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'column.orphan',
        'column.orphan-not-null',
        'index.orphan',
        'column.relaxation-report',
      ]),
    );
    expect(collectUnactionableChanges(result, engine)).toEqual([]);
  });

  it('stops when a required new column has no usable value, and safely adds an optional column', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY)');
    await db.query("INSERT INTO items (id) VALUES ('one')");
    const result = await diff(
      schema({
        required: { type: 'TEXT', notNull: true },
        optional: { type: 'TEXT' },
      }),
    );
    expect(result.changes.map(classifySchemaChange)).toEqual(
      expect.arrayContaining(['column.required-missing', 'column.add']),
    );
    expect(
      collectUnactionableChanges(result, engine).map((change) => change.name),
    ).toEqual(['required']);
  });

  it('stops at live NULLs with no default or backfill', async () => {
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT)');
    await db.query("INSERT INTO items (id, value) VALUES ('one', NULL)");
    const result = await diff(
      schema({ value: { type: 'TEXT', notNull: true } }),
    );
    expect(result.changes.map(classifySchemaChange)).toContain(
      'column.required-nulls',
    );
    expect(decideSchemaChange(result.changes[0], engine).stop?.reason).toBe(
      'invents-data',
    );
  });

  it('classifies incompatible types and executable type widening', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, value INTEGER, incompatible BOOLEAN)',
    );
    const result = await diff(
      schema({ value: { type: 'REAL' }, incompatible: { type: 'BLOB' } }),
    );
    expect(result.changes.map(classifySchemaChange)).toContain('type.convert');
    expect(result.changes.map(classifySchemaChange)).toContain(
      'type.incompatible',
    );
  });

  it('applies a foreign key on an existing column by rebuilding the table (#4937)', async () => {
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT)');
    const current = schema({ parent_id: { type: 'TEXT' } });
    current.foreignKeys = [
      {
        column: 'parent_id',
        referencesTable: 'parents',
        referencesColumn: 'id',
      },
    ];
    const result = await diff(current);
    expect(result.changes.map(classifySchemaChange)).toEqual([
      'foreign-key.add',
    ]);
    expect(collectUnactionableChanges(result, engine)).toEqual([]);
  });

  it('classifies default changes and constraint tightening on empty tables', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT, required TEXT)',
    );
    const result = await diff(
      schema({
        value: { type: 'TEXT', defaultValue: 'ready' },
        required: { type: 'TEXT', notNull: true },
      }),
    );
    // SQLite carries both in one table rebuild (#4937).
    expect(result.changes.map(classifySchemaChange)).toEqual(
      engine === 'sqlite'
        ? ['column.set-default', 'column.rebuild-covered']
        : ['column.set-default', 'column.set-not-null'],
    );
  });

  it('classifies opted-in NOT NULL relaxation without losing stored values', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    await db.query("INSERT INTO items VALUES ('one', 'retain')");
    const result = await diff(schema({ value: { type: 'TEXT' } }), {
      relaxColumns: true,
    });
    expect(result.changes.map(classifySchemaChange)).toContain(
      'column.drop-not-null',
    );
  });

  if (engine === 'sqlite') {
    it('classifies a sibling rebuild note as report and applies an inbound-FK rebuild (#4937)', async () => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY, a INTEGER, b INTEGER)',
      );
      const current = schema({ a: { type: 'REAL' }, b: { type: 'REAL' } });
      expect((await diff(current)).changes.map(classifySchemaChange)).toEqual([
        'type.convert',
        'type.noop',
      ]);
      await db.query(
        'CREATE TABLE child (item_id TEXT REFERENCES items(id) ON DELETE CASCADE)',
      );
      // The tracker turns foreign keys off around the rebuild, so a table
      // other tables reference no longer stops the run.
      const withChild = await diff(current);
      expect(withChild.changes.map(classifySchemaChange)).toEqual([
        'type.convert',
        'type.noop',
      ]);
      expect(collectUnactionableChanges(withChild, engine)).toEqual([]);
    });

    it('classifies sibling backfill tightening as an already-covered report', async () => {
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY, a TEXT, b TEXT)',
      );
      await db.query("INSERT INTO items VALUES ('one', NULL, NULL)");
      const result = await diff(
        schema({
          a: { type: 'TEXT', notNull: true, backfill: "'a'" },
          b: { type: 'TEXT', notNull: true, backfill: "'b'" },
        }),
      );
      expect(result.changes.map(classifySchemaChange)).toEqual([
        'column.set-not-null',
        'column.rebuild-covered',
      ]);
      expect(collectUnactionableChanges(result, engine)).toEqual([]);
    });

    it('applies a required backfill rebuild with inbound foreign keys (#4937)', async () => {
      await db.query('CREATE TABLE items (id TEXT PRIMARY KEY)');
      await db.query("INSERT INTO items VALUES ('one')");
      await db.query(
        'CREATE TABLE child (item_id TEXT REFERENCES items(id) ON DELETE CASCADE)',
      );
      const result = await diff(
        schema({
          required: { type: 'TEXT', notNull: true, backfill: "'row:' || id" },
        }),
      );
      expect(result.changes.map(classifySchemaChange)).toEqual(['column.add']);
    });

    it('replaces a conflicting foreign key and drops a disabled one by rebuilding (#4937)', async () => {
      await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE items (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id) ON DELETE CASCADE)',
      );
      const current = schema({ parent_id: { type: 'TEXT' } });
      current.foreignKeys = [
        {
          column: 'parent_id',
          referencesTable: 'parents',
          referencesColumn: 'id',
          onDelete: 'NO ACTION',
        },
      ];
      expect((await diff(current)).changes.map(classifySchemaChange)).toEqual([
        'foreign-key.add',
      ]);
      current.foreignKeys[0].engines = ['postgres'];
      expect((await diff(current)).changes.map(classifySchemaChange)).toEqual([
        'foreign-key.drop',
      ]);
    });
  }

  it('reports a possible rename while retaining both columns', async () => {
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT, old_value TEXT)',
    );
    await db.query(
      "INSERT INTO items (id, value, old_value) VALUES ('one', NULL, 'retain')",
    );
    const result = await diff(schema({ value: { type: 'TEXT' } }));
    expect(result.changes.map(classifySchemaChange)).toEqual(
      engine === 'sqlite'
        ? expect.arrayContaining(['rename.pending'])
        : ['column.orphan'],
    );
    expect(collectUnactionableChanges(result, engine)).toEqual([]);
  });
});
