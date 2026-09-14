/**
 * PostgreSQL isolated-test system bootstrap contract for issue #2429.
 *
 * Transaction handles intentionally bypass SmrtClass's connection bootstrap.
 * The isolated factory therefore has to provision every framework-owned
 * system table on the base connection before opening the transaction.
 */

import { randomUUID } from 'node:crypto';
import { createDispatchBus, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { createIsolatedTestDb } from '../test-db.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

const tableSuffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tableName = `issue_2429_widget_${tableSuffix}`;

class Issue2429Widget extends SmrtObject {
  name: string = '';
}
smrt({ tableName })(Issue2429Widget);

postgresDescribe('PostgreSQL isolated system-table bootstrap (#2429)', () => {
  it('keeps context and embedding cascade cleanup transaction-safe', async () => {
    const result = await createIsolatedTestDb({
      schema: `CREATE TABLE "${tableName}" (
        id UUID PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp,
        name TEXT,
        UNIQUE (slug, context)
      )`,
      prefix: 'issue-2429-cascade',
    });

    try {
      const tableResult = await result.db.query(
        `SELECT to_regclass('_smrt_contexts') AS contexts,
                to_regclass('_smrt_embeddings') AS embeddings`,
      );
      const tableRows = Array.isArray(tableResult)
        ? tableResult
        : ((
            tableResult as {
              rows?: Array<{
                contexts: string | null;
                embeddings: string | null;
              }>;
            }
          ).rows ?? []);
      expect(tableRows[0]).toEqual({
        contexts: '_smrt_contexts',
        embeddings: '_smrt_embeddings',
      });

      const widget = new Issue2429Widget({ db: result.db, name: 'cascade' });
      await widget.initialize();
      await widget.save();

      await result.db.insert('_smrt_contexts', {
        id: randomUUID(),
        owner_class: 'Issue2429Widget',
        owner_id: widget.id,
        scope: 'test',
        key: 'context',
        value: '{}',
      });
      await result.db.insert('_smrt_embeddings', {
        id: randomUUID(),
        object_class: 'Issue2429Widget',
        object_id: widget.id,
        field_name: 'name',
        content_hash: 'issue-2429',
        embedding: '[]',
        model: 'test',
        dimensions: 0,
      });

      await expect(widget.delete()).resolves.toBeUndefined();
      expect(
        await result.db.count('_smrt_contexts', { owner_id: widget.id }),
      ).toBe(0);
      expect(
        await result.db.count('_smrt_embeddings', { object_id: widget.id }),
      ).toBe(0);
      await expect(
        result.db.query('SELECT 1 AS transaction_ok'),
      ).resolves.toBeDefined();
    } finally {
      try {
        if (result.db.isActive()) await result.db.rollback();
        await result.baseDb.query(`DROP TABLE IF EXISTS "${tableName}"`);
      } finally {
        await result.cleanup();
      }
    }
  });

  it('initializes dispatch without poisoning the isolated transaction', async () => {
    const result = await createIsolatedTestDb({
      prefix: 'issue-2429-dispatch',
    });

    try {
      // #2861 review Finding 3: `result.db` is already an open transaction.
      // `runSerializedAgainstSystemTableBootstrap()` must not wrap it in a
      // savepoint to take the bootstrap advisory lock, because PostgreSQL
      // scopes `pg_advisory_xact_lock`/`SET LOCAL` to the transaction, not
      // the savepoint — doing so would leak the lock hold and the raised
      // 300s lock_timeout/statement_timeout budget into this transaction
      // for its entire remaining life, stalling any other bootstrap-lock
      // waiter. Recorded before `createDispatchBus()` so a regression shows
      // up as a changed value, not an absent baseline.
      const timeoutsBefore = rowsOf(
        await result.db.query('SHOW lock_timeout'),
      )[0];
      const statementTimeoutBefore = rowsOf(
        await result.db.query('SHOW statement_timeout'),
      )[0];

      const bus = await createDispatchBus({ db: result.db });
      const dispatch = await bus.emit(
        'issue-2429.transaction-probe',
        { ready: true },
        { source: 'smrt-vitest' },
      );
      expect(await result.db.count('_smrt_dispatch', { id: dispatch.id })).toBe(
        1,
      );
      await expect(
        result.db.query('SELECT 1 AS transaction_ok'),
      ).resolves.toBeDefined();

      expect(rowsOf(await result.db.query('SHOW lock_timeout'))[0]).toEqual(
        timeoutsBefore,
      );
      expect(
        rowsOf(await result.db.query('SHOW statement_timeout'))[0],
      ).toEqual(statementTimeoutBefore);

      // The bootstrap lock is legitimately held for the rest of this
      // transaction (`runSerializedAgainstSystemTableBootstrap()` takes
      // `pg_advisory_xact_lock` directly on `result.db` since it is already
      // inside a transaction — see bootstrap.ts's `isOpenTransactionHandle`
      // branch) — it auto-releases only at commit/rollback, which
      // `result.cleanup()` performs below. That is what makes it real
      // mutual exclusion instead of a no-op: two callers each holding their
      // own open transaction still need this to serialize.
      const [expectedKey] = rowsOf(
        await result.db.query(
          "SELECT hashtext('smrt')::int4::text AS classid, hashtext('system-tables')::int4::text AS objid",
        ),
      );
      const heldLocks = rowsOf(
        await result.db.query(
          "SELECT classid::int4::text AS classid, objid::int4::text AS objid FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
        ),
      );
      expect(heldLocks).toEqual([expectedKey]);
    } finally {
      await result.cleanup();
    }
  });
});
