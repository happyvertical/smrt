/**
 * The v6 change-feed helpers run on PGlite (#5271).
 *
 * PGlite is one session, so the head lock is never contended there, but the
 * same helper bodies are installed: the advisory-lock calls, the feed-table
 * insert lock and the isolation check must all work. Runs under
 * `pnpm test:pglite`; skipped on the default SQLite run.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  appendChanges,
  drainChangeFeed,
  ensureChangeFeedTable,
  getChangesSince,
  resetChangeFeedWarnings,
} from '../change-feed';
import { getTestDatabase } from '../testing/database';

const TABLE = 'issue_5271_pglite_notes';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'change-feed v6 helpers on PGlite (#5271)',
  () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      resetChangeFeedWarnings();
      db = (await getTestDatabase({
        type: 'pglite',
        classes: [],
      })) as DatabaseInterface;
      await ensureChangeFeedTable(db);
    });

    afterEach(async () => {
      await db.close?.();
    });

    it('installs the v6 helpers', async () => {
      const rows = rowsOf(
        await db.query(
          `SELECT bool_and(prosrc LIKE '%smrt-change-feed-helpers:v6%') AS current,
                  count(*)::int AS n
             FROM pg_proc
            WHERE proname IN ('_smrt_append_change', '_smrt_append_changes', '_smrt_drain_changes')`,
        ),
      );
      expect(rows[0]?.current).toBe(true);
      expect(Number(rows[0]?.n)).toBe(4);
    });

    it('appends, batch-appends and drains', async () => {
      expect(await appendChange(db, { table: TABLE, rowId: 'a' })).toBe(1);
      expect(
        await appendChanges(db, [
          { table: TABLE, rowId: 'b' },
          { table: TABLE, rowId: 'c' },
        ]),
      ).toEqual([2, 3]);

      await db.query('BEGIN');
      await db.query('SELECT pg_current_xact_id()');
      expect(await appendChange(db, { table: TABLE, rowId: 'd' })).toBeNull();
      await db.query('COMMIT');
      expect(await drainChangeFeed(db)).toBe(1);

      const page = await getChangesSince(db, { since: 0 });
      expect(page.changes.map((change) => change.rowId)).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
    });

    it('stages under REPEATABLE READ and drains under READ COMMITTED', async () => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      expect(await appendChange(db, { table: TABLE, rowId: 'rr' })).toBeNull();
      await db.query('COMMIT');
      expect(await drainChangeFeed(db)).toBe(1);
      const page = await getChangesSince(db, { since: 0 });
      expect(page.changes.map((change) => change.rowId)).toEqual(['rr']);
    });
  },
);
