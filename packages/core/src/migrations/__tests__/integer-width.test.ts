import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import {
  buildIntegerWidthStatements,
  buildIntegerWidthTableStatements,
  collectIntegerWidthTargets,
  preflightIntegerWidthWidening,
  widenIntegerColumnsToBigInt,
} from '../integer-width.js';

function driverDb(input: {
  engine: 'postgres' | 'duckdb';
  types: Record<string, Record<string, string>>;
  counts?: Record<string, string | bigint | number>;
  applied?: boolean;
}) {
  const queries: string[] = [];
  let db: DatabaseInterface;
  db = {
    url:
      input.engine === 'postgres'
        ? 'postgres://localhost/test'
        : 'duckdb://memory',
    query: async (sql: string, ...params: unknown[]) => {
      queries.push(sql);
      if (sql.includes('information_schema.columns') && params.length > 0) {
        const table = String(params[0]);
        return {
          rows: Object.entries(input.types[table] ?? {}).map(
            ([column_name, data_type]) => ({ column_name, data_type }),
          ),
        };
      }
      if (sql.startsWith('SELECT COUNT(*) AS row_count')) {
        const match = sql.match(/FROM "([A-Za-z_][A-Za-z0-9_]*)"/);
        return {
          rows: [{ row_count: input.counts?.[match?.[1] ?? ''] ?? 0 }],
        };
      }
      if (sql.includes('SELECT 1 FROM _smrt_backfills')) {
        return { rows: input.applied ? [{ exists: 1 }] : [] };
      }
      return { rows: [] };
    },
    transaction: async <T>(
      callback: (transactionDb: DatabaseInterface) => Promise<T>,
    ) => callback(db),
  } as unknown as DatabaseInterface;
  return { db, queries };
}

