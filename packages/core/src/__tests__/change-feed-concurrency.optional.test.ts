/**
 * Empirical Postgres concurrency test for the change feed (issue #1758).
 *
 * The SQLite suite cannot exercise the MAX(seq)+1 allocation race — SQLite
 * serializes writers, so out-of-order allocation is unreachable there. This
 * optional test races appends across two genuinely concurrent Postgres
 * connections and asserts the analytic guarantee empirically: committed
 * sequences stay contiguous (no gaps, no duplicates) under contention.
 *
 * Repo convention: `*.optional.test.ts` requires external services and is
 * skipped in CI. Runs only when `SMRT_TEST_POSTGRES_URL` is set — point it
 * at a DISPOSABLE database (the test deletes all rows from `_smrt_changes`
 * before and after).
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
  ensureChangeFeedTable,
  getChangesSince,
} from '../change-feed';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

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

      await ensureChangeFeedTable(writerA);
      await writerA.query('DELETE FROM _smrt_changes');
    });

    afterAll(async () => {
      await writerA?.query('DELETE FROM _smrt_changes');
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
  },
);
