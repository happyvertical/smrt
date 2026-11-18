/**
 * A feed read on the root database never serves a change-feed row that a
 * framework transaction has inserted but not yet committed.
 *
 * `_events` streams read the feed from the root handle at any moment — a
 * heartbeat re-read, a short-read retry, a new connection's catch-up — so a
 * read that saw an uncommitted row could frame its sequence and then skip
 * the real change that reuses that sequence after a rollback.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { publishChangeSignal, resetChangeSignals } from '../change-signals';
import {
  runOutsideWriteContext,
  withEmbeddedWriteTransaction,
} from '../embedded-write-queue';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const TABLE = 'uncommitted_visibility_items';

const cases = [
  { engine: 'sqlite', file: false },
  { engine: 'sqlite', file: true },
  { engine: 'duckdb', file: false },
  { engine: 'duckdb', file: true },
] as const;

for (const { engine, file } of cases) {
  describe(`feed reads do not see uncommitted rows (${engine}, ${file ? 'file' : ':memory:'})`, () => {
    let db: DatabaseInterface | undefined;
    let dir: string | undefined;

    afterEach(async () => {
      resetChangeSignals();
      await db?.close?.();
      if (dir) rmSync(dir, { recursive: true, force: true });
      db = undefined;
      dir = undefined;
    });

    async function openRoot(): Promise<DatabaseInterface> {
      registerChangeFeedWriter();
      resetChangeFeedWarnings();
      resetChangeSignals();
      if (file) dir = mkdtempSync(join(tmpdir(), 'smrt-uncommitted-'));
      const root = await getTestDatabase({
        type: engine,
        url: dir
          ? join(dir, `feed.${engine === 'sqlite' ? 'db' : 'duckdb'}`)
          : ':memory:',
        classes: [],
      });
      db = root;
      await getChangesSince(root, { since: 0 });
      return root;
    }

    it('a read from another request waits for the transaction and serves no rolled-back row', async () => {
      const root = await openRoot();
      let concurrentRead: Promise<number[]> | undefined;
      await expect(
        withEmbeddedWriteTransaction(root, true, async (tx) => {
          await appendChange(tx, { table: TABLE, rowId: 'uncommitted' });
          // Another request's read on the root, issued while the
          // transaction is open (outside its async context).
          concurrentRead = runOutsideWriteContext(() =>
            getChangesSince(root, { since: 0 }).then((page) =>
              page.changes.map((change) => change.seq),
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await concurrentRead).toEqual([]);

      const real = await appendChange(root, { table: TABLE, rowId: 'real' });
      const after = await getChangesSince(root, { since: 0 });
      expect(after.changes.map((change) => [change.seq, change.rowId])).toEqual(
        [[real, 'real']],
      );
    });

    it('a read inside the transaction still sees its own uncommitted row', async () => {
      const root = await openRoot();
      await withEmbeddedWriteTransaction(root, true, async (tx) => {
        await appendChange(tx, { table: TABLE, rowId: 'own' });
        const page = await getChangesSince(root, { since: 0 });
        expect(page.changes.map((change) => change.rowId)).toEqual(['own']);
      });
    });

    it('an _events stream woken during the transaction frames only the committed change', async () => {
      const root = await openRoot();
      const stream = buildChangeEventStream(root, {
        cursor: 0,
        tenantScope: { enforced: false, tenantId: null },
      });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      await reader.read(); // retry preamble
      await expect(
        withEmbeddedWriteTransaction(root, true, async (tx) => {
          const seq = (await appendChange(tx, {
            table: TABLE,
            rowId: 'uncommitted',
          })) as number;
          // A wake-up while the row is uncommitted (as from a write the
          // framework does not manage, or a heartbeat re-read).
          publishChangeSignal(root, {
            table: TABLE,
            operation: 'update',
            rowId: 'uncommitted',
            tenantId: null,
            seq,
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      const seq = (await appendChange(root, {
        table: TABLE,
        rowId: 'real',
      })) as number;
      publishChangeSignal(root, {
        table: TABLE,
        operation: 'update',
        rowId: 'real',
        tenantId: null,
        seq,
      });
      let text = '';
      const deadline = Date.now() + 2000;
      while (!text.includes('"real"') && Date.now() < deadline) {
        const result = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), 500),
          ),
        ]);
        if (result === 'timeout' || result.done) continue;
        text += decoder.decode(result.value, { stream: true });
      }
      await reader.cancel();
      expect(text).not.toContain('"rowId":"uncommitted"');
      expect(text).toContain(`id: ${seq}\nevent: change`);
      expect(text).toContain('"real"');
    });
  });
}
