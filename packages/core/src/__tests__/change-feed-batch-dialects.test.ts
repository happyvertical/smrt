/** Direct batch-feed parity on the embedded engines. */
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendChanges,
  ensureChangeFeedTable,
  getChangesSince,
} from '../change-feed.js';

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`${type} direct change-feed batches`, () => {
    let db: Awaited<ReturnType<typeof getDatabase>> | undefined;

    afterEach(async () => {
      await db?.close?.();
      db = undefined;
    });

    it('allocates one contiguous ordered feed row per input in one append statement', async () => {
      db = await getDatabase({ type, url: ':memory:', dbid: randomUUID() });
      await ensureChangeFeedTable(db);
      const query = vi.spyOn(db, 'query');
      const sequences = await appendChanges(db, [
        { table: 'batch_subjects', rowId: 'a', operation: 'create' },
        { table: 'batch_subjects', rowId: 'b', operation: 'update' },
        { table: 'batch_subjects', rowId: 'c', operation: 'delete' },
      ]);
      expect(query).toHaveBeenCalledTimes(1);
      query.mockRestore();
      expect(sequences).toEqual([1, 2, 3]);
      expect(
        (await getChangesSince(db, { since: 0 })).changes.map((change) => [
          change.seq,
          change.rowId,
          change.operation,
        ]),
      ).toEqual([
        [1, 'a', 'create'],
        [2, 'b', 'update'],
        [3, 'c', 'delete'],
      ]);
    });

    it.skipIf(type !== 'duckdb')(
      'uses DuckDB JSON string extraction on a committed transaction handle',
      async () => {
        db = await getDatabase({
          type: 'duckdb',
          url: ':memory:',
          dbid: randomUUID(),
        });
        await ensureChangeFeedTable(db);
        await db.transaction(async (tx) => {
          expect(
            await appendChanges(tx, [
              { table: 'batch_subjects', rowId: 'tx-a', operation: 'create' },
              { table: 'batch_subjects', rowId: 'tx-b', operation: 'update' },
            ]),
          ).toEqual([1, 2]);
        });
        expect(
          (await getChangesSince(db, { since: 0 })).changes.map((change) => [
            change.rowId,
            change.operation,
          ]),
        ).toEqual([
          ['tx-a', 'create'],
          ['tx-b', 'update'],
        ]);
      },
    );
  });
}
