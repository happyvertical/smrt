/**
 * Money major-units → integer minor-units rescale (#2401).
 *
 * Exercised against real in-memory SQLite. The PostgreSQL/DuckDB DDL path is
 * asserted through the emitted statements (the lane that runs the real thing is
 * each owning package's `test:postgres`), while the value rescale, the
 * preflight and the idempotency marker are executed for real.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMinorUnitsStatements,
  MinorUnitsPreflightError,
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '../minor-units.js';

const TARGETS = [{ table: 'payments', columns: ['amount', 'native_amount'] }];

describe('money minor-units rescale (#2401)', () => {
  let db: DatabaseProvider;

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

    it('lists rows whose scaled value overflows int4', async () => {
      // $21.5M in cents is 2_150_000_000, past the int4 ceiling. Widening to
      // BIGINT is the decision parked in #2373.
      await seed([['p1', 21_500_000, 0]]);

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
        'ALTER TABLE "payments" ALTER COLUMN "amount" TYPE INTEGER USING round(("amount")::numeric * 100)',
        'ALTER TABLE "payments" ALTER COLUMN "amount" SET DEFAULT 0',
      ]);
    });

    it('emits the same shape for DuckDB, whose round() already breaks ties away from zero', () => {
      expect(
        buildMinorUnitsStatements('duckdb', 'payments', 'amount', 100),
      ).toEqual([
        'ALTER TABLE "payments" ALTER COLUMN "amount" DROP DEFAULT',
        'ALTER TABLE "payments" ALTER COLUMN "amount" TYPE INTEGER USING round("amount" * 100)',
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
