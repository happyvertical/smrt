/**
 * PostgreSQL change-feed drain liveness (#5402, #5403).
 *
 * A drain pass that finds no work — the head busy, the feed table's insert
 * lock refused, nothing staged — now keeps none of the locks it took, even as
 * the first statement of a caller transaction, so it can no longer block every
 * other drain until that transaction ends (#5402).
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`). Every connection is pinned to this suite's own
 * schema; the head lock is keyed on the feed table, so sibling suites in other
 * schemas never share it.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  appendChange,
  drainChangeFeed,
  ensureChangeFeedTable,
  resetChangeFeedWarnings,
} from '../change-feed';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const SCHEMA = 'change_feed_drain_liveness';
const FEED_TABLE = 'drain_liveness_subject';

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

const applicationNames = new WeakMap<DatabaseInterface, string>();

async function connect(
  label: string,
  extraOptions = '',
): Promise<DatabaseInterface> {
  const baseUrl = pgUrl as string;
  const separator = baseUrl.includes('?') ? '&' : '?';
  const applicationName = `smrtdrain_${label}_${randomUUID().slice(0, 8)}`;
  const handle = (await getDatabase({
    type: 'postgres',
    url:
      `${baseUrl}${separator}options=-c%20search_path%3D${SCHEMA}${extraOptions}` +
      `&application_name=${applicationName}`,
    dbid: `smrt-test-drain-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  applicationNames.set(handle, applicationName);
  return handle;
}

async function backendPid(tx: DatabaseInterface): Promise<number> {
  return Number(
    rowsOf(await tx.query('SELECT pg_backend_pid() AS pid'))[0]?.pid,
  );
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

/**
 * Hold a transaction open on `handle` after `start` ran in it, until the
 * returned `release` is called. Resolves once `start` finished.
 */
async function holdTransaction(
  handle: DatabaseInterface,
  start: (tx: DatabaseInterface) => Promise<void>,
): Promise<{ pid: number; release: () => Promise<void> }> {
  const started = deferred<number>();
  const release = deferred();
  const done = runTransaction(handle, async (tx) => {
    const pid = await backendPid(tx);
    await start(tx);
    started.resolve(pid);
    await release.promise;
  });
  const pid = await Promise.race([
    started.promise,
    done.then(() => {
      throw new Error('transaction ended before it was held');
    }),
  ]);
  return {
    pid,
    release: async () => {
      release.resolve();
      await done;
    },
  };
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change-feed drain liveness (optional, #5402, #5403)', () => {
  let setup: DatabaseInterface;
  let observer: DatabaseInterface;
  let holder: DatabaseInterface;
  let reader: DatabaseInterface;

  async function pendingCount(): Promise<number> {
    return Number(
      rowsOf(
        await setup.query(
          'SELECT count(*)::int AS n FROM _smrt_changes_pending',
        ),
      )[0]?.n ?? 0,
    );
  }

  /** Stage one entry from a transaction that has already written, then commit. */
  async function stageCommitted(rowId: string): Promise<void> {
    await runTransaction(setup, async (tx) => {
      await tx.query('SELECT pg_current_xact_id()');
      expect(await appendChange(tx, { table: FEED_TABLE, rowId })).toBeNull();
    });
  }

  /** Hold the head of the log: a transaction whose first statement appends. */
  function holdHead(): Promise<{ pid: number; release: () => Promise<void> }> {
    return holdTransaction(holder, async (tx) => {
      const rows = rowsOf(
        await tx.query(
          `SELECT allocated_seq, error_code, error_message
             FROM _smrt_append_change($1, 'held', 'update', NULL, now())`,
          FEED_TABLE,
        ),
      );
      if (rows[0]?.error_code != null) {
        throw new Error(String(rows[0]?.error_message));
      }
    });
  }

  /** Locks a backend holds that a drain pass takes. */
  async function drainLocksHeldBy(pid: number): Promise<string[]> {
    const rows = rowsOf(
      await observer.query(
        `SELECT CASE
                  WHEN locktype = 'advisory'
                       AND classid::bigint = (hashtext('smrt')::bigint & 4294967295)
                       AND objid::bigint = (hashtext('change-feed-drain')::bigint & 4294967295)
                    THEN 'drain'
                  WHEN locktype = 'advisory'
                       AND classid::bigint = (hashtext('smrt-change-feed-head')::bigint & 4294967295)
                    THEN 'head'
                  WHEN relation = to_regclass('_smrt_changes')
                       AND mode = 'RowExclusiveLock'
                    THEN 'feed-row-exclusive'
                END AS lock
           FROM pg_locks
          WHERE pid = $1 AND granted`,
        pid,
      ),
    );
    return rows
      .map((row) => row.lock)
      .filter((lock): lock is string => typeof lock === 'string')
      .sort();
  }

  beforeAll(async () => {
    const admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-drain-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.close?.();

    setup = await connect('setup');
    observer = await connect('observer');
    holder = await connect('holder');
    reader = await connect('reader');
    await ensureChangeFeedTable(setup);
  });

  afterAll(async () => {
    for (const handle of [setup, observer, holder, reader]) {
      await handle?.close?.();
    }
  });

  beforeEach(async () => {
    resetChangeFeedWarnings();
    await setup.query('TRUNCATE _smrt_changes, _smrt_changes_pending');
  });

  afterEach(async () => {
    expect(await pendingCount()).toBeGreaterThanOrEqual(0);
  });

  it('a skipped pass on a busy head keeps no drain lock inside the caller transaction', async () => {
    const head = await holdHead();
    await stageCommitted('staged-1');
    let readerPid = 0;
    const read = await holdTransaction(reader, async (tx) => {
      readerPid = await backendPid(tx);
      expect(await drainChangeFeed(tx)).toBe(0);
    });
    try {
      expect(await drainLocksHeldBy(readerPid)).toEqual([]);
      await head.release();
      // Another connection drains while the reader's transaction is open.
      expect(await drainChangeFeed(setup)).toBe(1);
      expect(await pendingCount()).toBe(0);
    } finally {
      await head.release().catch(() => {});
      await read.release();
    }
  });

  it('a skipped pass on a refused feed-table lock keeps no drain lock either', async () => {
    const share = await holdTransaction(holder, async (tx) => {
      await tx.query('LOCK TABLE _smrt_changes IN SHARE MODE');
    });
    await stageCommitted('staged-2');
    let readerPid = 0;
    const read = await holdTransaction(reader, async (tx) => {
      readerPid = await backendPid(tx);
      expect(await drainChangeFeed(tx)).toBe(0);
    });
    try {
      expect(await drainLocksHeldBy(readerPid)).toEqual([]);
      await share.release();
      expect(await drainChangeFeed(setup)).toBe(1);
    } finally {
      await share.release().catch(() => {});
      await read.release();
    }
  });

  it('reports busy statuses from the status drain and releases what the pass took', async () => {
    const head = await holdHead();
    await stageCommitted('staged-3');
    let readerPid = 0;
    let status: unknown;
    const read = await holdTransaction(reader, async (tx) => {
      readerPid = await backendPid(tx);
      const rows = rowsOf(
        await tx.query(
          `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{}'::jsonb)`,
        ),
      );
      status = rows.at(-1);
    });
    try {
      expect(status).toMatchObject({
        status: 'head_busy',
        backlog_remaining: true,
      });
      expect(await drainLocksHeldBy(readerPid)).toEqual([]);
    } finally {
      await head.release();
      await read.release();
    }
  });
});
