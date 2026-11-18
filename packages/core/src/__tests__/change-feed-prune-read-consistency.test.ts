/**
 * `getChangesSince` reads the retained floor and the page in separate
 * statements. A retention prune that commits between them must never let the
 * read advance a cursor past rows it deleted: the consumer is told to resync.
 *
 * The interleave is forced deterministically: the handle passed to
 * `getChangesSince` runs `pruneChangeFeed` on the real handle right after the
 * bounds statement returns, modelling a retention sweep on another connection
 * landing between the two statements.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { getTestDatabase } from '../testing/database';

const TABLE = 'prune_read_items';

/** Wrap `db` so a prune runs once, immediately after the bounds read. */
function pruneAfterBoundsRead(
  db: DatabaseInterface,
  maxRows: number,
): { handle: DatabaseInterface; pruned: () => number } {
  let fired = false;
  let prunedCount = 0;
  const handle = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'query' && typeof value === 'function') {
        return async (sql: string, ...args: unknown[]) => {
          const result = await value.call(target, sql, ...args);
          if (!fired && /MAX\(seq\) AS horizon/.test(sql)) {
            fired = true;
            prunedCount = (await pruneChangeFeed(target, { maxRows })).pruned;
          }
          return result;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { handle, pruned: () => prunedCount };
}

describe('getChangesSince stays consistent with a concurrent prune', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    await getChangesSince(db, { since: 0 }); // ensures the feed table
    for (let i = 1; i <= 15; i++) {
      await appendChange(db, { table: TABLE, rowId: `r${i}` });
    }
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('answers resyncRequired when rows after the cursor are pruned between the bounds and page reads', async () => {
    const { handle, pruned } = pruneAfterBoundsRead(db, 5);
    const page = await getChangesSince(handle, { since: 3 });
    expect(pruned()).toBe(10);
    expect(page.resyncRequired).toBe(true);
    expect(page.changes).toEqual([]);
    expect(page.cursor).toBe(3);
    expect(page.resyncCursor).toBe(15);
  });

  it('answers resyncRequired for a limited page whose start was pruned mid-read', async () => {
    const { handle } = pruneAfterBoundsRead(db, 5);
    const page = await getChangesSince(handle, { since: 1, limit: 3 });
    expect(page.resyncRequired).toBe(true);
    expect(page.changes).toEqual([]);
  });

  it('still serves the page when the concurrent prune removed nothing after the cursor', async () => {
    // maxRows 13 prunes seq 1..2 only; a cursor at 3 lost nothing.
    const { handle, pruned } = pruneAfterBoundsRead(db, 13);
    const page = await getChangesSince(handle, { since: 3 });
    expect(pruned()).toBe(2);
    expect(page.resyncRequired).toBeUndefined();
    expect(page.changes.map((change) => change.seq)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(page.cursor).toBe(15);
  });

  it('serves an ordinary read unchanged when no prune intervenes', async () => {
    const page = await getChangesSince(db, { since: 10 });
    expect(page.resyncRequired).toBeUndefined();
    expect(page.changes.map((change) => change.seq)).toEqual([
      11, 12, 13, 14, 15,
    ]);
  });
});
