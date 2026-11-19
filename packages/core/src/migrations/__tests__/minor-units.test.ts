/**
 * Money major-units → integer minor-units rescale (#2401).
 *
 * Exercised against real in-memory SQLite and DuckDB. The PostgreSQL DDL path
 * is asserted through the emitted statements here and run for real in
 * `minor-units-postgres.optional.test.ts` (and each owning package's
 * `test:postgres`), while the value rescale, the preflight and the idempotency
 * marker are executed for real.
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abortJoinedDuckDbTransaction } from '../../cascade.js';
import {
  buildMinorUnitsStatements,
  MinorUnitsPreflightError,
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '../minor-units.js';

/**
 * `db` with every query whose SQL matches `reject` failing locally, before
 * anything is sent: the shape of an adapter that stops forwarding statements.
 * Transaction scopes opened through it are wrapped the same way.
 */
function rejectingQueries(
  db: DatabaseInterface,
  reject: RegExp,
  failure: string,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'transaction' && typeof value === 'function') {
        return (callback: (scope: DatabaseInterface) => Promise<unknown>) =>
          (value as (cb: unknown) => Promise<unknown>).call(
            target,
            (scope: DatabaseInterface) =>
              callback(rejectingQueries(scope, reject, failure)),
          );
      }
      if (key !== 'query')
        return typeof value === 'function' ? value.bind(target) : value;
      return async (sql: string, ...args: unknown[]) => {
        if (reject.test(String(sql))) throw new Error(failure);
        return (value as DatabaseInterface['query']).call(target, sql, ...args);
      };
    },
  });
}

const TARGETS = [{ table: 'payments', columns: ['amount', 'native_amount'] }];

