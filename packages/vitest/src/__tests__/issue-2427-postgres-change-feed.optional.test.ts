/**
 * PostgreSQL isolated-test bootstrap contract for issue #2427.
 *
 * The isolated factory applies schema before opening its transaction. SMRT
 * objects treat that transaction handle as already initialized, so the factory
 * must also provision the PostgreSQL change-feed helper their writes require.
 */

import { randomUUID } from 'node:crypto';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDb } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

const tableSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tableName = `issue_2427_widget_${tableSuffix}`;

class Issue2427Widget extends SmrtObject {
  name: string = '';
}
smrt({ tableName })(Issue2427Widget);

postgresDescribe('PostgreSQL isolated change-feed bootstrap (#2427)', () => {
  it('provisions the append helper before the first transaction-scoped write', async () => {
    const result = await createIsolatedTestDb({
      schema: `CREATE TABLE "${tableName}" (
        id UUID PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        name TEXT,
        UNIQUE (slug, context)
      )`,
      prefix: 'issue-2427-change-feed',
    });

    try {
      const helperResult = await result.db.query(
        `SELECT to_regprocedure(
          '_smrt_append_change(text,text,text,text,timestamp with time zone)'
        ) AS helper`,
      );
      const helperRows = Array.isArray(helperResult)
        ? helperResult
        : ((helperResult as { rows?: Array<{ helper: string | null }> }).rows ??
          []);
      expect(helperRows[0]).toEqual(
        expect.objectContaining({ helper: expect.any(String) }),
      );

      const widget = new Issue2427Widget({
        db: result.db,
        name: 'first transaction-scoped write',
      });
      await widget.initialize();
      await expect(widget.save()).resolves.toBeDefined();

      const feedResult = await result.db.query(
        'SELECT seq, table_name FROM _smrt_changes ORDER BY seq ASC',
      );
      const feedRows = Array.isArray(feedResult)
        ? feedResult
        : ((feedResult as { rows?: Array<Record<string, unknown>> }).rows ??
          []);
      expect(feedRows).toEqual([
        expect.objectContaining({ seq: '1', table_name: tableName }),
      ]);

      // A missing helper raises 42883 and aborts the surrounding transaction.
      // This probe proves the write succeeded without leaving it in 25P02.
      await expect(
        result.db.query('SELECT 1 AS transaction_ok'),
      ).resolves.toBeDefined();

      await result.db.rollback();
      await result.baseDb.query(`DROP TABLE IF EXISTS "${tableName}"`);
    } finally {
      await result.cleanup();
    }
  });
});
