/**
 * The money minor-units rescale on a real PostgreSQL server: one unit, one
 * runner at a time (`minor-units.test.ts` covers SQLite and DuckDB).
 *
 * `ALTER ... TYPE BIGINT USING round(col * scale)` scales whatever the column
 * holds when it runs. Two runners that both read the column as floating-point
 * would each scale it. The run therefore holds the migration lock, claims its
 * marker inside one transaction with every statement, and reads the column
 * types under a table lock.
 *
 * Runs only in the PostgreSQL lane (`DATABASE_URL` / `SMRT_TEST_POSTGRES_URL`).
 */

import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dropScratchDatabase } from '../../__tests__/fixtures/postgres-scratch-database.js';
import {
  preflightMinorUnitsRescale,
  rescaleMoneyColumnsToMinorUnits,
} from '../minor-units.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'money minor-units rescale is one unit (real PostgreSQL)',
  () => {
    let admin: DatabaseInterface;
    let first: DatabaseInterface;
    let second: DatabaseInterface;
    let databaseName: string;
    let orders: string;
    let customers: string;
    let backfillName: string;

    const targets = () => [
      { table: orders, columns: ['total', 'tax'] },
      { table: customers, columns: ['credit_limit'] },
    ];
    const options = () => ({ engineHint: 'postgres', backfillName });

    const column = async (table: string, name: string, schema = 'public') => {
      const type = await first.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = ? AND table_name = ? AND column_name = ?`,
        schema,
        table,
        name,
      );
      const value = await first.query(
        `SELECT "${name}" AS value FROM ${schema}."${table}" ORDER BY id LIMIT 1`,
      );
      return {
        type: String(type.rows[0]?.data_type),
        value: Number(value.rows[0]?.value),
      };
    };
    const markers = async () =>
      Number(
        (
          await first.query(
            'SELECT COUNT(*) AS n FROM _smrt_backfills WHERE name = ?',
            backfillName,
          )
        ).rows[0].n,
      );

    const connect = async (url: string) =>
      (await getDatabase({
        type: 'postgres',
        url,
        dbid: `minor-units-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    beforeAll(async () => {
      admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
      })) as DatabaseInterface;
      databaseName = `smrt_minor_units_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(pgUrl as string);
      url.pathname = `/${databaseName}`;
      first = await connect(String(url));
      second = await connect(String(url));
      // Create the marker table once, outside every run.
      await rescaleMoneyColumnsToMinorUnits(first, [], {
        engineHint: 'postgres',
        backfillName: 'test:creates-the-marker-table',
      });
    });
    beforeEach(async () => {
      const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
      orders = `unit_orders_${suffix}`;
      customers = `unit_customers_${suffix}`;
      backfillName = `test:unit:${suffix}`;
      await first.query(
        `CREATE TABLE ${orders} (id TEXT PRIMARY KEY, total DOUBLE PRECISION DEFAULT 0.0, tax DOUBLE PRECISION DEFAULT 0.0)`,
      );
      await first.query(
        `CREATE TABLE ${customers} (id TEXT PRIMARY KEY, credit_limit DOUBLE PRECISION DEFAULT 0.0)`,
      );
      await first.query(`INSERT INTO ${orders} VALUES ('o1', 19.99, 1.5)`);
      await first.query(`INSERT INTO ${customers} VALUES ('c1', 500.0)`);
    });
    afterAll(async () => {
      await first?.close?.();
      await second?.close?.();
      await dropScratchDatabase(admin, databaseName);
      await admin?.close?.();
    });

    it('two runners at once convert every column exactly once', async () => {
      const outcomes = await Promise.all([
        rescaleMoneyColumnsToMinorUnits(first, targets(), options()),
        rescaleMoneyColumnsToMinorUnits(second, targets(), options()),
      ]);

      // One ran; the other waited, found the marker and did nothing.
      expect(outcomes.map((outcome) => outcome.ran).sort()).toEqual([
        false,
        true,
      ]);
      expect(await column(orders, 'total')).toEqual({
        type: 'bigint',
        value: 1999,
      });
      expect(await column(orders, 'tax')).toEqual({
        type: 'bigint',
        value: 150,
      });
      expect(await column(customers, 'credit_limit')).toEqual({
        type: 'bigint',
        value: 50000,
      });
      expect(await markers()).toBe(1);
    });

    it('refuses a caller transaction handle that cannot open a nested scope, before writing anything', async () => {
      await first.transaction?.(async (tx) => {
        const flat = new Proxy(tx as unknown as DatabaseInterface, {
          get(target, key, receiver) {
            if (key === 'transaction') return undefined;
            const value = Reflect.get(target, key, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await expect(
          rescaleMoneyColumnsToMinorUnits(flat, targets(), options()),
        ).rejects.toThrow(/cannot open a nested scope/);
        // The caller handles the error and commits.
      });

      expect(await column(orders, 'total')).toEqual({
        type: 'double precision',
        value: 19.99,
      });
      expect(await column(customers, 'credit_limit')).toEqual({
        type: 'double precision',
        value: 500,
      });
      expect(await markers()).toBe(0);
    });

    it('changes nothing when a later table fails', async () => {
      // Forced past the preflight, this value cannot be stored as BIGINT, so
      // the second table's conversion fails after the first table's ran.
      await first.query(`INSERT INTO ${customers} VALUES ('c2', 1e300)`);

      await expect(
        rescaleMoneyColumnsToMinorUnits(first, targets(), {
          ...options(),
          force: true,
        }),
      ).rejects.toThrow();

      expect(await column(orders, 'total')).toEqual({
        type: 'double precision',
        value: 19.99,
      });
      expect(await markers()).toBe(0);

      await first.query(`DELETE FROM ${customers} WHERE id = 'c2'`);
      expect(
        (await rescaleMoneyColumnsToMinorUnits(first, targets(), options()))
          .ran,
      ).toBe(true);
      expect((await column(orders, 'total')).value).toBe(1999);
    });

    it('reads the column types of its own table, not of a same-named table in another schema', async () => {
      // A copy elsewhere still holds floating-point major units. The table the
      // statements address was converted by other means and has no marker.
      const copy = `unit_copy_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      await first.query(`CREATE SCHEMA ${copy}`);
      await first.query(
        `CREATE TABLE ${copy}.${orders} (id TEXT PRIMARY KEY, total DOUBLE PRECISION, tax DOUBLE PRECISION)`,
      );
      await first.query(
        `INSERT INTO ${copy}.${orders} VALUES ('o1', 19.99, 1.5)`,
      );
      await first.query(
        `ALTER TABLE ${orders} ALTER COLUMN total DROP DEFAULT, ALTER COLUMN total TYPE BIGINT USING round(total::numeric * 100)`,
      );

      const preflight = await preflightMinorUnitsRescale(
        first,
        [{ table: orders, columns: ['total'] }],
        { engineHint: 'postgres' },
      );
      expect(preflight.columns).toEqual([
        expect.objectContaining({ state: 'converted', declaredType: 'bigint' }),
      ]);

      await rescaleMoneyColumnsToMinorUnits(
        first,
        [{ table: orders, columns: ['total'] }],
        options(),
      );
      // Already minor units: not scaled a second time.
      expect(await column(orders, 'total')).toEqual({
        type: 'bigint',
        value: 1999,
      });
      // The copy is not this run's table.
      expect(await column(orders, 'total', copy)).toEqual({
        type: 'double precision',
        value: 19.99,
      });
    });
  },
);