describe('integer-width widening (#2424)', () => {
  it('collects application and hand-DDL system integer targets', () => {
    const targets = collectIntegerWidthTargets({
      invoices: {
        tableName: 'invoices',
        columns: {
          amount: { type: 'INTEGER' },
          rate: { type: 'REAL' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    expect(targets).toContainEqual({ table: 'invoices', columns: ['amount'] });
    expect(
      targets.find((target) => target.table === '_smrt_dispatch'),
    ).toMatchObject({
      columns: expect.arrayContaining(['attempts']),
    });
  });

  it('reports PostgreSQL int4 columns and table row counts without writing', async () => {
    const { db, queries } = driverDb({
      engine: 'postgres',
      types: {
        invoices: { amount: 'integer', attempts: 'bigint', drift: 'text' },
        absent: {},
      },
      counts: { invoices: '42' },
    });

    const result = await preflightIntegerWidthWidening(
      db,
      [
        { table: 'invoices', columns: ['amount', 'attempts', 'drift'] },
        { table: 'absent', columns: ['amount'] },
      ],
      { engineHint: 'postgres' },
    );

    expect(result).toMatchObject({
      supported: true,
      pendingColumns: 1,
      currentColumns: 1,
      missingColumns: 1,
      unexpectedColumns: 1,
      pendingTables: 1,
    });
    expect(
      result.tables.find((table) => table.table === 'invoices'),
    ).toMatchObject({
      rowCount: 42,
      columns: expect.arrayContaining([
        expect.objectContaining({ column: 'amount', state: 'pending' }),
        expect.objectContaining({ column: 'attempts', state: 'current' }),
        expect.objectContaining({ column: 'drift', state: 'unexpected' }),
      ]),
    });
    expect(result.summary).toContain('invoices: 42 row(s); amount (integer)');
    expect(queries.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('hydrates DuckDB bigint row counts and emits lossless ALTER statements', async () => {
    const { db } = driverDb({
      engine: 'duckdb',
      types: { invoices: { amount: 'INTEGER' } },
      counts: { invoices: 7n },
    });

    const result = await preflightIntegerWidthWidening(
      db,
      [{ table: 'invoices', columns: ['amount'] }],
      { engineHint: 'duckdb' },
    );

    expect(result.tables[0].rowCount).toBe(7);
    expect(buildIntegerWidthStatements('duckdb', 'invoices', 'amount')).toEqual(
      ['ALTER TABLE "invoices" ALTER COLUMN "amount" TYPE BIGINT'],
    );
  });

  it('groups PostgreSQL columns into one table rewrite', () => {
    expect(
      buildIntegerWidthTableStatements('postgres', 'invoices', [
        'amount',
        'attempts',
      ]),
    ).toEqual([
      'ALTER TABLE "invoices" ALTER COLUMN "amount" TYPE BIGINT, ALTER COLUMN "attempts" TYPE BIGINT',
    ]);
  });

  it('executes the full widening and marker path on real DuckDB', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    try {
      await db.query('CREATE TABLE invoices (amount INTEGER)');
      await db.query('INSERT INTO invoices (amount) VALUES (1), (2)');

      const result = await widenIntegerColumnsToBigInt(
        db,
        [{ table: 'invoices', columns: ['amount'] }],
        { engineHint: 'duckdb', backfillName: 'test:integer-width:duckdb:v1' },
      );

      expect(result).toMatchObject({
        ran: true,
        widenedColumns: [{ table: 'invoices', column: 'amount' }],
      });
      expect(result.preflight.tables[0]?.rowCount).toBe(2);
      const columns = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'invoices' AND column_name = 'amount'`,
      );
      expect(String(columns.rows[0]?.data_type).toUpperCase()).toBe('BIGINT');
    } finally {
      await db.close?.();
    }
  });

  it('widens each pending column once and records the idempotency marker', async () => {
    const { db, queries } = driverDb({
      engine: 'postgres',
      types: { invoices: { amount: 'int4' } },
      counts: { invoices: 2 },
    });

    const result = await widenIntegerColumnsToBigInt(
      db,
      [{ table: 'invoices', columns: ['amount'] }],
      {
        engineHint: 'postgres',
        backfillName: 'test:integer-width:v1',
      },
    );

    expect(result.ran).toBe(true);
    expect(result.widenedColumns).toEqual([
      { table: 'invoices', column: 'amount' },
    ]);
    expect(queries).toContain(
      'ALTER TABLE "invoices" ALTER COLUMN "amount" TYPE BIGINT',
    );
    expect(queries).toContain(`SET LOCAL lock_timeout = '30000ms'`);
    expect(queries).toContain(`SET LOCAL statement_timeout = '60000ms'`);
    expect(
      queries.some((sql) => sql.includes('INSERT INTO _smrt_backfills')),
    ).toBe(true);
  });

  it('does not repeat a widening when all columns are already BIGINT', async () => {
    const { db, queries } = driverDb({
      engine: 'postgres',
      types: { invoices: { amount: 'bigint' } },
      applied: true,
    });

    const result = await widenIntegerColumnsToBigInt(
      db,
      [{ table: 'invoices', columns: ['amount'] }],
      { engineHint: 'postgres', backfillName: 'test:integer-width:v1' },
    );

    expect(result.ran).toBe(false);
    expect(result.widenedColumns).toEqual([]);
    expect(queries.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('does not let an earlier marker skip newly discovered pending targets', async () => {
    const { db, queries } = driverDb({
      engine: 'postgres',
      types: { invoices: { amount: 'int4' } },
      counts: { invoices: 2 },
      applied: true,
    });

    await expect(
      widenIntegerColumnsToBigInt(
        db,
        [{ table: 'invoices', columns: ['amount'] }],
        { engineHint: 'postgres', backfillName: 'test:integer-width:v1' },
      ),
    ).resolves.toMatchObject({
      ran: true,
      widenedColumns: [{ table: 'invoices', column: 'amount' }],
    });
    expect(queries).toContain(
      'ALTER TABLE "invoices" ALTER COLUMN "amount" TYPE BIGINT',
    );
  });

  it('refuses to record a marker when ordinary type drift needs repair first', async () => {
    const { db, queries } = driverDb({
      engine: 'postgres',
      types: { invoices: { amount: 'text' } },
    });

    await expect(
      widenIntegerColumnsToBigInt(
        db,
        [{ table: 'invoices', columns: ['amount'] }],
        { engineHint: 'postgres', backfillName: 'test:integer-width:v1' },
      ),
    ).rejects.toThrow('unexpected live types');
    expect(queries.some((sql) => sql.startsWith('ALTER TABLE'))).toBe(false);
  });

  it('is a no-op on SQLite because INTEGER is already 64-bit', async () => {
    const db = {
      url: ':memory:',
      query: async () => ({ rows: [] }),
    } as unknown as DatabaseInterface;

    await expect(
      preflightIntegerWidthWidening(
        db,
        [{ table: 'invoices', columns: ['amount'] }],
        { engineHint: 'sqlite' },
      ),
    ).resolves.toMatchObject({ supported: false, pendingColumns: 0 });
  });
});
