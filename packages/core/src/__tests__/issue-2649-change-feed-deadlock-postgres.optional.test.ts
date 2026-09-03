/**
 * PostgreSQL change-feed append must not deadlock a caller transaction (#2649).
 *
 * `_smrt_append_change` allocated `COALESCE(MAX(seq), 0) + 1`, so two appends
 * that picked the same value conflicted on the primary key and the loser waited
 * for the *winner's whole transaction* to end. A long write transaction that
 * appended and then kept taking row locks therefore formed a real lock cycle
 * with any writer that took those row locks first and then appended;
 * PostgreSQL aborted one side with `40P01`. Found downstream in
 * willgriffin/willgriffin.dev#457, where an ordinary concurrent request could
 * abort a legitimate board-reconciliation transaction.
 *
 * The fix stages appends made inside a caller transaction and sequences them
 * after commit, so the wait — and therefore the cycle — is gone. The first two
 * cases here are the downstream reproduction, run against BOTH allocators:
 * the pre-fix function (which must still deadlock, proving the reproduction is
 * faithful) and the shipped one (which must not).
 *
 * The remaining cases pin the property a naive "just use a SEQUENCE" fix would
 * break: a cursor reader must never advance past an entry whose transaction
 * commits later than a higher-numbered one's.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`), which is NOT PR-triggered — see `.github/CI.md`.
 *
 * @example
 * ```bash
 * SMRT_TEST_POSTGRES_URL=postgres://user:pass@localhost:55998/smrt \
 *   npx vitest run src/__tests__/issue-2649-change-feed-deadlock-postgres.optional.test.ts
 * ```
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  drainChangeFeed,
  ensureChangeFeedTable,
  ensurePostgresChangeFeedAppendFunction,
  getChangesSince,
  getTableVersion,
  resetChangeFeedWarnings,
} from '../change-feed';
import { type ChangeSignal, subscribeToChangeSignals } from '../change-signals';
import { ensureSystemTables } from '../system/bootstrap';
import { POSTGRES_CHANGE_FEED_HELPER_MARKER } from '../system/schema';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

/**
 * Every connection this suite opens is pinned to its own PostgreSQL schema.
 *
 * The `test:postgres` shard points every `*.optional.test.ts` file at ONE
 * database and Vitest runs those files in parallel, so `_smrt_changes`, the
 * append helper and the staging table would otherwise be shared with suites
 * writing to them concurrently. This suite reasons about exact sequences and
 * deliberately installs a pre-fix helper that deadlocks — both of which need
 * the feed to itself, in both directions: a sibling suite must not perturb
 * these sequences, and it must not be made to run against the pre-fix helper
 * either. `options=-c search_path=…` applies to every connection in the pool,
 * so the unqualified names in the framework's own SQL resolve here.
 */
const SCHEMA = 'issue_2649_change_feed';
const ROWS_TABLE = 'issue_2649_rows';
const FEED_TABLE = 'issue_2649_feed_subject';
const ROW_A = '44444444-4444-4444-8444-444444444444';
const ROW_B = '55555555-5555-4555-8555-555555555555';

/**
 * The allocator exactly as it shipped before this fix: always direct, always
 * `MAX(seq) + 1`, no staging. Installed to prove the reproduction below really
 * does provoke `40P01` — a test that only ever ran against the fix could not
 * tell a fixed defect from a reproduction that stopped reproducing.
 */
const PRE_FIX_APPEND_FUNCTION = `
CREATE OR REPLACE FUNCTION _smrt_append_change(
  p_table_name TEXT,
  p_row_id TEXT,
  p_operation TEXT,
  p_tenant_id TEXT,
  p_created_at TIMESTAMPTZ
)
RETURNS TABLE(allocated_seq BIGINT, error_code TEXT, error_message TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
AS $pre_fix$
DECLARE
  v_seq BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
    SELECT COALESCE(MAX(changes.seq), 0) + 1, p_table_name, p_row_id, p_operation, p_tenant_id, p_created_at
    FROM _smrt_changes AS changes
    RETURNING _smrt_changes.seq INTO v_seq;
    RETURN QUERY SELECT v_seq, NULL::TEXT, NULL::TEXT;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS
      v_error_code = RETURNED_SQLSTATE,
      v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::BIGINT, v_error_code, v_error_message;
  END;
END;
$pre_fix$;
`;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function isDeadlock(error: unknown): boolean {
  if (String((error as { code?: unknown })?.code) === '40P01') return true;
  return /deadlock detected/i.test(String((error as Error)?.message ?? ''));
}

