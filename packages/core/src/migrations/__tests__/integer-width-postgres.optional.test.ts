/**
 * PostgreSQL integration coverage for the explicit #2424 int4 → int8 pass.
 *
 * This suite runs only in the disposable PostgreSQL lane started by
 * `scripts/run-with-ci-postgres.mjs`. It verifies the real table rewrite,
 * durable BackfillTracker marker, and safe rerun behavior that SQLite cannot
 * exercise.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BackfillTracker } from '../backfill-tracker.js';
import {
  preflightIntegerWidthWidening,
  widenIntegerColumnsToBigInt,
} from '../integer-width.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const prefix = `i2424_${randomUUID().slice(0, 8)}`;
const table = `${prefix}_invoices`;
const backfillName = `test:integer-width:${prefix}:v1`;

postgresDescribe('int4 → bigint widening on real PostgreSQL (#2424)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2424-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);
  });

  afterEach(async () => {
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
    await db.query('DELETE FROM _smrt_backfills WHERE name = ?', backfillName);
  });

  afterAll(async () => {
    await db.close?.();
  });

  it('preflights and widens once, then persists its idempotency marker', async () => {
    await db.query(`CREATE TABLE "${table}" (amount INTEGER)`);
    await db.query(`INSERT INTO "${table}" (amount) VALUES (1), (2)`);

    const targets = [{ table, columns: ['amount'] }];
    const preflight = await preflightIntegerWidthWidening(db, targets, {
      engineHint: 'postgres',
    });
    expect(preflight.tables).toContainEqual(
      expect.objectContaining({
        table,
        rowCount: 2,
        columns: [
          expect.objectContaining({
            column: 'amount',
            declaredType: 'integer',
            state: 'pending',
          }),
        ],
      }),
    );

    const first = await widenIntegerColumnsToBigInt(db, targets, {
      engineHint: 'postgres',
      backfillName,
    });
    expect(first).toMatchObject({
      ran: true,
      widenedColumns: [{ table, column: 'amount' }],
    });
    const column = await db.query(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ?
          AND column_name = 'amount'`,
      table,
    );
    expect(String(column.rows[0]?.data_type).toLowerCase()).toBe('bigint');
    expect(await new BackfillTracker({ db }).isApplied(backfillName)).toBe(
      true,
    );

    await expect(
      widenIntegerColumnsToBigInt(db, targets, {
        engineHint: 'postgres',
        backfillName,
      }),
    ).resolves.toMatchObject({
      ran: false,
      widenedColumns: [],
      statements: [],
    });
  });
});
