import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { getDDLStrategy } from '../../schema/ddl/index.js';
import { renderNullEqualConflictIndex } from '../../schema/ddl/null-equal-index.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { MigrationGenerator } from '../generator.js';
import {
  collectNullEqualIndexTargets,
  migrateNullEqualIndexes,
  preflightNullEqualIndexes,
} from '../null-equal-indexes.js';
import { MigrationTracker, planPostgresStatements } from '../tracker.js';

const nullEqualSchema: SchemaDefinition = {
  tableName: 'null_equal_identity',
  columns: {
    id: { type: 'UUID', primaryKey: true },
    tenant_id: { type: 'UUID', referenceKind: 'tenantId' },
    slug: { type: 'TEXT', notNull: true },
    optional_code: { type: 'TEXT' },
  },
  indexes: [
    {
      name: 'null_equal_identity_slug_idx',
      columns: ['tenant_id', 'slug'],
      unique: true,
      nullsNotDistinct: true,
    },
    {
      name: 'optional_business_code',
      columns: ['optional_code'],
      unique: true,
    },
  ],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '1.0.0',
};

function driver(version = 170000, lockedDuplicates = 0) {
  const queries: string[] = [];
  let locked = false;
  const db = {
    url: 'postgres://localhost/example',
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith('SHOW'))
        return { rows: [{ server_version_num: String(version) }] };
      if (sql.startsWith('LOCK TABLE')) locked = true;
      if (sql.includes('FROM pg_class t'))
        return {
          rows: [
            {
              indisunique: true,
              indisvalid: true,
              indisready: true,
              indnullsnotdistinct: false,
              full_index: true,
              plain_columns: true,
              no_includes: true,
              amname: 'btree',
              columns: ['tenant_id', 'slug'],
              constraint_owned: false,
              depended_on: false,
              managed_dependency: false,
              default_order: true,
              default_ops: true,
              default_collation: true,
              default_storage: true,
              relkind: 'r',
            },
          ],
        };
      if (sql.startsWith('SELECT COUNT'))
        return { rows: [{ groups: locked ? lockedDuplicates : 0 }] };
      return { rows: [] };
    },
    transaction: async (
      callback: (tx: DatabaseInterface) => Promise<unknown>,
    ) => callback(db as unknown as DatabaseInterface),
  };
  return { db: db as unknown as DatabaseInterface, queries };
}