async function connect(label: string): Promise<DatabaseInterface> {
  // Distinct dbids → distinct pools → genuinely concurrent connections.
  const separator = (pgUrl as string).includes('?') ? '&' : '?';
  return (await getDatabase({
    type: 'postgres',
    url: `${pgUrl}${separator}options=-c%20search_path%3D${SCHEMA}`,
    dbid: `smrt-test-2649-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

function runTransaction(
  handle: DatabaseInterface,
  run: (tx: DatabaseInterface) => Promise<void>,
): Promise<unknown> {
  const transaction = handle.transaction;
  if (typeof transaction !== 'function') {
    throw new Error('This spec requires a transactional PostgreSQL handle.');
  }
  return transaction.call(handle, run as never);
}

/** Wait until some backend is blocked on a lock while running `sql`. */
async function waitUntilBlocked(
  observer: DatabaseInterface,
  sql: string,
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = rowsOf(
      await observer.query(
        `SELECT count(*)::int AS blocked
           FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND query LIKE $1`,
        `%${sql}%`,
      ),
    );
    if (Number(rows[0]?.blocked ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a connection blocked on: ${sql}`);
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change-feed append deadlock (optional, #2649)', () => {
  let setup: DatabaseInterface;
  let crawl: DatabaseInterface;
  let owner: DatabaseInterface;
  let observer: DatabaseInterface;

  beforeAll(async () => {
    // The schema has to exist before any pinned connection resolves.
    const admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2649-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);

    setup = await connect('setup');
    crawl = await connect('crawl');
    owner = await connect('owner');
    observer = await connect('observer');

    await setup.query(`DROP TABLE IF EXISTS ${ROWS_TABLE} CASCADE`);
    await setup.query(
      `CREATE TABLE ${ROWS_TABLE} (
           id UUID PRIMARY KEY,
           status TEXT NOT NULL DEFAULT 'found',
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
    );
    await ensureChangeFeedTable(setup);
  }, 120_000);

  afterAll(async () => {
    // The whole schema goes, helpers and all — nothing this suite installed
    // (least of all the pre-fix helper) may outlive it on a shared shard.
    await setup?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  beforeEach(async () => {
    await setup.query('DELETE FROM _smrt_changes');
    await setup.query('DELETE FROM _smrt_changes_pending');
    await setup.query(`DELETE FROM ${ROWS_TABLE}`);
    for (const id of [ROW_A, ROW_B]) {
      await setup.query(
        `INSERT INTO ${ROWS_TABLE} (id, status) VALUES ($1, 'found')`,
        id,
      );
    }
    await ensurePostgresChangeFeedAppendFunction(setup, {
      replaceExisting: true,
    });
    // The append path's drain interval is process state; clear it so these
    // cases do not inherit a neighbour's timestamp.
    resetChangeFeedWarnings();
  });

  /**
   * Downstream case 1: the long transaction takes row locks, then appends;
   * a concurrent request appends, then touches one of those rows.
   */
  async function driveRowLockThenAppendCycle(): Promise<string[]> {
    const crawlHoldsRowLock = deferred();
    const ownerHoldsSeq = deferred();

    const crawlSide = runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'stale' WHERE id = $1`,
        ROW_A,
      );
      crawlHoldsRowLock.resolve();
      await ownerHoldsSeq.promise;
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    })
      .then(() => 'ok')
      .catch((error: unknown) => {
        if (isDeadlock(error)) return 'deadlock';
        throw error;
      });

    const ownerSide = runTransaction(owner, async (tx) => {
      await crawlHoldsRowLock.promise;
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
      ownerHoldsSeq.resolve();
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'recommended' WHERE id = $1`,
        ROW_A,
      );
    })
      .then(() => 'ok')
      .catch((error: unknown) => {
        if (isDeadlock(error)) return 'deadlock';
        throw error;
      });

    await crawlHoldsRowLock.promise;
    await ownerHoldsSeq.promise;
    await waitUntilBlocked(observer, `UPDATE ${ROWS_TABLE} SET status`);
    return Promise.all([crawlSide, ownerSide]);
  }

  /**
   * Downstream case 2: both sides use the framework's own order — write the
   * row, then append — and the cycle still forms, because the long
   * transaction keeps taking row locks after it has appended. This is what
   * ruled out "just order the locks consistently" as a downstream fix.
   */
  async function driveFrameworkOrderCycle(): Promise<string[]> {
    const crawlLockedFirstRow = deferred();
    const ownerLockedSecondRow = deferred();
    const crawlAppended = deferred();

    const crawlSide = runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'stale' WHERE id = $1`,
        ROW_A,
      );
      crawlLockedFirstRow.resolve();
      await ownerLockedSecondRow.promise;
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
      crawlAppended.resolve();
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'archived' WHERE id = $1`,
        ROW_B,
      );
    })
      .then(() => 'ok')
      .catch((error: unknown) => {
        if (isDeadlock(error)) return 'deadlock';
        throw error;
      });

    const ownerSide = runTransaction(owner, async (tx) => {
      await crawlLockedFirstRow.promise;
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'recommended' WHERE id = $1`,
        ROW_B,
      );
      ownerLockedSecondRow.resolve();
      await crawlAppended.promise;
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_B,
        operation: 'update',
      });
    })
      .then(() => 'ok')
      .catch((error: unknown) => {
        if (isDeadlock(error)) return 'deadlock';
        throw error;
      });

    return Promise.all([crawlSide, ownerSide]);
  }

  it('reproduces the pre-fix cycle: row locks then append', async () => {
    await setup.query(PRE_FIX_APPEND_FUNCTION);
    const outcomes = await driveRowLockThenAppendCycle();
    expect(outcomes).toContain('deadlock');
  }, 120_000);

  it('reproduces the pre-fix cycle in the framework write order', async () => {
    await setup.query(PRE_FIX_APPEND_FUNCTION);
    const outcomes = await driveFrameworkOrderCycle();
    expect(outcomes).toContain('deadlock');
  }, 120_000);

  it('no longer deadlocks: row locks then append', async () => {
    const outcomes = await driveRowLockThenAppendCycle();
    expect(outcomes).toEqual(['ok', 'ok']);

    // Both entries are durable and become visible after a drain.
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => change.table)).toEqual([
      FEED_TABLE,
      FEED_TABLE,
    ]);
  }, 120_000);

  it('no longer deadlocks in the framework write order', async () => {
    const outcomes = await driveFrameworkOrderCycle();
    expect(outcomes).toEqual(['ok', 'ok']);
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes).toHaveLength(2);
  }, 120_000);

  it('stages a transactional append and shares the caller transaction fate', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'stale' WHERE id = $1`,
        ROW_A,
      );
      // Staged, not sequenced: no cursor exists for it yet.
      expect(
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_A,
          operation: 'update',
        }),
      ).toBeNull();
    });

    // ...and a rolled-back transaction leaves nothing behind.
    await expect(
      runTransaction(owner, async (tx) => {
        await tx.query(
          `UPDATE ${ROWS_TABLE} SET status = 'gone' WHERE id = $1`,
          ROW_B,
        );
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_B,
          operation: 'delete',
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const drained = await drainChangeFeed(setup);
    expect(drained).toBe(1);
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => change.rowId)).toEqual([ROW_A]);
  }, 120_000);

  /**
   * The documented residual: an append issued as a transaction's *first*
   * statement still allocates inline, because the transaction has no id yet
   * and therefore holds no row locks. It can make another direct appender
   * wait for this transaction to commit — but it cannot be part of a cycle,
   * because anything that could wait on this transaction's row locks must
   * have taken its own row locks first, and would therefore have staged.
   */
  it('still allocates inline for an append made before the first write', async () => {
    await runTransaction(crawl, async (tx) => {
      expect(
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_A,
          operation: 'update',
        }),
      ).toBe(1);
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'after' WHERE id = $1`,
        ROW_A,
      );
    });
  }, 120_000);

  /**
   * A read inside a caller transaction drains on that transaction's own
   * handle, so the rows it sequences are visible only there and vanish if it
   * rolls back. Serving them would report changes that never committed and
   * hand back a cursor above sequences a concurrent autocommit appender then
   * claims for its own entries — a permanently skipped change. The page must
   * therefore stop below anything the read's own drain allocated.
   */
  it('never serves entries its own in-transaction drain just sequenced', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    // A read wrapped in the caller's own transaction, which then rolls back.
    await expect(
      runTransaction(owner, async (tx) => {
        const page = await getChangesSince(tx, { since: 0 });
        expect(page.changes).toEqual([]);
        expect(page.cursor).toBe(0);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The entry is untouched by that rollback and still arrives exactly once.
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => change.rowId)).toEqual([ROW_A]);
    expect(page.changes[0].seq).toBe(1);
  }, 120_000);

  /**
   * The hold-back has to span the transaction, not the drain call. A caller
   * that reads twice on one open transaction drains only on the first call —
   * the server-side helper refuses once the transaction has an id — yet the
   * transaction still sees those uncommitted rows, so a call-scoped hold-back
   * would serve them on the second read and hand back a cursor above sequences
   * a rollback releases for reuse.
   */
  it('holds back an earlier drain on every later read of the same transaction', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    await expect(
      runTransaction(owner, async (tx) => {
        // First read drains; second and third read nothing new but must not
        // start serving what the first one wrote.
        for (const attempt of [1, 2, 3]) {
          const page = await getChangesSince(tx, { since: 0 });
          expect({
            attempt,
            changes: page.changes,
            cursor: page.cursor,
          }).toEqual({ attempt, changes: [], cursor: 0 });
        }
        // An explicit drain on the same handle behaves the same way.
        await drainChangeFeed(tx);
        const after = await getChangesSince(tx, { since: 0 });
        expect(after.changes).toEqual([]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => change.rowId)).toEqual([ROW_A]);
  }, 120_000);

  /**
   * A live `_events` subscriber resumes from the `Last-Event-ID` of the last
   * signal it saw, so a sequenced entry that is never signalled while a LATER
   * one is gets skipped for good. Every drained entry must therefore be
   * signalled, ahead of the append that follows it.
   */
  it('signals every drained entry before the append that outranks it', async () => {
    const seen: ChangeSignal[] = [];
    const unsubscribe = subscribeToChangeSignals(setup, (signal) => {
      seen.push(signal);
    });
    try {
      await runTransaction(crawl, async (tx) => {
        await tx.query(
          `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
          ROW_A,
        );
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_A,
          operation: 'update',
        });
      });
      // Staged: durable, but no sequence and therefore no signal yet.
      expect(seen).toEqual([]);

      // An ordinary autocommit append drains first, so the staged entry is
      // sequenced at 1 before this append takes 2. Taking the DIRECT path
      // proves that drain committed — a drain that allocated anything assigns
      // a transaction id, and this append saw none — so its signal is
      // published here, ahead of the seq the interceptor publishes for this
      // append once the call returns. Ascending, with no gap for a
      // subscriber's Last-Event-ID to jump.
      expect(
        await appendChange(setup, {
          table: FEED_TABLE,
          rowId: ROW_B,
          operation: 'create',
        }),
      ).toBe(2);
      expect(seen.map((signal) => [signal.seq, signal.rowId])).toEqual([
        [1, ROW_A],
      ]);

      // Nothing is left queued for a later drain to republish.
      await drainChangeFeed(setup);
      expect(seen.map((signal) => [signal.seq, signal.rowId])).toEqual([
        [1, ROW_A],
      ]);
    } finally {
      unsubscribe();
    }
  }, 120_000);

  /**
   * A drain that runs as the first statement of a caller transaction has not
   * committed. Signalling from there advertises sequences a rollback releases
   * for a concurrent appender to reuse, so a subscriber would hold a
   * `Last-Event-ID` naming somebody else's entry.
   */
  it('publishes no signal for a drain that has not committed', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    const seen: ChangeSignal[] = [];
    const unsubscribe = subscribeToChangeSignals(setup, (signal) => {
      seen.push(signal);
    });
    try {
      await expect(
        runTransaction(owner, async (tx) => {
          // First statement of the transaction, so the helper permits the
          // drain — but it is uncommitted, so nothing may be signalled.
          await drainChangeFeed(tx);
          expect(seen).toEqual([]);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(seen).toEqual([]);

      // The next committed drain is what signals it.
      await drainChangeFeed(setup);
      expect(seen.map((signal) => signal.rowId)).toEqual([ROW_A]);
    } finally {
      unsubscribe();
    }
  }, 120_000);

  /**
   * The ETag version must never regress. Reading the sequenced maximum and the
   * staged count in two statements lets a drain land between them, counting the
   * same entry twice and minting a version a later write re-mints — a false 304
   * against changed data.
   */
  it('keeps the table version monotonic across a drain', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    const staged = await getTableVersion(setup, FEED_TABLE);
    await drainChangeFeed(setup);
    const sequenced = await getTableVersion(setup, FEED_TABLE);
    expect(sequenced).toBeGreaterThanOrEqual(staged);
    // Draining moves the entry from the staged term to the sequenced one, so
    // the sum is unchanged rather than double-counted then reduced.
    expect(sequenced).toBe(staged);
  }, 120_000);

  /**
   * A database already stamped with the current system schema version takes
   * bootstrap's fast return, so nothing else would ever replace the pre-#2649
   * append helper — ordinary model writes do not call `ensureChangeFeedTable`.
   * Such a deployment would keep the deadlock after upgrading the package.
   */
  it('repairs the helpers on a database already stamped with this schema version', async () => {
    // Wind the database back to how a pre-#2649 install looks.
    await setup.query(PRE_FIX_APPEND_FUNCTION);
    await setup.query('DROP FUNCTION IF EXISTS _smrt_drain_changes(integer)');
    await setup.query('DROP TABLE IF EXISTS _smrt_changes_pending');

    const before = rowsOf(
      await setup.query(
        `SELECT to_regclass('_smrt_changes_pending') AS pending,
                to_regprocedure('_smrt_drain_changes(integer)') AS drain`,
      ),
    );
    expect(before[0]?.pending).toBeFalsy();
    expect(before[0]?.drain).toBeFalsy();

    // The version row is already present, so bootstrap takes its fast return.
    await ensureSystemTables(setup);

    const after = rowsOf(
      await setup.query(
        `SELECT to_regclass('_smrt_changes_pending') AS pending,
                to_regprocedure('_smrt_drain_changes(integer)') AS drain`,
      ),
    );
    expect(after[0]?.pending).toBeTruthy();
    expect(after[0]?.drain).toBeTruthy();

    // ...and the repaired helper stages instead of allocating inline.
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'repaired' WHERE id = $1`,
        ROW_A,
      );
      expect(
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_A,
          operation: 'update',
        }),
      ).toBeNull();
    });
  }, 120_000);

  /**
   * Suppressing an unproven drain's signals must not lose them. Once its
   * transaction commits, those rows are no longer staged, so no later drain
   * would ever return them again — and an entry that is never signalled while
   * a later one is is exactly the `Last-Event-ID` skip being guarded against.
   */
  it('signals a committed in-transaction drain once it can prove the commit', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    const seen: ChangeSignal[] = [];
    const unsubscribe = subscribeToChangeSignals(owner, (signal) => {
      seen.push(signal);
    });
    try {
      // Drains as the first statement of a caller transaction, so the commit
      // is not yet provable and the signal is queued, not published.
      await runTransaction(owner, async (tx) => {
        await drainChangeFeed(tx);
        expect(seen).toEqual([]);
      });
      expect(seen).toEqual([]);

      // The next drain on that handle settles the queue: the sequence still
      // carries the row it was drained for, so the signal is published.
      await drainChangeFeed(owner);
      expect(seen.map((signal) => signal.rowId)).toEqual([ROW_A]);
      expect(seen.map((signal) => signal.seq)).toEqual([1]);
    } finally {
      unsubscribe();
    }
  }, 120_000);

  /**
   * The queue is claimed before the first await precisely so two drains racing
   * on one database cannot both verify and publish the same entries — the
   * signal sequence is an SSE event id, and a duplicate id is a duplicate
   * live event for every subscriber.
   */
  it('publishes a queued signal once when two drains race', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    const seen: ChangeSignal[] = [];
    const unsubscribe = subscribeToChangeSignals(owner, (signal) => {
      seen.push(signal);
    });
    try {
      // Queue the signal from a drain that cannot prove its commit...
      await runTransaction(owner, async (tx) => {
        await drainChangeFeed(tx);
      });
      expect(seen).toEqual([]);

      // ...then settle it from two concurrent flushes on the same handle.
      await Promise.all([drainChangeFeed(owner), drainChangeFeed(owner)]);
      expect(seen.map((signal) => [signal.seq, signal.rowId])).toEqual([
        [1, ROW_A],
      ]);
    } finally {
      unsubscribe();
    }
  }, 120_000);

  /**
   * A rolled-back drain frees its sequences for somebody else, so its queued
   * signals must never be published against whatever now occupies them. They
   * are withheld rather than discarded: the queue is shared by every
   * connection to the database, so "I cannot see it" may simply mean another
   * connection's transaction is still open.
   */
  it('never publishes a queued signal against a sequence somebody else took', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    const seen: ChangeSignal[] = [];
    const unsubscribe = subscribeToChangeSignals(owner, (signal) => {
      seen.push(signal);
    });
    try {
      await expect(
        runTransaction(owner, async (tx) => {
          await drainChangeFeed(tx);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      // A different entry claims the freed sequence before the queue is
      // settled — written directly so the drain order stays deterministic.
      await setup.query(
        `INSERT INTO _smrt_changes
           (seq, table_name, row_id, operation, tenant_id, created_at)
         VALUES (1, $1, $2, 'create', NULL, now())`,
        FEED_TABLE,
        ROW_B,
      );

      await drainChangeFeed(owner);
      // The rolled-back entry is re-sequenced at 2 and signalled there; the
      // stale queue entry for seq 1 is never published against ROW_B.
      expect(seen.map((signal) => [signal.seq, signal.rowId])).toEqual([
        [2, ROW_A],
      ]);
    } finally {
      unsubscribe();
    }
  }, 120_000);

  /**
   * Existence is not currency. A database can hold helpers of the right name
   * and signature whose *bodies* predate a fix; probing only for existence
   * would call them current and never replace them — leaving the deadlock in
   * place on exactly the deployment this repair exists for.
   */
  it('replaces a helper whose body is stale even when all three objects exist', async () => {
    // Keep the staging table and drain helper; downgrade only the append body.
    await setup.query(PRE_FIX_APPEND_FUNCTION);
    const before = rowsOf(
      await setup.query(
        `SELECT to_regclass('_smrt_changes_pending') AS pending,
                to_regprocedure('_smrt_drain_changes(integer)') AS drain,
                (SELECT prosrc LIKE '%' || $1 || '%'
                   FROM pg_proc
                  WHERE oid = to_regprocedure(
                    '_smrt_append_change(text,text,text,text,timestamp with time zone)'
                  )) AS current`,
        POSTGRES_CHANGE_FEED_HELPER_MARKER,
      ),
    );
    expect(before[0]?.pending).toBeTruthy();
    expect(before[0]?.drain).toBeTruthy();
    expect(before[0]?.current).toBe(false);

    await ensureSystemTables(setup);

    const after = rowsOf(
      await setup.query(
        `SELECT (SELECT prosrc LIKE '%' || $1 || '%'
                   FROM pg_proc
                  WHERE oid = to_regprocedure(
                    '_smrt_append_change(text,text,text,text,timestamp with time zone)'
                  )) AS current`,
        POSTGRES_CHANGE_FEED_HELPER_MARKER,
      ),
    );
    expect(after[0]?.current).toBe(true);

    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'repaired' WHERE id = $1`,
        ROW_A,
      );
      expect(
        await appendChange(tx, {
          table: FEED_TABLE,
          rowId: ROW_A,
          operation: 'update',
        }),
      ).toBeNull();
    });
  }, 120_000);

  /**
   * An append made as a transaction's first statement allocates inline (the
   * documented residual), so that sequence is this transaction's uncommitted
   * work just as a drain's would be. A read on the same handle must not serve
   * it: a rollback frees the sequence, another entry claims it, and a poller
   * resuming from the cursor this read handed back would skip that entry.
   */
  it('never serves a direct allocation made inside the caller transaction', async () => {
    await expect(
      runTransaction(owner, async (tx) => {
        // First statement of the transaction: allocates inline.
        expect(
          await appendChange(tx, {
            table: FEED_TABLE,
            rowId: ROW_A,
            operation: 'update',
          }),
        ).toBe(1);

        const page = await getChangesSince(tx, { since: 0 });
        expect(page.changes).toEqual([]);
        expect(page.cursor).toBe(0);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The freed sequence goes to the next entry, and a poller starting from
    // the cursor that read handed back still sees it.
    expect(
      await appendChange(setup, {
        table: FEED_TABLE,
        rowId: ROW_B,
        operation: 'create',
      }),
    ).toBe(1);
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => [change.seq, change.rowId])).toEqual([
      [1, ROW_B],
    ]);
  }, 120_000);

  /**
   * Foreign-cursor detection has to reason about the committed horizon too. A
   * cursor above everything committed must be told to resync; deciding that
   * against a horizon inflated by this transaction's own uncommitted drain
   * would wave it through, and a rollback then leaves it pointing past an
   * entry it never received.
   */
  it('flags a cursor ahead of the committed horizon from inside a transaction', async () => {
    await runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'staged' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'update',
      });
    });

    await expect(
      runTransaction(owner, async (tx) => {
        // Drains as this transaction's first write, so seq 1 exists only here.
        const page = await getChangesSince(tx, { since: 1 });
        expect(page.resyncRequired).toBe(true);
        expect(page.cursor).toBe(1);
        expect(page.resyncCursor).toBe(0);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // The staged entry survives and is served normally afterwards.
    const page = await getChangesSince(setup, { since: 0 });
    expect(page.changes.map((change) => change.rowId)).toEqual([ROW_A]);
  }, 120_000);

  /**
   * The hazard a plain `SEQUENCE`/identity allocator would introduce.
   *
   * Sequence values are handed out before commit and never roll back, so a
   * reader ordering by `seq` could see the later-allocated entry committed
   * while the earlier one was still in flight, advance its cursor past it,
   * and miss it forever. Here the *later* appender commits FIRST and a
   * cursor reader polls in between: it must still observe both entries,
   * exactly once each.
   */
  it('never lets a cursor reader skip an entry whose transaction commits last', async () => {
    const earlyAppended = deferred();
    const lateCommitted = deferred();
    const earlyMayCommit = deferred();

    const early = runTransaction(crawl, async (tx) => {
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'early' WHERE id = $1`,
        ROW_A,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_A,
        operation: 'create',
      });
      earlyAppended.resolve();
      // Commit only after the later appender has committed AND a reader has
      // polled the feed.
      await earlyMayCommit.promise;
    });

    const late = runTransaction(owner, async (tx) => {
      await earlyAppended.promise;
      await tx.query(
        `UPDATE ${ROWS_TABLE} SET status = 'late' WHERE id = $1`,
        ROW_B,
      );
      await appendChange(tx, {
        table: FEED_TABLE,
        rowId: ROW_B,
        operation: 'create',
      });
    }).then(() => lateCommitted.resolve());

    await lateCommitted.promise;

    // A poller runs while the early transaction is still open. It may see
    // the late entry; it must never be handed a cursor that skips the early
    // one when that finally commits.
    const observed: number[] = [];
    let cursor = 0;
    const firstPage = await getChangesSince(observer, { since: cursor });
    observed.push(...firstPage.changes.map((change) => change.seq));
    cursor = firstPage.cursor;

    earlyMayCommit.resolve();
    await early;
    await late;

    for (;;) {
      const page = await getChangesSince(observer, { since: cursor });
      expect(page.resyncRequired).toBeUndefined();
      observed.push(...page.changes.map((change) => change.seq));
      if (page.cursor === cursor) break;
      cursor = page.cursor;
    }

    const rows = rowsOf(
      await setup.query(
        'SELECT seq, row_id FROM _smrt_changes ORDER BY seq ASC',
      ),
    );
    expect(rows).toHaveLength(2);
    // Contiguous from 1 — the gapless invariant a raw SEQUENCE would lose.
    expect(rows.map((row) => Number(row.seq))).toEqual([1, 2]);
    // Every committed entry observed exactly once by the cursor reader.
    expect(observed).toEqual([1, 2]);
    expect(new Set(rows.map((row) => String(row.row_id)))).toEqual(
      new Set([ROW_A, ROW_B]),
    );
  }, 120_000);

  it('keeps sequences contiguous and lossless under mixed concurrent writers', async () => {
    const PER_WRITER = 40;

    const transactional = async (
      db: DatabaseInterface,
      label: string,
    ): Promise<void> => {
      for (let index = 0; index < PER_WRITER; index++) {
        await runTransaction(db, async (tx) => {
          await tx.query(
            `UPDATE ${ROWS_TABLE} SET status = $2 WHERE id = $1`,
            index % 2 === 0 ? ROW_A : ROW_B,
            `${label}-${index}`,
          );
          expect(
            await appendChange(tx, {
              table: FEED_TABLE,
              rowId: `${label}-${index}`,
              operation: 'update',
            }),
          ).toBeNull();
        });
      }
    };

    const autocommit = async (db: DatabaseInterface): Promise<void> => {
      for (let index = 0; index < PER_WRITER; index++) {
        const seq = await appendChange(db, {
          table: FEED_TABLE,
          rowId: `auto-${index}`,
          operation: 'update',
        });
        // Autocommit appends keep allocating their sequence inline.
        expect(typeof seq).toBe('number');
      }
    };

    await Promise.all([
      transactional(crawl, 'crawl'),
      transactional(owner, 'owner'),
      autocommit(setup),
    ]);

    await drainChangeFeed(setup);

    const seqs = rowsOf(
      await setup.query('SELECT seq FROM _smrt_changes ORDER BY seq ASC'),
    ).map((row) => Number(row.seq));

    expect(seqs).toHaveLength(PER_WRITER * 3);
    expect(seqs[0]).toBe(1);
    for (let index = 1; index < seqs.length; index++) {
      expect(seqs[index]).toBe(seqs[index - 1] + 1);
    }

    const observed: number[] = [];
    let cursor = 0;
    for (;;) {
      const page = await getChangesSince(observer, {
        since: cursor,
        limit: 17,
      });
      expect(page.resyncRequired).toBeUndefined();
      observed.push(...page.changes.map((change) => change.seq));
      if (page.cursor === cursor) break;
      cursor = page.cursor;
    }
    expect(observed).toEqual(seqs);
  }, 180_000);
});
