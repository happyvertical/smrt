/**
 * A write made inside a framework transaction announces its live change
 * signal only after the transaction commits, and never when it rolls back.
 *
 * On SQLite and DuckDB the feed sequence is allocated inside the transaction,
 * so a rollback frees it for the next write; a signal published before the
 * commit would carry a sequence that later names a different change, and a
 * client that dedupes by sequence would drop that real change.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class AfterCommitItem extends SmrtObject {
  name: string = '';
}
class AfterCommitItemCollection extends SmrtCollection<AfterCommitItem> {
  static readonly _itemClass = AfterCommitItem;
}

const ITEMS = 'after_commit_items';

for (const engine of ['sqlite', 'duckdb'] as const) {
  describe(`live change signals follow the commit (${engine})`, () => {
    let db: DatabaseInterface;
    let dir: string;
    let received: ChangeSignal[];

    beforeEach(async () => {
      registerChangeFeedWriter();
      resetChangeFeedWarnings();
      resetChangeSignals();
      // A file database: the transaction's handle and the root share one
      // signal scope, as in a deployment.
      dir = mkdtempSync(join(tmpdir(), 'smrt-after-commit-'));
      db = await getTestDatabase({
        type: engine,
        url: join(dir, `feed.${engine === 'sqlite' ? 'db' : 'duckdb'}`),
        classes: ['AfterCommitItem'],
      });
      received = [];
      subscribeToChangeSignals(db, (signal) => received.push(signal));
    });

    afterEach(async () => {
      resetChangeSignals();
      await db.close?.();
      rmSync(dir, { recursive: true, force: true });
    });

    it('publishes nothing for a rolled-back write, so its freed sequence is not announced twice', async () => {
      const items = await AfterCommitItemCollection.create({ db });
      const doomed = new AfterCommitItem({ db, name: 'doomed' });
      await doomed.initialize();
      await expect(
        doomed.withTransaction(async (bound) => {
          await bound.save();
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(received).toEqual([]);

      const kept = await items.create({ name: 'kept' });
      const { changes } = await getChangesSince(db, { since: 0 });
      expect(changes.map((change) => change.rowId)).toEqual([kept.id]);
      expect(received.map((signal) => [signal.seq, signal.rowId])).toEqual([
        [changes[0].seq, kept.id],
      ]);
    });

    it('publishes a committed write after the commit, not during the transaction', async () => {
      const item = new AfterCommitItem({ db, name: 'committed' });
      await item.initialize();
      let seenInside = -1;
      await item.withTransaction(async (bound) => {
        await bound.save();
        seenInside = received.length;
      });
      expect(seenInside).toBe(0);
      expect(received.map((signal) => [signal.table, signal.rowId])).toEqual([
        [ITEMS, item.id],
      ]);
    });

    it('defers a write through the root handle made inside the transaction, and drops it on rollback', async () => {
      const items = await AfterCommitItemCollection.create({ db });
      const anchorItem = new AfterCommitItem({ db, name: 'anchor' });
      await anchorItem.initialize();
      let seenInside = -1;
      await expect(
        anchorItem.withTransaction(async (bound) => {
          await bound.save();
          // A second object bound to the root, not the transaction handle.
          await items.create({ name: 'root-bound' });
          seenInside = received.length;
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(seenInside).toBe(0);
      expect(received).toEqual([]);
      // The root-bound write shared the transaction and rolled back with it.
      expect((await getChangesSince(db, { since: 0 })).changes).toEqual([]);
      expect(await items.list({})).toEqual([]);

      let seenInsideCommit = -1;
      await anchorItem.withTransaction(async (bound) => {
        await bound.save();
        await items.create({ name: 'root-bound-committed' });
        seenInsideCommit = received.length;
      });
      expect(seenInsideCommit).toBe(0);
      expect(received).toHaveLength(2);
      const { changes } = await getChangesSince(db, { since: 0 });
      expect(received.map((signal) => signal.seq)).toEqual(
        changes.map((change) => change.seq),
      );
    });

    it('still publishes an autocommit write immediately', async () => {
      const items = await AfterCommitItemCollection.create({ db });
      const item = await items.create({ name: 'plain' });
      expect(received.map((signal) => signal.rowId)).toEqual([item.id]);
    });
  });
}
