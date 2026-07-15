/**
 * Empirical Postgres concurrency test for the change feed (issue #1758).
 *
 * The SQLite suite cannot exercise the MAX(seq)+1 allocation race — SQLite
 * serializes writers, so out-of-order allocation is unreachable there. This
 * optional test races appends across two genuinely concurrent Postgres
 * connections and asserts the analytic guarantee empirically: committed
 * sequences stay contiguous (no gaps, no duplicates) under contention.
 *
 * Runs in the dedicated PostgreSQL CI shard and only when
 * `SMRT_TEST_POSTGRES_URL` is set — point local runs at a DISPOSABLE database
 * (the test deletes all rows from `_smrt_changes` before and after).
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:5432/smrt_test \
 *   npx vitest run src/__tests__/change-feed-concurrency.optional.test.ts
 * ```
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  registerChangeFeedWriter,
} from '../change-feed';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TRANSACTION_WIDGETS_TABLE = 'change_feed_transaction_widgets';

// Keep the decorator argument literal: manifest scanning is static and does
// not resolve constants referenced from decorator metadata.
@smrt({ tableName: 'change_feed_transaction_widgets' })
class ChangeFeedTransactionWidget extends SmrtObject {
  name: string = '';
}

class ChangeFeedTransactionWidgetCollection extends SmrtCollection<ChangeFeedTransactionWidget> {
  static readonly _itemClass = ChangeFeedTransactionWidget;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(!pgUrl)(
  'change feed Postgres concurrency (optional, #1758)',
  () => {
    let writerA: DatabaseInterface;
    let writerB: DatabaseInterface;

    beforeAll(async () => {
      // Distinct dbids → distinct connection pools → genuine concurrency.
      writerA = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-change-feed-a',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      writerB = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-change-feed-b',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

      // Cover initialization with a pre-existing PostgreSQL handle: this path
      // must install the append helper alongside the portable system tables.
      await getTestDatabase({ db: writerA, classes: [] });
      await writerA.query(
        'DROP TRIGGER IF EXISTS issue_2026_assert_feed_failure ON _smrt_changes',
      );
      await writerA.query(
        'DROP FUNCTION IF EXISTS issue_2026_assert_feed_failure()',
      );
      await writerA.query(
        `CREATE TABLE IF NOT EXISTS ${TRANSACTION_WIDGETS_TABLE} (
          id UUID PRIMARY KEY,
          slug TEXT NOT NULL,
          context TEXT NOT NULL DEFAULT '',
          name TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
      );
      await writerA.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${TRANSACTION_WIDGETS_TABLE}_slug_context_idx
         ON ${TRANSACTION_WIDGETS_TABLE} (slug, context)`,
      );
      await writerA.query('DELETE FROM _smrt_changes');
      await writerA.query(`DELETE FROM ${TRANSACTION_WIDGETS_TABLE}`);
      registerChangeFeedWriter();
    });

    afterAll(async () => {
      await writerA?.query(
        'ALTER TABLE _smrt_changes DROP CONSTRAINT IF EXISTS issue_2026_forced_failure',
      );
      await writerA?.query(
        'DROP TRIGGER IF EXISTS issue_2026_assert_feed_failure ON _smrt_changes',
      );
      await writerA?.query(
        'DROP FUNCTION IF EXISTS issue_2026_assert_feed_failure()',
      );
      await writerA?.query('DELETE FROM _smrt_changes');
      await writerA?.query(`DROP TABLE IF EXISTS ${TRANSACTION_WIDGETS_TABLE}`);
      await writerA?.close?.();
      await writerB?.close?.();
    });

    it('racing appends across two connections yields contiguous sequences — no gaps, no duplicates', async () => {
      const PER_WRITER = 150;
      const TOTAL = PER_WRITER * 2;

      const race = async (db: DatabaseInterface, label: string) => {
        for (let i = 0; i < PER_WRITER; i++) {
          await appendChange(db, {
            table: `race_${label}`,
            rowId: `${label}-${i}`,
            operation: 'update',
          });
        }
      };

      await Promise.all([race(writerA, 'a'), race(writerB, 'b')]);

      const raw = rowsOf(
        await writerA.query('SELECT seq FROM _smrt_changes ORDER BY seq ASC'),
      );
      const seqs = raw.map((row) => Number(row.seq));

      // Exactly one committed row per append, contiguous from 1..TOTAL:
      // the allocator's gapless property, observed under real contention.
      expect(seqs).toHaveLength(TOTAL);
      expect(new Set(seqs).size).toBe(TOTAL);
      expect(seqs[0]).toBe(1);
      expect(seqs[seqs.length - 1]).toBe(TOTAL);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBe(seqs[i - 1] + 1);
      }

      // Cursor pagination over the same log observes every change exactly
      // once, matching the SQLite behavioral suite.
      const observed: number[] = [];
      let cursor = 0;
      for (;;) {
        const page = await getChangesSince(writerA, {
          since: cursor,
          limit: 64,
        });
        expect(page.resyncRequired).toBeUndefined();
        observed.push(...page.changes.map((change) => change.seq));
        if (page.cursor === cursor) break;
        cursor = page.cursor;
      }
      expect(observed).toEqual(seqs);
    }, 120_000);

    it('keeps a caller transaction usable when concurrent model writes lose best-effort feed entries', async () => {
      if (!writerA.transaction) {
        throw new Error('Expected PostgreSQL transaction support');
      }

      await writerA.query('DELETE FROM _smrt_changes');
      await writerA.query(`DELETE FROM ${TRANSACTION_WIDGETS_TABLE}`);
      await writerA.query(
        `ALTER TABLE _smrt_changes
         ADD CONSTRAINT issue_2026_forced_failure
         CHECK (table_name <> '${TRANSACTION_WIDGETS_TABLE}')`,
      );

      try {
        let readyTransactions = 0;
        let releaseTransactions!: () => void;
        const transactionsReady = new Promise<void>((resolve) => {
          releaseTransactions = resolve;
        });
        const backendPids = new Set<number>();

        const writeTransaction = async (
          db: DatabaseInterface,
          label: string,
        ) => {
          if (!db.transaction) {
            throw new Error('Expected PostgreSQL transaction support');
          }
          await db.transaction(async (tx) => {
            const widgets = await ChangeFeedTransactionWidgetCollection.create({
              db: tx,
              _reuseInitializedDb: true,
              _deferRuntimeInitialization: true,
            });

            const backend = rowsOf(
              await tx.query('SELECT pg_backend_pid() AS backend_pid'),
            );
            backendPids.add(Number(backend[0]?.backend_pid));
            readyTransactions += 1;
            if (readyTransactions === 2) {
              releaseTransactions();
            }
            await transactionsReady;

            for (let index = 0; index < 4; index++) {
              await widgets.create({ name: `${label}-${index}` });
            }

            // The forced append errors were swallowed under the best-effort
            // contract, but PostgreSQL must not report 25P02 here.
            const probe = rowsOf(
              await tx.query('SELECT 1 AS transaction_still_usable'),
            );
            expect(probe[0]?.transaction_still_usable).toBe(1);
          });
        };

        // Distinct transaction-bound collections race on genuine Postgres
        // connections, matching the concurrent dashboard/OIDC shape in #2026.
        await Promise.all([
          writeTransaction(writerA, 'transaction-a'),
          writeTransaction(writerB, 'transaction-b'),
        ]);
        expect(backendPids.size).toBe(2);

        const committed = rowsOf(
          await writerA.query(
            `SELECT COUNT(*) AS total FROM ${TRANSACTION_WIDGETS_TABLE}`,
          ),
        );
        expect(Number(committed[0]?.total)).toBe(8);

        const droppedFeedRows = rowsOf(
          await writerA.query(
            `SELECT COUNT(*) AS total FROM _smrt_changes
             WHERE table_name = $1`,
            TRANSACTION_WIDGETS_TABLE,
          ),
        );
        expect(Number(droppedFeedRows[0]?.total)).toBe(0);
      } finally {
        await writerA.query(
          'ALTER TABLE _smrt_changes DROP CONSTRAINT IF EXISTS issue_2026_forced_failure',
        );
      }
    }, 120_000);

    it('keeps a caller transaction usable when a blocked feed append hits statement_timeout', async () => {
      if (!writerA.transaction || !writerB.transaction) {
        throw new Error('Expected PostgreSQL transaction support');
      }

      await writerA.query('DELETE FROM _smrt_changes');
      await writerA.query(`DELETE FROM ${TRANSACTION_WIDGETS_TABLE}`);

      let resolveLockReady!: () => void;
      let rejectLockReady!: (error: unknown) => void;
      const lockReady = new Promise<void>((resolve, reject) => {
        resolveLockReady = resolve;
        rejectLockReady = reject;
      });
      let releaseLock!: () => void;
      const lockRelease = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      let blockerError: unknown;
      const blocker = writerB
        .transaction(async (tx) => {
          await tx.query('LOCK TABLE _smrt_changes IN ACCESS EXCLUSIVE MODE');
          resolveLockReady();
          await lockRelease;
        })
        .catch((error: unknown) => {
          blockerError = error;
          rejectLockReady(error);
        });

      await lockReady;
      try {
        await writerA.transaction(async (tx) => {
          await tx.query("SET LOCAL statement_timeout = '100ms'");
          const widgets = await ChangeFeedTransactionWidgetCollection.create({
            db: tx,
            _reuseInitializedDb: true,
            _deferRuntimeInitialization: true,
          });

          await widgets.create({ name: 'statement-timeout' });

          // PL/pgSQL excludes query_canceled from OTHERS, so the helper must
          // catch it explicitly before the interceptor swallows the JS error.
          const probe = rowsOf(
            await tx.query('SELECT 1 AS transaction_still_usable'),
          );
          expect(probe[0]?.transaction_still_usable).toBe(1);
        });
      } finally {
        releaseLock();
        await blocker;
      }
      if (blockerError) throw blockerError;

      const committed = rowsOf(
        await writerA.query(
          `SELECT COUNT(*) AS total FROM ${TRANSACTION_WIDGETS_TABLE}`,
        ),
      );
      expect(Number(committed[0]?.total)).toBe(1);

      const droppedFeedRows = rowsOf(
        await writerA.query(
          `SELECT COUNT(*) AS total FROM _smrt_changes
           WHERE table_name = $1`,
          TRANSACTION_WIDGETS_TABLE,
        ),
      );
      expect(Number(droppedFeedRows[0]?.total)).toBe(0);
    }, 120_000);

    it('keeps a caller transaction usable when a feed trigger raises assert_failure', async () => {
      if (!writerA.transaction) {
        throw new Error('Expected PostgreSQL transaction support');
      }

      await writerA.query('DELETE FROM _smrt_changes');
      await writerA.query(`DELETE FROM ${TRANSACTION_WIDGETS_TABLE}`);
      try {
        await writerA.query(`
          CREATE OR REPLACE FUNCTION issue_2026_assert_feed_failure()
          RETURNS TRIGGER
          LANGUAGE plpgsql
          AS $issue_2026_assert$
          BEGIN
            ASSERT NEW.table_name <> '${TRANSACTION_WIDGETS_TABLE}',
              'forced change-feed assertion failure';
            RETURN NEW;
          END;
          $issue_2026_assert$;
        `);
        await writerA.query(`
          CREATE TRIGGER issue_2026_assert_feed_failure
          BEFORE INSERT ON _smrt_changes
          FOR EACH ROW
          EXECUTE FUNCTION issue_2026_assert_feed_failure()
        `);

        await writerA.transaction(async (tx) => {
          const widgets = await ChangeFeedTransactionWidgetCollection.create({
            db: tx,
            _reuseInitializedDb: true,
            _deferRuntimeInitialization: true,
          });

          await widgets.create({ name: 'assert-failure' });

          const probe = rowsOf(
            await tx.query('SELECT 1 AS transaction_still_usable'),
          );
          expect(probe[0]?.transaction_still_usable).toBe(1);
        });
      } finally {
        await writerA.query(
          'DROP TRIGGER IF EXISTS issue_2026_assert_feed_failure ON _smrt_changes',
        );
        await writerA.query(
          'DROP FUNCTION IF EXISTS issue_2026_assert_feed_failure()',
        );
      }

      const committed = rowsOf(
        await writerA.query(
          `SELECT COUNT(*) AS total FROM ${TRANSACTION_WIDGETS_TABLE}`,
        ),
      );
      expect(Number(committed[0]?.total)).toBe(1);

      const droppedFeedRows = rowsOf(
        await writerA.query(
          `SELECT COUNT(*) AS total FROM _smrt_changes
           WHERE table_name = $1`,
          TRANSACTION_WIDGETS_TABLE,
        ),
      );
      expect(Number(droppedFeedRows[0]?.total)).toBe(0);
    }, 120_000);
  },
);
