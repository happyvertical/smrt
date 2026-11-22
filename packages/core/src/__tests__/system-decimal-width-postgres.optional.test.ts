/**
 * PostgreSQL widens the six DOUBLE PRECISION system columns on start under a
 * savepoint, and a blocker defers the widening instead of aborting the start
 * or a caller's transaction (P5a, E8).
 *
 * Runs against PostgreSQL when `SMRT_TEST_POSTGRES_URL` is set (a DISPOSABLE
 * database: it alters and drops system tables) and against PGlite under
 * `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap.js';
import {
  SYSTEM_DECIMAL_COLUMNS,
  widenSystemDecimalColumns,
} from '../system/decimal-width.js';
import { getTestDatabase } from '../testing/database.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const engines = [
  ...(pgUrl ? (['postgres'] as const) : []),
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

describe.skipIf(engines.length === 0).each(engines.length ? engines : ['none'])(
  'system decimal columns on %s',
  (engine) => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      db =
        engine === 'postgres'
          ? ((await getDatabase({
              type: 'postgres',
              url: pgUrl,
              dbid: 'smrt-test-system-decimal-width',
            } as Parameters<typeof getDatabase>[0])) as DatabaseInterface)
          : await getTestDatabase({
              type: 'pglite',
              classes: [],
              includeSystemTables: false,
            });
      await db.query('DROP VIEW IF EXISTS ops_blocker');
      await ensureSystemTables(db, 'postgres');
      // A stamped install whose six columns are still 4-byte REAL.
      for (const { table, column } of SYSTEM_DECIMAL_COLUMNS)
        await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE real`);
    });
    afterEach(async () => {
      await db.query('DROP VIEW IF EXISTS ops_blocker');
      if (engine === 'pglite') await db.close?.();
    });

    const typeOf = async (table: string, column: string) =>
      String(
        (
          await db.query(
            `SELECT data_type FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
            table,
            column,
          )
        ).rows[0]?.data_type,
      );

    it('defers on PostgreSQL under a savepoint, including the stamped fast path and a competing view', async () => {
      await db.query(
        'CREATE VIEW ops_blocker AS SELECT estimated_cost FROM _smrt_ai_usage',
      );
      // The stamped fast path still runs the width step, and the start goes on.
      await expect(ensureSystemTables(db, 'postgres')).resolves.toBeUndefined();
      expect(await typeOf('_smrt_ai_usage', 'estimated_cost')).toBe('real');
      expect(await typeOf('_smrt_contexts', 'confidence')).toBe(
        'double precision',
      );

      const deferred = await widenSystemDecimalColumns(db, 'postgres');
      const held = deferred.find((item) => item.table === '_smrt_ai_usage');
      expect(held?.outcome).toBe('deferred');
      expect(held?.reason).toContain('0A000');

      await db.query('DROP VIEW ops_blocker');
      // A view created between the width probe and the ALTER: the ALTER
      // fails inside its savepoint, and the transaction is not aborted.
      let raced = false;
      const wrap = (handle: DatabaseInterface): DatabaseInterface =>
        new Proxy(handle, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (property === 'query')
              return async (sql: string, ...args: unknown[]) => {
                if (
                  !raced &&
                  /^ALTER TABLE "?_smrt_ai_usage"? ALTER COLUMN "?estimated_cost"?/.test(
                    sql,
                  )
                ) {
                  raced = true;
                  await target.query(
                    'CREATE VIEW ops_blocker AS SELECT estimated_cost FROM _smrt_ai_usage',
                  );
                }
                return target.query(sql, ...args);
              };
            if (property === 'transaction' && typeof value === 'function')
              return (
                callback: (tx: DatabaseInterface) => Promise<unknown>,
                ...rest: unknown[]
              ) =>
                (
                  value as (
                    callback: (tx: DatabaseInterface) => Promise<unknown>,
                    ...rest: unknown[]
                  ) => Promise<unknown>
                ).call(target, (tx) => callback(wrap(tx)), ...rest);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      const racing = wrap(db);
      const raceResult = await widenSystemDecimalColumns(racing, 'postgres');
      expect(raced).toBe(true);
      expect(
        raceResult.find((item) => item.table === '_smrt_ai_usage')?.outcome,
      ).toBe('deferred');
      expect(await typeOf('_smrt_ai_usage', 'estimated_cost')).toBe('real');

      await db.query('DROP VIEW IF EXISTS ops_blocker');
      const widened = await widenSystemDecimalColumns(db, 'postgres');
      expect(
        widened.find((item) => item.table === '_smrt_ai_usage')?.outcome,
      ).toBe('widened');
      for (const { table, column } of SYSTEM_DECIMAL_COLUMNS)
        expect(await typeOf(table, column)).toBe('double precision');
    });

    it("does not attempt the system widening inside a caller's transaction (PostgreSQL)", async () => {
      await db.transaction?.(async (tx) => {
        const result = await widenSystemDecimalColumns(tx, 'postgres');
        expect(new Set(result.map((item) => item.outcome))).toEqual(
          new Set(['not-attempted']),
        );
        await tx.query('SELECT 1');
      });
      expect(await typeOf('_smrt_contexts', 'confidence')).toBe('real');
    });
  },
);
