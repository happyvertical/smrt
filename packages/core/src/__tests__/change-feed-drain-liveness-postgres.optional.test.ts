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
  getTableVersion,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
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
  baseUrl = pgUrl as string,
): Promise<DatabaseInterface> {
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
    await settleChangeFeedDrainers();
    await setup.query('TRUNCATE _smrt_changes, _smrt_changes_pending');
  });

  afterEach(async () => {
    stopChangeFeedDrainers();
    await settleChangeFeedDrainers();
  });

  /** Poll `check` until it is true or `ms` pass; resolves to the last value. */
  async function eventually(
    check: () => Promise<boolean>,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Run `count` connections appending directly in tight loops until stopped. */
  async function directAppendLoad(
    count: number,
  ): Promise<{ stop: () => Promise<number> }> {
    const handles: DatabaseInterface[] = [];
    for (let i = 0; i < count; i += 1) handles.push(await connect(`load-${i}`));
    let running = true;
    let appended = 0;
    const loops = handles.map(async (handle, index) => {
      for (let n = 0; running; n += 1) {
        try {
          await appendChange(handle, {
            table: FEED_TABLE,
            rowId: `load-${index}-${n}`,
          });
          appended += 1;
        } catch {
          // A dropped direct append is not what these cases measure.
        }
      }
    });
    return {
      stop: async () => {
        running = false;
        await Promise.all(loops);
        for (const handle of handles) await handle.close?.();
        return appended;
      },
    };
  }

  async function stageManyCommitted(n: number): Promise<void> {
    await runTransaction(setup, async (tx) => {
      await tx.query('SELECT pg_current_xact_id()');
      for (let i = 0; i < n; i += 1) {
        expect(
          await appendChange(tx, { table: FEED_TABLE, rowId: `bulk-${i}` }),
        ).toBeNull();
      }
    });
  }

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

  it('a waiting drain sequences behind a held and queued head that a try never gets', async () => {
    const head = await holdHead();
    await stageCommitted('staged-wait');
    // Another session queues for the head behind the holder. It calls the
    // append helper directly, not appendChange(): appendChange's own
    // write-path drain would report the busy head and start that handle's
    // background drainer, which would then wait for the head ahead of the
    // drain under test and sequence the staged row itself.
    const queued = connect('queued').then(async (handle) => {
      try {
        const rows = rowsOf(
          await handle.query(
            `SELECT allocated_seq, error_code, error_message
               FROM _smrt_append_change($1, 'queued', 'update', NULL, now())`,
            FEED_TABLE,
          ),
        );
        if (rows[0]?.error_code != null) {
          throw new Error(String(rows[0]?.error_message));
        }
        return Number(rows[0]?.allocated_seq);
      } finally {
        await handle.close?.();
      }
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await drainChangeFeed(reader)).toBe(0);
      // The try handed the backlog to the reader's drainer; this case
      // measures the explicit waiting drain alone.
      stopChangeFeedDrainers();
      const waiting = drainChangeFeed(reader, { wait: true });
      setTimeout(() => {
        void head.release();
      }, 300);
      const startedAt = Date.now();
      expect(await waiting).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(2_500);
      expect(await queued).toEqual(expect.any(Number));
      expect(await pendingCount()).toBe(0);
    } finally {
      await head.release();
      await queued.catch(() => undefined);
    }
  }, 30_000);

  it('a waiting drain empties a backlog while four connections keep appending directly', async () => {
    const load = await directAppendLoad(4);
    try {
      await stageManyCommitted(200);
      const emptied = await eventually(async () => {
        await drainChangeFeed(setup, { wait: true });
        return (await pendingCount()) === 0;
      }, 15_000);
      expect(emptied).toBe(true);
    } finally {
      expect(await load.stop()).toBeGreaterThan(0);
    }
  }, 60_000);

  it('the root drainer empties a backlog another process left, while this process only appends directly', async () => {
    // Staged and committed elsewhere: no kick from this process.
    for (let i = 0; i < 50; i += 1) {
      await setup.query(
        `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
         VALUES ($1, $2, 'update', now())`,
        FEED_TABLE,
        `elsewhere-${i}`,
      );
    }
    const load = await directAppendLoad(4);
    try {
      const emptied = await eventually(
        async () => (await pendingCount()) === 0,
        20_000,
      );
      expect(emptied).toBe(true);
    } finally {
      await load.stop();
    }
  }, 60_000);

  it('a timed-out waiting pass holds nothing and leaves lock_timeout as the caller set it', async () => {
    const head = await holdHead();
    await stageCommitted('staged-timeout');
    let readerPid = 0;
    let status: Record<string, unknown> | undefined;
    let lockTimeout: unknown;
    let elapsed = 0;
    const read = await holdTransaction(reader, async (tx) => {
      readerPid = await backendPid(tx);
      await tx.query(`SET LOCAL lock_timeout = '9s'`);
      const startedAt = Date.now();
      const rows = rowsOf(
        await tx.query(
          `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{"waitMs":300}'::jsonb)`,
        ),
      );
      elapsed = Date.now() - startedAt;
      status = rows.at(-1);
      lockTimeout = rowsOf(await tx.query('SHOW lock_timeout'))[0]
        ?.lock_timeout;
    });
    try {
      expect(status).toMatchObject({
        status: 'timeout',
        error_code: null,
        backlog_remaining: true,
      });
      expect(elapsed).toBeLessThan(1_500);
      expect(lockTimeout).toBe('9s');
      expect(await drainLocksHeldBy(readerPid)).toEqual([]);
    } finally {
      await head.release();
      await read.release();
    }
  }, 30_000);

  it('a waiting pass gives up within its budget when the staging table is locked', async () => {
    const maintenance = await holdTransaction(holder, async (tx) => {
      await tx.query(
        'LOCK TABLE _smrt_changes_pending IN ACCESS EXCLUSIVE MODE',
      );
    });
    try {
      const startedAt = Date.now();
      const rows = rowsOf(
        await reader.query(
          `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{"waitMs":300}'::jsonb)`,
        ),
      );
      expect(rows.at(-1)).toMatchObject({
        status: 'timeout',
        error_code: null,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      await maintenance.release();
    }
  }, 30_000);

  it('a column-grant role takes the feed-table lock before the head and skips holding nothing behind a SHARE holder', async () => {
    const role = `drain_col_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = randomUUID();
    const columns = 'seq, table_name, row_id, operation, tenant_id, created_at';
    await setup.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    let limited: DatabaseInterface | undefined;
    try {
      await setup.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);
      await setup.query(`GRANT SELECT ON _smrt_changes TO ${role}`);
      await setup.query(
        `GRANT INSERT (${columns}) ON _smrt_changes TO ${role}`,
      );
      await setup.query(
        `GRANT SELECT, INSERT, DELETE ON _smrt_changes_pending TO ${role}`,
      );
      await setup.query(
        `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${SCHEMA} TO ${role}`,
      );
      const url = new URL(pgUrl as string);
      url.username = role;
      url.password = password;
      limited = await connect('column-grant', '', url.toString());
      await stageCommitted('staged-column');

      // A SHARE holder that then appends: the drain must not take the head
      // and then wait behind it.
      const shareReady = deferred();
      const appendNow = deferred();
      let shareOutcome: unknown;
      const share = runTransaction(holder, async (tx) => {
        await tx.query('LOCK TABLE _smrt_changes IN SHARE MODE');
        shareReady.resolve();
        await appendNow.promise;
        const rows = rowsOf(
          await tx.query(
            `SELECT allocated_seq, error_code FROM _smrt_append_change($1, 'share', 'update', NULL, now())`,
            FEED_TABLE,
          ),
        );
        shareOutcome = rows[0];
      });
      await shareReady.promise;
      const rows = rowsOf(
        await limited.query(
          `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '{"waitMs":1000}'::jsonb)`,
        ),
      );
      expect(rows.at(-1)).toMatchObject({ status: 'relation_busy' });
      appendNow.resolve();
      await share;
      // The holder's own append was not chosen as a deadlock victim.
      expect(shareOutcome).toMatchObject({ error_code: null });
      // With the SHARE lock gone, the same role drains.
      expect(await drainChangeFeed(limited, { wait: true })).toBe(1);
    } finally {
      await limited?.close?.();
      await setup.query(
        `REVOKE ALL ON _smrt_changes, _smrt_changes_pending FROM ${role}`,
      );
      await setup.query(
        `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${SCHEMA} FROM ${role}`,
      );
      await setup.query(`REVOKE USAGE ON SCHEMA ${SCHEMA} FROM ${role}`);
      await setup.query(`DROP ROLE ${role}`);
    }
  }, 60_000);

  it('a root whose default isolation is REPEATABLE READ drains through its own READ COMMITTED transaction', async () => {
    const fixed = await connect(
      'fixed-snapshot',
      '%20-c%20default_transaction_isolation%3Drepeatable%5C%20read',
    );
    try {
      await stageCommitted('staged-fixed');
      expect(await drainChangeFeed(fixed)).toBe(0);
      const emptied = await eventually(
        async () => (await pendingCount()) === 0,
        10_000,
      );
      expect(emptied).toBe(true);
    } finally {
      await fixed.close?.();
    }
  }, 30_000);

  it('a root’s first feed call starts a pass that sequences an earlier backlog', async () => {
    const fresh = await connect('fresh');
    try {
      await setup.query(
        `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
         VALUES ($1, 'from-before', 'update', now())`,
        FEED_TABLE,
      );
      await getTableVersion(fresh, FEED_TABLE);
      await settleChangeFeedDrainers();
      expect(await pendingCount()).toBe(0);
    } finally {
      await fresh.close?.();
    }
  }, 30_000);
});