describe('money minor-units rescale (#2401)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      `CREATE TABLE payments (
         id TEXT PRIMARY KEY NOT NULL,
         amount REAL DEFAULT 0,
         native_amount REAL DEFAULT 0,
         tax_rate REAL DEFAULT 0
       )`,
    );
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      try {
        await db.close();
      } catch {
        // Ignore close errors.
      }
    }
  });

  async function seed(rows: Array<[string, number, number]>): Promise<void> {
    for (const [id, amount, nativeAmount] of rows) {
      await db.query(
        'INSERT INTO payments (id, amount, native_amount) VALUES (?, ?, ?)',
        id,
        amount,
        nativeAmount,
      );
    }
  }

  describe('preflight', () => {
    it('reports floating-point money columns as pending and clears clean data', async () => {
      await seed([
        ['p1', 19.99, 0],
        ['p2', 1.6, 0],
      ]);

      const preflight = await preflightMinorUnitsRescale(db, TARGETS);

      expect(preflight.engine).toBe('sqlite');
      expect(preflight.scale).toBe(100);
      expect(preflight.pendingColumns).toBe(2);
      expect(preflight.convertedColumns).toBe(0);
      expect(preflight.missingColumns).toBe(0);
      expect(preflight.ok).toBe(true);
      // 19.99 * 100 is 1998.9999999999998 in IEEE-754 — the tolerance exists
      // precisely so an ordinary two-decimal price is not reported as lossy.
      expect(preflight.nonIntegralRows).toBe(0);
      expect(preflight.summary).toContain('payments.amount: pending');
    });

    it('lists rows whose scaled value is not a whole number', async () => {
      await seed([
        ['p1', 19.99, 0],
        ['p2', 0.005, 0],
      ]);

      const preflight = await preflightMinorUnitsRescale(db, TARGETS);

      expect(preflight.ok).toBe(false);
      expect(preflight.nonIntegralRows).toBe(1);
      const amountColumn = preflight.columns.find(
        (column) => column.column === 'amount',
      );
      expect(amountColumn?.nonIntegral).toEqual([
        { id: 'p2', value: 0.005, scaled: 0.5 },
      ]);
      expect(preflight.summary).toContain('non-integral id=p2');
    });

    it('lists rows whose scaled value exceeds JavaScript safe-integer range', async () => {
      // PostgreSQL and DuckDB store this as BIGINT, but SMRT exposes integers
      // as JavaScript numbers. Do not create data that hydration would round.
      await seed([['p1', Number.MAX_SAFE_INTEGER / 100 + 1, 0]]);

      const preflight = await preflightMinorUnitsRescale(db, TARGETS);

      expect(preflight.ok).toBe(false);
      expect(preflight.overflowRows).toBe(1);
      expect(preflight.summary).toContain('overflow id=p1');
    });

    it('reports an already-integer column as converted and does not scan it', async () => {
      await db.query('DROP TABLE payments');
      await db.query(
        `CREATE TABLE payments (
           id TEXT PRIMARY KEY NOT NULL,
           amount INTEGER DEFAULT 0,
           native_amount INTEGER DEFAULT 0
         )`,
      );
      await seed([['p1', 1999, 0]]);

      const preflight = await preflightMinorUnitsRescale(db, TARGETS);

      expect(preflight.pendingColumns).toBe(0);
      expect(preflight.convertedColumns).toBe(2);
      expect(preflight.columns[0].inspectedRows).toBe(0);
      expect(preflight.summary).toContain('already integer');
    });

    it('reports an absent table as missing rather than throwing', async () => {
      const preflight = await preflightMinorUnitsRescale(db, [
        { table: 'not_a_table', columns: ['amount'] },
      ]);

      expect(preflight.missingColumns).toBe(1);
      expect(preflight.ok).toBe(true);
      expect(preflight.summary).toContain('not_a_table.amount: missing');
    });

    it('rejects an identifier that is not a plain SQL name', async () => {
      // Rejected up front rather than swallowed by the introspection catch that
      // reports an absent table as `missing`.
      await expect(
        preflightMinorUnitsRescale(db, [
          { table: 'payments', columns: ['amount"; DROP TABLE payments; --'] },
        ]),
      ).rejects.toThrow(/not a plain SQL identifier/);

      await expect(
        preflightMinorUnitsRescale(db, [
          { table: 'payments"; DROP TABLE payments; --', columns: ['amount'] },
        ]),
      ).rejects.toThrow(/not a plain SQL identifier/);
    });

    it('honours a non-default scale', async () => {
      // A three-decimal minor unit: 1.234 scales to 1234 exactly, 1.2345 does not.
      await seed([
        ['p1', 1.234, 0],
        ['p2', 1.2345, 0],
      ]);

      const preflight = await preflightMinorUnitsRescale(db, TARGETS, {
        scale: 1000,
      });

      expect(preflight.scale).toBe(1000);
      expect(preflight.nonIntegralRows).toBe(1);
      expect(preflight.columns[0].nonIntegral[0].id).toBe('p2');
    });

    it('rejects a non-positive or fractional scale', async () => {
      await expect(
        preflightMinorUnitsRescale(db, TARGETS, { scale: 0 }),
      ).rejects.toThrow(/positive integer/);
      await expect(
        preflightMinorUnitsRescale(db, TARGETS, { scale: 2.5 }),
      ).rejects.toThrow(/positive integer/);
    });
  });

  describe('statement generation', () => {
    it('casts to numeric on PostgreSQL so ties round away from zero', () => {
      // `round(double precision)` is banker's rounding on PostgreSQL, so a
      // negative half would break to even and land one minor unit above what
      // the preflight predicted. `numeric` selects the half-away-from-zero
      // overload that SQLite, DuckDB and the preflight all use.
      expect(
        buildMinorUnitsStatements('postgres', 'payments', 'amount', 100),
      ).toEqual([
        'ALTER TABLE "payments" ALTER COLUMN "amount" DROP DEFAULT',
        'ALTER TABLE "payments" ALTER COLUMN "amount" TYPE BIGINT USING round(("amount")::numeric * 100)',
        'ALTER TABLE "payments" ALTER COLUMN "amount" SET DEFAULT 0',
      ]);
    });

    it('emits the same shape for DuckDB, whose round() already breaks ties away from zero', () => {
      expect(
        buildMinorUnitsStatements('duckdb', 'payments', 'amount', 100),
      ).toEqual([
        'ALTER TABLE "payments" ALTER COLUMN "amount" DROP DEFAULT',
        'ALTER TABLE "payments" ALTER COLUMN "amount" TYPE BIGINT USING round("amount" * 100)',
        'ALTER TABLE "payments" ALTER COLUMN "amount" SET DEFAULT 0',
      ]);
    });

    it('emits a value-only UPDATE for SQLite, which cannot alter a column type', () => {
      expect(
        buildMinorUnitsStatements('sqlite', 'payments', 'amount', 100),
      ).toEqual([
        'UPDATE "payments" SET "amount" = CAST(round("amount" * 100) AS INTEGER) WHERE "amount" IS NOT NULL',
      ]);
    });

    it('threads a non-default scale into the SQL', () => {
      expect(
        buildMinorUnitsStatements('postgres', 'payments', 'amount', 1000)[1],
      ).toContain('* 1000');
    });

    it('rounds a negative half away from zero, as SQL does', async () => {
      // `Math.round(-0.5)` is `-0`; SQLite's `round(-0.5)` is `-1`. A billing
      // credit is legitimately negative, so the preflight has to predict the
      // database's answer, not JavaScript's.
      await db.query(
        'INSERT INTO payments (id, amount, native_amount) VALUES (?, ?, ?)',
        'credit',
        -0.005,
        0,
      );

      const preflight = await preflightMinorUnitsRescale(db, TARGETS);
      const amountColumn = preflight.columns.find(
        (column) => column.column === 'amount',
      );
      expect(amountColumn?.nonIntegral).toEqual([
        { id: 'credit', value: -0.005, scaled: -0.5 },
      ]);

      await rescaleMoneyColumnsToMinorUnits(db, TARGETS, {
        backfillName: 'test:money-minor-units:v1',
        force: true,
      });
      const rows = await db.query(
        'SELECT amount FROM payments WHERE id = ?',
        'credit',
      );
      // The stored value and the preflight's prediction agree: -1, not 0.
      expect(rows.rows[0].amount).toBe(-1);
    });
  });

  describe('rescale', () => {
    it('rescales SQLite values to exact integers and flags the pending declaration', async () => {
      await seed([
        ['p1', 19.99, 0.5],
        ['p2', 1.6, 0],
      ]);

      const result = await rescaleMoneyColumnsToMinorUnits(db, TARGETS, {
        backfillName: 'test:money-minor-units:v1',
        packageName: '@happyvertical/smrt-core',
      });

      expect(result.ran).toBe(true);
      expect(result.engine).toBe('sqlite');
      expect(result.rescaledColumns).toEqual([
        { table: 'payments', column: 'amount' },
        { table: 'payments', column: 'native_amount' },
      ]);
      // SQLite cannot alter a declared column type in place, so the values move
      // and the declaration is reported as still outstanding (#2370).
      expect(result.declaredTypeChangePending).toEqual(result.rescaledColumns);
      expect(result.statements.every((sql) => sql.startsWith('UPDATE'))).toBe(
        true,
      );

      const rows = await db.query(
        'SELECT id, amount, native_amount FROM payments ORDER BY id',
      );
      expect(rows.rows).toEqual([
        { id: 'p1', amount: 1999, native_amount: 50 },
        { id: 'p2', amount: 160, native_amount: 0 },
      ]);
    });

    it('is idempotent — a second run does not multiply by the scale again', async () => {
      await seed([['p1', 19.99, 0]]);
      const options = {
        backfillName: 'test:money-minor-units:v1',
        packageName: '@happyvertical/smrt-core',
      };

      await rescaleMoneyColumnsToMinorUnits(db, TARGETS, options);
      const second = await rescaleMoneyColumnsToMinorUnits(
        db,
        TARGETS,
        options,
      );

      expect(second.ran).toBe(false);
      expect(second.statements).toEqual([]);
      const rows = await db.query(
        'SELECT amount FROM payments WHERE id = ?',
        'p1',
      );
      expect(rows.rows[0].amount).toBe(1999);
    });

    it('refuses to run when a row would be rounded away', async () => {
      await seed([['p1', 0.005, 0]]);

      await expect(
        rescaleMoneyColumnsToMinorUnits(db, TARGETS, {
          backfillName: 'test:money-minor-units:v1',
        }),
      ).rejects.toBeInstanceOf(MinorUnitsPreflightError);

      // The refusal must leave the data untouched.
      const rows = await db.query(
        'SELECT amount FROM payments WHERE id = ?',
        'p1',
      );
      expect(rows.rows[0].amount).toBe(0.005);
    });

    it('converts a lossy row when force is set', async () => {
      await seed([['p1', 0.005, 0]]);

      const result = await rescaleMoneyColumnsToMinorUnits(db, TARGETS, {
        backfillName: 'test:money-minor-units:v1',
        force: true,
      });

      expect(result.ran).toBe(true);
      expect(result.preflight.ok).toBe(false);
      const rows = await db.query(
        'SELECT amount FROM payments WHERE id = ?',
        'p1',
      );
      // round-half-away-from-zero: 0.5 becomes 1 cent.
      expect(rows.rows[0].amount).toBe(1);
    });

    it('skips columns that are already integer', async () => {
      await db.query('DROP TABLE payments');
      await db.query(
        `CREATE TABLE payments (
           id TEXT PRIMARY KEY NOT NULL,
           amount INTEGER DEFAULT 0,
           native_amount REAL DEFAULT 0
         )`,
      );
      await seed([['p1', 1999, 1.5]]);

      const result = await rescaleMoneyColumnsToMinorUnits(db, TARGETS, {
        backfillName: 'test:money-minor-units:v1',
      });

      expect(result.rescaledColumns).toEqual([
        { table: 'payments', column: 'native_amount' },
      ]);
      const rows = await db.query('SELECT amount, native_amount FROM payments');
      expect(rows.rows[0]).toEqual({ amount: 1999, native_amount: 150 });
    });
  });
});

/**
 * The conversion and its marker are one unit. On SQLite a rescaled column still
 * declares a floating-point type, so the marker is all that says "done": a run
 * that changed some columns and then stopped, without the marker, would be
 * repeated from the start and scale those columns a second time.
 */
describe('money minor-units rescale is one unit (SQLite)', () => {
  const TWO_TABLES = [
    { table: 'unit_orders', columns: ['total'] },
    { table: 'unit_customers', columns: ['credit_limit'] },
  ];
  const OPTIONS = { backfillName: 'test:unit:money-minor-units:v1' };
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query(
      'CREATE TABLE unit_orders (id TEXT PRIMARY KEY, total REAL DEFAULT 0)',
    );
    await db.query(
      'CREATE TABLE unit_customers (id TEXT PRIMARY KEY, credit_limit REAL DEFAULT 0)',
    );
    await db.query("INSERT INTO unit_orders VALUES ('o1', 19.99)");
    await db.query("INSERT INTO unit_customers VALUES ('c1', 500.0)");
  });
  afterEach(async () => {
    await db.close?.();
  });

  const values = async () => ({
    total: (await db.query('SELECT total FROM unit_orders')).rows[0].total,
    credit: (await db.query('SELECT credit_limit FROM unit_customers')).rows[0]
      .credit_limit,
  });
  const markers = async () => {
    try {
      const result = await db.query(
        'SELECT COUNT(*) AS n FROM _smrt_backfills WHERE name = ?',
        OPTIONS.backfillName,
      );
      return Number(result.rows[0].n);
    } catch {
      return 0;
    }
  };

  it('changes nothing when a later table fails, and converts each column exactly once on the rerun', async () => {
    await db.query(
      "CREATE TRIGGER unit_refuse BEFORE UPDATE ON unit_customers BEGIN SELECT RAISE(ABORT, 'second table failed'); END",
    );

    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS),
    ).rejects.toThrow(/second table failed/);

    // The first table's update went back with the rest.
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);

    await db.query('DROP TRIGGER unit_refuse');
    const rerun = await rescaleMoneyColumnsToMinorUnits(
      db,
      TWO_TABLES,
      OPTIONS,
    );
    expect(rerun.ran).toBe(true);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
    expect(await markers()).toBe(1);

    const third = await rescaleMoneyColumnsToMinorUnits(
      db,
      TWO_TABLES,
      OPTIONS,
    );
    expect(third.ran).toBe(false);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
  });

  it('changes nothing when the marker cannot be recorded', async () => {
    // Every column converts; the very last step, the marker, fails.
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
    await db.query(
      "CREATE TRIGGER unit_no_marker BEFORE INSERT ON _smrt_backfills BEGIN SELECT RAISE(ABORT, 'marker not recorded'); END",
    );

    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS),
    ).rejects.toThrow(/marker not recorded/);
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);

    await db.query('DROP TRIGGER unit_no_marker');
    await rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
  });

  it('changes nothing when the preflight refuses, and leaves the run repeatable', async () => {
    await db.query("INSERT INTO unit_customers VALUES ('c2', 0.005)");

    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS),
    ).rejects.toBeInstanceOf(MinorUnitsPreflightError);
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);
  });

  it('runs inside a caller-owned transaction and rolls back with it', async () => {
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
    await expect(
      db.transaction?.(async (tx) => {
        const result = await rescaleMoneyColumnsToMinorUnits(
          tx as unknown as DatabaseInterface,
          TWO_TABLES,
          OPTIONS,
        );
        expect(result.ran).toBe(true);
        throw new Error('caller changed its mind');
      }),
    ).rejects.toThrow('caller changed its mind');

    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);
  });

  it('refuses a caller transaction handle that cannot open a nested scope, before writing anything', async () => {
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
    await db.query(
      "CREATE TRIGGER unit_refuse BEFORE UPDATE ON unit_customers BEGIN SELECT RAISE(ABORT, 'second table failed'); END",
    );

    await db.transaction?.(async (tx) => {
      // The same handle without transaction(): no nested scope.
      const flat = new Proxy(tx as unknown as DatabaseInterface, {
        get(target, key, receiver) {
          if (key === 'transaction') return undefined;
          const value = Reflect.get(target, key, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await expect(
        rescaleMoneyColumnsToMinorUnits(flat, TWO_TABLES, OPTIONS),
      ).rejects.toThrow(/cannot open a nested scope/);
      // The caller handles the error and commits.
    });

    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);
  });

  it('returns the original failure when SQLite rolled back the whole caller transaction', async () => {
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
    await db.query(
      "CREATE TRIGGER unit_rollback BEFORE UPDATE ON unit_customers BEGIN SELECT RAISE(ROLLBACK, 'second table rolled everything back'); END",
    );

    const failure = await db
      .transaction?.(async (tx) => {
        await rescaleMoneyColumnsToMinorUnits(
          tx as unknown as DatabaseInterface,
          TWO_TABLES,
          OPTIONS,
        );
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(String((failure as Error)?.message ?? failure)).toContain(
      'second table rolled everything back',
    );
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);
  });

  it('leaves nothing converted in a caller-owned transaction that catches the failure and commits', async () => {
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
    await db.query(
      "CREATE TRIGGER unit_refuse BEFORE UPDATE ON unit_customers BEGIN SELECT RAISE(ABORT, 'second table failed'); END",
    );

    await db.transaction?.(async (tx) => {
      await expect(
        rescaleMoneyColumnsToMinorUnits(
          tx as unknown as DatabaseInterface,
          TWO_TABLES,
          OPTIONS,
        ),
      ).rejects.toThrow(/second table failed/);
      // The caller handles the error and commits its transaction.
    });

    // The first table's update did not survive the commit, and there is no
    // marker: a rerun converts each column once.
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);
    await db.query('DROP TRIGGER unit_refuse');
    await rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
  });

  it('fails the whole rescale when a table catalog read fails, and writes nothing', async () => {
    const unreadable = rejectingQueries(
      db,
      /table_xinfo\("unit_customers"\)/,
      'catalog read failed',
    );
    await expect(
      rescaleMoneyColumnsToMinorUnits(unreadable, TWO_TABLES, OPTIONS),
    ).rejects.toThrow(/catalog read failed/);

    expect(await values()).toEqual({ total: 19.99, credit: 500 });
    expect(await markers()).toBe(0);

    // Once the table can be read, the rerun converts each column exactly once.
    await rescaleMoneyColumnsToMinorUnits(db, TWO_TABLES, OPTIONS);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
    expect(await markers()).toBe(1);
  });

  it('still tolerates a table that does not exist', async () => {
    const result = await rescaleMoneyColumnsToMinorUnits(
      db,
      [...TWO_TABLES, { table: 'unit_not_created_yet', columns: ['total'] }],
      OPTIONS,
    );
    expect(result.ran).toBe(true);
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
  });
});

describe('money minor-units rescale is one unit (DuckDB)', () => {
  const TWO_TABLES = [
    { table: 'unit_orders', columns: ['total'] },
    { table: 'unit_customers', columns: ['credit_limit'] },
  ];
  const OPTIONS = { backfillName: 'test:unit:money-minor-units:duckdb:v1' };
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    await db.query(
      'CREATE TABLE unit_orders (id TEXT, total DOUBLE DEFAULT 0.0)',
    );
    await db.query(
      'CREATE TABLE unit_customers (id TEXT, credit_limit DOUBLE DEFAULT 0.0)',
    );
    await db.query("INSERT INTO unit_orders VALUES ('o1', 19.99)");
    await db.query("INSERT INTO unit_customers VALUES ('c1', 500.0)");
  });
  afterEach(async () => {
    await db.close?.();
  });

  // A native DuckDB root exposes `exportTable` and is refused, so the rescale
  // runs on the handle of a transaction the caller opened.
  const rescaleOnScope = (
    targets: Parameters<typeof rescaleMoneyColumnsToMinorUnits>[1],
    options: Parameters<typeof rescaleMoneyColumnsToMinorUnits>[2],
  ) =>
    db.transaction?.((tx) =>
      rescaleMoneyColumnsToMinorUnits(
        tx as unknown as DatabaseInterface,
        targets,
        options,
      ),
    ) as ReturnType<typeof rescaleMoneyColumnsToMinorUnits>;

  const column = async (table: string, name: string) => {
    const type = await db.query(
      'SELECT data_type FROM information_schema.columns WHERE table_name = ? AND column_name = ?',
      table,
      name,
    );
    const value = await db.query(`SELECT "${name}" AS value FROM "${table}"`);
    return {
      type: String(type.rows[0].data_type),
      value: Number(value.rows[0].value),
    };
  };
  const markers = async () => {
    try {
      const result = await db.query(
        'SELECT COUNT(*) AS n FROM _smrt_backfills WHERE name = ?',
        OPTIONS.backfillName,
      );
      return Number(result.rows[0].n);
    } catch {
      return 0;
    }
  };

  it('keeps the caller transaction usable when the preflight refuses before anything is written', async () => {
    await rescaleOnScope([], {
      backfillName: 'test:unit:duckdb:creates-the-marker-table',
      engineHint: 'duckdb',
    });
    await db.query('CREATE TABLE unit_sentinel (id TEXT)');
    // A value that cannot be represented in minor units without rounding.
    await db.query("INSERT INTO unit_customers VALUES ('c2', 0.005)");

    await db.transaction?.(async (tx) => {
      const unit = tx as unknown as DatabaseInterface;
      await unit.query("INSERT INTO unit_sentinel VALUES ('caller work')");
      await expect(
        rescaleMoneyColumnsToMinorUnits(unit, TWO_TABLES, {
          ...OPTIONS,
          engineHint: 'duckdb',
        }),
      ).rejects.toBeInstanceOf(MinorUnitsPreflightError);
      // The caller handles the documented refusal and commits its own work.
    });

    expect((await db.query('SELECT id FROM unit_sentinel')).rows).toEqual([
      { id: 'caller work' },
    ]);
    expect((await column('unit_orders', 'total')).value).toBe(19.99);
    expect(await markers()).toBe(0);
  });

  it('leaves nothing when the marker insert fails before reaching DuckDB in a caller-owned transaction', async () => {
    // The marker table exists (a first, empty rescale), so the failure below
    // is the only thing that stops the run.
    await rescaleOnScope([], {
      backfillName: 'test:unit:duckdb:creates-the-marker-table',
      engineHint: 'duckdb',
    });
    await db
      .transaction?.(async (tx) => {
        const failing = new Proxy(tx as unknown as DatabaseInterface, {
          get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            if (key !== 'query')
              return typeof value === 'function' ? value.bind(target) : value;
            return async (sql: string, ...args: unknown[]) => {
              if (/INSERT INTO _smrt_backfills/i.test(String(sql)))
                throw new Error('adapter failed before sending the marker');
              return (value as DatabaseInterface['query']).call(
                target,
                sql,
                ...args,
              );
            };
          },
        });
        await expect(
          rescaleMoneyColumnsToMinorUnits(failing, TWO_TABLES, {
            ...OPTIONS,
            engineHint: 'duckdb',
          }),
        ).rejects.toThrow(/adapter failed/);
        // The caller handles the error and tries to commit; the adapter may
        // report the aborted transaction or end it quietly.
      })
      .catch(() => undefined);

    expect((await column('unit_orders', 'total')).value).toBe(19.99);
    expect((await column('unit_customers', 'credit_limit')).value).toBe(500);
    expect(await markers()).toBe(0);
  });

  it('leaves nothing when the marker insert and the abort statement both fail locally and the owner commits', async () => {
    await rescaleOnScope([], {
      backfillName: 'test:unit:duckdb:creates-the-marker-table',
      engineHint: 'duckdb',
    });
    await db
      .transaction?.(async (tx) => {
        const failing = rejectingQueries(
          tx as unknown as DatabaseInterface,
          /INSERT INTO _smrt_backfills|SELECT error\(/i,
          'adapter stopped forwarding queries',
        );
        await expect(
          rescaleMoneyColumnsToMinorUnits(failing, TWO_TABLES, {
            ...OPTIONS,
            engineHint: 'duckdb',
          }),
        ).rejects.toThrow();
        // The owner catches the failure and commits.
      })
      .catch(() => undefined);

    expect((await column('unit_orders', 'total')).value).toBe(19.99);
    expect((await column('unit_customers', 'credit_limit')).value).toBe(500);
    expect(await markers()).toBe(0);
  });

  it('reports an abort that no path confirmed instead of treating it as done', async () => {
    const unreachable = {
      query: async () => {
        throw new Error('adapter stopped forwarding queries');
      },
    } as unknown as DatabaseInterface;
    await expect(abortJoinedDuckDbTransaction(unreachable)).rejects.toThrow(
      /Could not confirm/,
    );
  });

  it.each([
    ['with the engine hint', { engineHint: 'duckdb' }],
    ['without a hint', {}],
  ])('converts inside a caller-owned DuckDB transaction, %s', async (_label, hint) => {
    await db.transaction?.(async (tx) => {
      const result = await rescaleMoneyColumnsToMinorUnits(
        tx as unknown as DatabaseInterface,
        TWO_TABLES,
        { ...OPTIONS, ...hint },
      );
      expect(result.ran).toBe(true);
    });
    expect((await column('unit_orders', 'total')).value).toBe(1999);
    expect((await column('unit_customers', 'credit_limit')).value).toBe(50000);
    expect(await markers()).toBe(1);
  });

  it('converts the values and records the marker in one transaction', async () => {
    const result = await rescaleOnScope(TWO_TABLES, {
      ...OPTIONS,
      engineHint: 'duckdb',
    });

    // DuckDB converts the column type with the values, so no declaration is
    // left outstanding.
    expect(result.ran).toBe(true);
    expect(result.rescaledColumns).toHaveLength(2);
    expect(result.declaredTypeChangePending).toEqual([]);
    expect((await column('unit_orders', 'total')).value).toBe(1999);
    expect((await column('unit_customers', 'credit_limit')).value).toBe(50000);
    expect(await markers()).toBe(1);

    const second = await rescaleOnScope(TWO_TABLES, {
      ...OPTIONS,
      engineHint: 'duckdb',
    });
    expect(second.ran).toBe(false);
    expect((await column('unit_orders', 'total')).value).toBe(1999);
  });

  it('accepts the type conversion statements and a marker in one transaction, and rolls them all back together', async () => {
    // What the conversion relies on from DuckDB: ALTER ... TYPE with USING,
    // several ALTERs of one table, and an INSERT, all in one transaction.
    const convert = [
      ...buildMinorUnitsStatements('duckdb', 'unit_orders', 'total', 100),
      ...buildMinorUnitsStatements(
        'duckdb',
        'unit_customers',
        'credit_limit',
        100,
      ),
    ];
    await db.query('CREATE TABLE unit_marker (name TEXT PRIMARY KEY)');

    await expect(
      db.transaction?.(async (tx) => {
        for (const sql of convert) await tx.query(sql);
        await tx.query("INSERT INTO unit_marker VALUES ('done')");
        throw new Error('stopped before commit');
      }),
    ).rejects.toThrow('stopped before commit');
    expect(await column('unit_orders', 'total')).toEqual({
      type: 'DOUBLE',
      value: 19.99,
    });
    expect((await db.query('SELECT * FROM unit_marker')).rows).toEqual([]);

    await db.transaction?.(async (tx) => {
      for (const sql of convert) await tx.query(sql);
      await tx.query("INSERT INTO unit_marker VALUES ('done')");
    });
    expect(await column('unit_orders', 'total')).toEqual({
      type: 'BIGINT',
      value: 1999,
    });
    expect(await column('unit_customers', 'credit_limit')).toEqual({
      type: 'BIGINT',
      value: 50000,
    });
  });

  it('changes nothing when a later table fails', async () => {
    // Forced past the preflight, this value cannot be stored as BIGINT, so
    // the second table's conversion fails after the first one ran.
    await db.query("INSERT INTO unit_customers VALUES ('c2', 1e300)");

    await expect(
      rescaleOnScope(TWO_TABLES, {
        ...OPTIONS,
        engineHint: 'duckdb',
        force: true,
      }),
    ).rejects.toThrow();

    expect(await column('unit_orders', 'total')).toEqual({
      type: 'DOUBLE',
      value: 19.99,
    });
    expect(await markers()).toBe(0);
  });
});

describe('money minor-units rescale on a secure-file SQLite database', () => {
  const TWO_TABLES = [
    { table: 'unit_orders', columns: ['total'] },
    { table: 'unit_customers', columns: ['credit_limit'] },
  ];
  const OPTIONS = { backfillName: 'test:unit:money-minor-units:secure:v1' };
  let directory: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'smrt-minor-units-secure-'));
    chmodSync(directory, 0o700);
    db = (await getDatabase({
      type: 'sqlite',
      url: `file:${join(directory, 'app.db')}`,
      secureFile: {
        driver: 'node:sqlite',
        custody: 'trusted-parent',
        root: directory,
      },
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await db.query(
      'CREATE TABLE unit_orders (id TEXT PRIMARY KEY, total REAL DEFAULT 0)',
    );
    await db.query(
      'CREATE TABLE unit_customers (id TEXT PRIMARY KEY, credit_limit REAL DEFAULT 0)',
    );
    await db.query("INSERT INTO unit_orders VALUES ('o1', 19.99)");
    await db.query("INSERT INTO unit_customers VALUES ('c1', 500.0)");
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      backfillName: 'test:unit:creates-the-marker-table',
    });
  });
  afterEach(async () => {
    await db.close?.();
    rmSync(directory, { recursive: true, force: true });
  });

  const values = async () => ({
    total: (await db.query('SELECT total FROM unit_orders')).rows[0].total,
    credit: (await db.query('SELECT credit_limit FROM unit_customers')).rows[0]
      .credit_limit,
  });

  it('converts inside a caller-owned transaction', async () => {
    await db.transaction?.(async (tx) => {
      const result = await rescaleMoneyColumnsToMinorUnits(
        tx as unknown as DatabaseInterface,
        TWO_TABLES,
        OPTIONS,
      );
      expect(result.ran).toBe(true);
    });
    expect(await values()).toEqual({ total: 1999, credit: 50000 });
  });

  it('leaves nothing converted when the caller catches the failure and commits', async () => {
    await db.query(
      "CREATE TRIGGER unit_refuse BEFORE UPDATE ON unit_customers BEGIN SELECT RAISE(ABORT, 'second table failed'); END",
    );
    await db.transaction?.(async (tx) => {
      await expect(
        rescaleMoneyColumnsToMinorUnits(
          tx as unknown as DatabaseInterface,
          TWO_TABLES,
          OPTIONS,
        ),
      ).rejects.toThrow(/second table failed/);
    });
    expect(await values()).toEqual({ total: 19.99, credit: 500 });
  });
});

describe('money minor-units rescale refuses a JSON-backed handle', () => {
  const TARGET = [{ table: 'json_orders', columns: ['total'] }];
  const OPTIONS = { backfillName: 'test:unit:money-minor-units:json:v1' };
  let dir: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    db = await getDatabase({ type: 'json', url: dir });
    await db.query(
      'CREATE TABLE json_orders (id TEXT, total DOUBLE DEFAULT 0.0)',
    );
    await db.query("INSERT INTO json_orders VALUES ('o1', 19.99)");
  });
  afterEach(async () => {
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const total = async () =>
    Number((await db.query('SELECT total FROM json_orders')).rows[0].total);

  it('refuses the root handle before reading or writing anything', async () => {
    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TARGET, OPTIONS),
    ).rejects.toThrow(/backed by JSON export/);
    await expect(preflightMinorUnitsRescale(db, TARGET, {})).rejects.toThrow(
      /backed by JSON export/,
    );
    expect(await total()).toBe(19.99);
    const marker = await db
      .query('SELECT name FROM _smrt_backfills')
      .catch(() => ({ rows: [] }));
    expect(marker.rows).toEqual([]);
  });

  it('refuses a transaction scope that reports the json engine', async () => {
    await db.transaction?.(async (tx) => {
      const scope = tx as unknown as DatabaseInterface;
      await expect(
        rescaleMoneyColumnsToMinorUnits(scope, TARGET, OPTIONS),
      ).rejects.toThrow(/backed by JSON export/);
    });
    expect(await total()).toBe(19.99);
  });

  it('refuses an explicit json engine hint', async () => {
    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TARGET, {
        ...OPTIONS,
        engineHint: 'json',
      }),
    ).rejects.toThrow(/backed by JSON export/);
  });

  it.each([
    'JSON',
    ' Json ',
    'json',
  ])('refuses the engine hint %j however it is spelled', async (hint) => {
    await expect(
      rescaleMoneyColumnsToMinorUnits(db, TARGET, {
        ...OPTIONS,
        engineHint: hint,
      }),
    ).rejects.toThrow(/backed by JSON export/);
    await expect(
      preflightMinorUnitsRescale(db, TARGET, { engineHint: hint }),
    ).rejects.toThrow(/backed by JSON export/);
  });

  it.each([
    'JSON',
    ' Json ',
    'json',
  ])('refuses a handle identified only by the engine hint %j', async (hint) => {
    // A native DuckDB root with the default write strategy is proven native by
    // its own refusal to export, so only the hint can mark it JSON-backed.
    const native = await getDatabase({
      type: 'duckdb',
      url: ':memory:',
      dataDir: dir,
    } as Parameters<typeof getDatabase>[0]);
    try {
      await native.query('CREATE TABLE hint_orders (id TEXT, total DOUBLE)');
      await native.query("INSERT INTO hint_orders VALUES ('o1', 19.99)");
      const targets = [{ table: 'hint_orders', columns: ['total'] }];
      await expect(
        rescaleMoneyColumnsToMinorUnits(native, targets, {
          backfillName: 'test:unit:hint-only',
          engineHint: hint,
        }),
      ).rejects.toThrow(/backed by JSON export/);
      await expect(
        preflightMinorUnitsRescale(native, targets, { engineHint: hint }),
      ).rejects.toThrow(/backed by JSON export/);
      expect(
        Number(
          (await native.query('SELECT total FROM hint_orders')).rows[0].total,
        ),
      ).toBe(19.99);
    } finally {
      await native.close?.();
    }
  });

  it('accepts a native DuckDB root whose write strategy never exports, and refuses one that exports', async () => {
    const targets = [{ table: 'native_orders', columns: ['total'] }];
    const open = async (writeStrategy?: string) => {
      const handle = await getDatabase({
        type: 'duckdb',
        url: ':memory:',
        dataDir: dir,
        ...(writeStrategy ? { writeStrategy } : {}),
      } as Parameters<typeof getDatabase>[0]);
      await handle.query('CREATE TABLE native_orders (id TEXT, total DOUBLE)');
      await handle.query("INSERT INTO native_orders VALUES ('o1', 19.99)");
      return handle;
    };
    const total = async (handle: DatabaseInterface) =>
      Number(
        (await handle.query('SELECT total FROM native_orders')).rows[0].total,
      );

    for (const strategy of ['manual', 'immediate']) {
      const exporting = await open(strategy);
      try {
        expect(
          typeof (exporting as { exportTable?: unknown }).exportTable,
        ).toBe('function');
        await expect(
          rescaleMoneyColumnsToMinorUnits(exporting, targets, {
            backfillName: `test:unit:native-${strategy}`,
            engineHint: 'duckdb',
          }),
        ).rejects.toThrow(/backed by JSON export/);
        expect(await total(exporting)).toBe(19.99);
      } finally {
        await exporting.close?.();
      }
    }

    const native = await open();
    try {
      const result = await rescaleMoneyColumnsToMinorUnits(native, targets, {
        backfillName: 'test:unit:native-none',
        engineHint: 'duckdb',
      });
      expect(result.ran).toBe(true);
      expect(await total(native)).toBe(1999);
    } finally {
      await native.close?.();
    }
  });
});
