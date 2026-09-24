/**
 * #3110 on PostgreSQL: ergot's dashboard test databases failed in
 * `getTestDatabase` because the planner counted a report collection as a
 * second owner of its model's table. Named `*.optional.test.ts` so the
 * package's `test:postgres` script runs it; it skips itself without
 * PostgreSQL.
 */
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REPORT_TABLE,
  registerConsumerReportCollection,
} from './helpers/consumer-report-collection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres(
  'report collection table ownership on PostgreSQL (#3110)',
  () => {
    beforeEach(() => {
      ObjectRegistry.clear();
      registerConsumerReportCollection();
    });
    afterEach(() => ObjectRegistry.clear());

    it('migrates a test database with the report model and its collection', async () => {
      const db = await getTestDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        classes: ['UsageDailyReport'],
      });
      try {
        const id = crypto.randomUUID();
        await db.insert(REPORT_TABLE, {
          id,
          slug: id,
          day: '2026-09-24',
          unit: 'seconds',
          total: 42,
        });
        const { rows } = await db.query(
          `SELECT total FROM ${REPORT_TABLE} WHERE id = ?`,
          id,
        );
        expect(rows.map((row) => Number(row.total))).toEqual([42]);
      } finally {
        await db.query(`DROP TABLE IF EXISTS ${REPORT_TABLE}`);
        await db.close?.();
      }
    }, 60_000);
  },
);
