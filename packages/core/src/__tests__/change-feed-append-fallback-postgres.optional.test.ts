/**
 * A direct change-feed append that fails on contention is staged, not
 * dropped (PostgreSQL, #5438).
 *
 * A direct append that times out waiting for the head of the log (`55P03`),
 * loses a deadlock (`40P01`) or hits a duplicate on the feed's own sequence
 * key is staged in the same statement and returns the staged marker; the
 * next drain sequences it. A cancelled statement (`57014`) is still an error.
 * Staging is skipped — the original error returned — when the tenant id would
 * not convert to the feed table's live column type (it would block every
 * drain behind it), or when the staging table cannot be locked at once.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`), pinned to this suite's own schema.
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
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const SCHEMA = 'change_feed_append_fallback';
const FEED_TABLE = 'append_fallback_subject';

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

async function connect(label: string): Promise<DatabaseInterface> {
  const baseUrl = pgUrl as string;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return (await getDatabase({
    type: 'postgres',
    url:
      `${baseUrl}${separator}options=-c%20search_path%3D${SCHEMA}` +
      `&application_name=smrtfallback_${label}_${randomUUID().slice(0, 8)}`,
    dbid: `smrt-test-fallback-${label}-${randomUUID()}`,
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

async function holdTransaction(
  handle: DatabaseInterface,
  start: (tx: DatabaseInterface) => Promise<void>,
): Promise<{ release: () => Promise<void> }> {
  const started = deferred();
  const release = deferred();
  const done = runTransaction(handle, async (tx) => {
    await start(tx);
    started.resolve();
    await release.promise;
  });
  await Promise.race([
    started.promise,
    done.then(() => {
      throw new Error('transaction ended before it was held');
    }),
  ]);
  return {
    release: async () => {
      release.resolve();
      await done;
    },
  };
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('change-feed append fallback (optional, #5438)', () => {
  let setup: DatabaseInterface;
  let holder: DatabaseInterface;
  let writer: DatabaseInterface;
  let locker: DatabaseInterface;

  async function pendingCount(): Promise<number> {
    return Number(
      rowsOf(
        await setup.query(
          'SELECT count(*)::int AS n FROM _smrt_changes_pending',
        ),
      )[0]?.n ?? 0,
    );
  }

  function holdHead(): Promise<{ release: () => Promise<void> }> {
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

  beforeAll(async () => {
    const admin = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-fallback-admin-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.close?.();
    setup = await connect('setup');
    holder = await connect('holder');
    writer = await connect('writer');
    locker = await connect('locker');
    await ensureChangeFeedTable(setup);
  });

  afterAll(async () => {
    for (const handle of [setup, holder, writer, locker]) {
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

  it('stages an append that times out on the head inside a caller transaction, which stays usable', async () => {
    const head = await holdHead();
    try {
      await runTransaction(writer, async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '200ms'");
        expect(
          await appendChange(tx, { table: FEED_TABLE, rowId: 'timed-out' }),
        ).toBeNull();
        const rows = rowsOf(await tx.query('SELECT 1 AS ok'));
        expect(Number(rows[0]?.ok)).toBe(1);
      });
    } finally {
      await head.release();
    }
    expect(await pendingCount()).toBe(1);
    stopChangeFeedDrainers();
    await settleChangeFeedDrainers();
    expect(await drainChangeFeed(setup)).toBe(1);
  }, 60_000);

  it('returns a cancelled statement as an error and stages nothing', async () => {
    const head = await holdHead();
    try {
      await runTransaction(writer, async (tx) => {
        await tx.query("SET LOCAL statement_timeout = '200ms'");
        await expect(
          appendChange(tx, { table: FEED_TABLE, rowId: 'cancelled' }),
        ).rejects.toMatchObject({ code: '57014' });
      });
    } finally {
      await head.release();
    }
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  it('returns the lock timeout within a bound, staging nothing, when the staging table is locked too', async () => {
    const head = await holdHead();
    const maintenance = await holdTransaction(locker, async (tx) => {
      await tx.query(
        'LOCK TABLE _smrt_changes_pending IN ACCESS EXCLUSIVE MODE',
      );
    });
    try {
      const startedAt = Date.now();
      await runTransaction(writer, async (tx) => {
        await tx.query("SET LOCAL lock_timeout = '200ms'");
        await expect(
          appendChange(tx, { table: FEED_TABLE, rowId: 'both-locked' }),
        ).rejects.toMatchObject({ code: '55P03' });
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await maintenance.release();
      await head.release();
    }
    expect(await pendingCount()).toBe(0);
  }, 60_000);

  it('does not stage a tenant id the feed table would reject, even when the staging column accepts it', async () => {
    await setup.query(
      'ALTER TABLE _smrt_changes_pending ALTER COLUMN tenant_id TYPE TEXT',
    );
    try {
      const head = await holdHead();
      try {
        let rows: Record<string, unknown>[] = [];
        await runTransaction(writer, async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '200ms'");
          rows = rowsOf(
            await tx.query(
              `SELECT * FROM _smrt_append_change($1, 'x', 'update', 'not-a-uuid', now())`,
              FEED_TABLE,
            ),
          );
        });
        // Without the check, the lock timeout (before any conversion) would
        // stage a row the drain can never insert.
        expect(rows[0]?.error_code).toBe('55P03');
      } finally {
        await head.release();
      }
      expect(await pendingCount()).toBe(0);
    } finally {
      await setup.query('TRUNCATE _smrt_changes_pending');
      await setup.query(
        'ALTER TABLE _smrt_changes_pending ALTER COLUMN tenant_id TYPE UUID USING tenant_id::uuid',
      );
    }
  }, 60_000);
});