describe('framework NULL-equal index migration (#2834)', () => {
  it('selects explicit framework identity only; business UNIQUE remains unchanged', () => {
    expect(collectNullEqualIndexTargets({ model: nullEqualSchema })).toEqual([
      {
        table: nullEqualSchema.tableName,
        index: 'null_equal_identity_slug_idx',
        columns: ['tenant_id', 'slug'],
      },
    ]);
    const postgres =
      getDDLStrategy('postgres').generateIndexes(nullEqualSchema);
    expect(postgres[0]).toContain('NULLS NOT DISTINCT');
    expect(postgres[0]).toContain('>= 150000');
    expect(postgres[1]).not.toContain('NULLS NOT DISTINCT');
    for (const engine of ['sqlite', 'duckdb'] as const) {
      expect(
        getDDLStrategy(engine).generateIndexes(nullEqualSchema).join('\n'),
      ).not.toContain('NULLS NOT DISTINCT');
    }
  });

  it.each([
    'sqlite',
    'duckdb',
  ] as const)('preserves nullable upsert and business UNIQUE behavior on %s', async (engine) => {
    const db = await getDatabase({
      type: engine,
      url: ':memory:',
      dbid: randomUUID(),
    });
    try {
      const ddl = getDDLStrategy(engine);
      await db.query(ddl.generateCreateTable(nullEqualSchema));
      for (const sql of ddl.generateIndexes(nullEqualSchema))
        await db.query(sql);
      const key = ['tenant_id', 'slug'];
      for (const tenant of [null, randomUUID(), randomUUID()]) {
        for (let i = 0; i < 2; i++)
          await db.upsert(nullEqualSchema.tableName, key, {
            id: randomUUID(),
            tenant_id: tenant,
            slug: 'shared',
            optional_code: null,
          });
      }
      const result = await db.query(
        `SELECT COUNT(*) AS count FROM "${nullEqualSchema.tableName}"`,
      );
      expect(Number(result.rows[0].count)).toBe(3);
      expect(
        (
          await migrateNullEqualIndexes(
            db,
            collectNullEqualIndexTargets({ model: nullEqualSchema }),
            { engineHint: engine },
          )
        ).statements,
      ).toEqual([]);
    } finally {
      await db.close?.();
    }
  });

  it('rejects malformed or business-expression markers before probing a database', () => {
    for (const patch of [
      { unique: false },
      { where: 'tenant_id IS NOT NULL' },
      { columns: ['missing'] },
      { columns: [] },
      { jsonPath: { column: 'optional_code', path: '$.value' } },
    ]) {
      const invalid = {
        ...nullEqualSchema,
        indexes: [{ ...nullEqualSchema.indexes[0], ...patch }],
      };
      expect(() => collectNullEqualIndexTargets({ model: invalid })).toThrow(
        'Invalid framework',
      );
    }
    expect(
      collectNullEqualIndexTargets({
        model: {
          ...nullEqualSchema,
          indexes: [
            { name: 'business', columns: ['optional_code'], unique: true },
          ],
        },
      }),
    ).toEqual([]);
  });

  it('keeps version-gated DDL intact and rejects concurrent planning before work', () => {
    const sql = getDDLStrategy('postgres').generateIndexes(nullEqualSchema)[0];
    expect(planPostgresStatements([sql], false)).toEqual({
      regular: [sql],
      concurrent: [],
    });
    expect(() => planPostgresStatements([sql], true)).toThrow(
      'retry without --postgres-safe',
    );
  });

  it('rejects conditional DDL before opening the tracker transaction or writing history', async () => {
    const db = {
      url: 'postgres://localhost/example',
      query: async () => {
        throw new Error('query must not run');
      },
      transaction: async () => {
        throw new Error('transaction must not run');
      },
    } as unknown as DatabaseInterface;
    const tracker = new MigrationTracker({ db });
    await expect(
      tracker.applyAll(
        [
          {
            id: 'null_identity',
            description: 'identity',
            version: '1.0.0',
            up: [
              getDDLStrategy('postgres').generateIndexes(nullEqualSchema)[0],
            ],
            down: [],
          },
        ],
        { atomic: true, postgresSafe: true },
      ),
    ).rejects.toThrow('--postgres-safe');
  });

  it('preserves the marker when generating an index addition without pre-rendered SQL', () => {
    const migration = new MigrationGenerator({
      engine: 'postgres',
    }).generateFromDiff(
      {
        has_changes: true,
        added_tables: [],
        dropped_tables: [],
        changes: [
          {
            type: 'add_index',
            table: nullEqualSchema.tableName,
            name: nullEqualSchema.indexes[0].name,
            index: nullEqualSchema.indexes[0],
          },
        ],
      },
      { name: 'null_identity', description: 'framework identity' },
    );
    expect(migration.up[0]).toContain('NULLS NOT DISTINCT');
    expect(migration.up[0]).not.toContain('CONCURRENTLY');
    expect(() => planPostgresStatements(migration.up, true)).toThrow(
      '--postgres-safe',
    );
  });

  it('quotes identifiers/literals and chooses a noncolliding dollar delimiter', () => {
    const sql = renderNullEqualConflictIndex("t'$smrt_null_equal$", {
      name: 'i"x',
      columns: ['c"x'],
      unique: true,
      nullsNotDistinct: true,
    });
    expect(sql).toContain('DO $smrt_null_equal_1$');
    expect(sql).toContain('"i""x"');
    expect(sql).toContain("t''$smrt_null_equal$");
  });

  it('never queries the unavailable catalog field on PostgreSQL 14', async () => {
    const { db, queries } = driver(140000);
    expect(
      (
        await migrateNullEqualIndexes(
          db,
          collectNullEqualIndexTargets({ model: nullEqualSchema }),
        )
      ).preflight.supported,
    ).toBe(false);
    expect(queries).toEqual(['SHOW server_version_num']);
  });

  it('rechecks duplicates under locks and refuses all DDL when rows changed after preflight', async () => {
    const { db, queries } = driver(170000, 1);
    const targets = collectNullEqualIndexTargets({ model: nullEqualSchema });
    expect(
      (await preflightNullEqualIndexes(db, targets)).indexes[0].state,
    ).toBe('pending');
    await expect(migrateNullEqualIndexes(db, targets)).rejects.toThrow(
      'duplicate NULL-equal',
    );
    expect(queries.some((sql) => sql.startsWith('LOCK TABLE'))).toBe(true);
    expect(queries.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
  });
});
