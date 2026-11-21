/**
 * PostgreSQL change-feed appends under sustained contention (#5271).
 *
 * Every `_smrt_changes.seq` allocator reads `COALESCE(MAX(seq), 0) + 1` and
 * the primary key arbitrates, so concurrent writers used to lose the race,
 * wait for the winner's transaction, fail with `23505` and retry. With enough
 * writers one of them could lose every round, run out of attempts, and the
 * change was dropped with only a warning. The helpers now serialize every
 * READ COMMITTED allocator on one transaction-scoped advisory "head lock",
 * taken after the feed table's insert lock and before `MAX(seq)` is read:
 * a holder sees its predecessor's committed row and never collides.
 *
 * The drain only tries that lock, so a reader never waits on the head, and a
 * drain over credential-table rows alone never takes it. Under a fixed
 * snapshot (REPEATABLE READ / SERIALIZABLE) the helpers stage instead of
 * allocating and the drain allocates nothing, because a stale `MAX` could
 * otherwise land behind a cursor a consumer already holds.
 *
 * Runs only in the dedicated disposable PostgreSQL shard
 * (`SMRT_TEST_POSTGRES_URL`). Every connection is pinned to this suite's own
 * schema; the head lock is keyed on the feed table, so sibling suites in
 * other schemas never share it.
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
  appendChanges,
  drainChangeFeed,
  ensureChangeFeedTable,
  ensurePostgresChangeFeedAppendFunction,
  ensurePostgresChangeFeedHelpers,
  getChangesSince,
  resetChangeFeedWarnings,
} from '../change-feed';
import { declareChangeFeedSensitiveTable } from '../change-feed-sensitivity';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const SCHEMA = 'issue_5271_change_feed';
const FEED_TABLE = 'issue_5271_subject';
const SECRET_TABLE = 'issue_5271_secrets';
const MARKERS = [
  'smrt-change-feed-helpers:v6',
  'smrt-change-feed-helpers:v5',
  'smrt-change-feed-helpers:v4',
];

/**
 * The direct allocator as v5 shipped it: stage when the caller already holds
 * a transaction id, otherwise `MAX + 1` with no head lock. Installed to prove
 * that a database still holding older bodies mid-rollout stays correct (the
 * primary key arbitrates and the retry covers it), and that a v6 process
 * repairs it.
 */
const LEGACY_V5_APPEND = `
CREATE OR REPLACE FUNCTION _smrt_append_change(
  p_table_name TEXT, p_row_id TEXT, p_operation TEXT, p_tenant_id TEXT,
  p_created_at TIMESTAMPTZ
)
RETURNS TABLE(allocated_seq BIGINT, error_code TEXT, error_message TEXT)
LANGUAGE plpgsql SECURITY INVOKER
AS $legacy_append$
-- smrt-change-feed-helpers:v5
-- smrt-change-feed-helpers:v4
DECLARE
  v_seq BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
      INSERT INTO _smrt_changes_pending (table_name, row_id, operation, tenant_id, created_at)
      VALUES (p_table_name, p_row_id, p_operation, NULLIF(p_tenant_id, '')::uuid, p_created_at);
      RETURN QUERY SELECT NULL::BIGINT, NULL::TEXT, NULL::TEXT;
      RETURN;
    END IF;
    INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
    SELECT COALESCE(MAX(changes.seq), 0) + 1, p_table_name, p_row_id, p_operation,
           NULLIF(p_tenant_id, '')::uuid, p_created_at
    FROM _smrt_changes AS changes
    RETURNING _smrt_changes.seq INTO v_seq;
    RETURN QUERY SELECT v_seq, NULL::TEXT, NULL::TEXT;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE, v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::BIGINT, v_error_code, v_error_message;
  END;
END;
$legacy_append$;
`;

/** The v5 drain: drain lock only, no head lock, no isolation check. */
const LEGACY_V5_DRAIN = `
CREATE OR REPLACE FUNCTION _smrt_drain_changes(p_limit INTEGER, p_excluded_tables TEXT[])
RETURNS TABLE(
  drained_seq BIGINT, drained_table TEXT, drained_row_id TEXT,
  drained_operation TEXT, drained_tenant_id TEXT, error_code TEXT, error_message TEXT
)
LANGUAGE plpgsql SECURITY INVOKER
AS $legacy_drain$
-- smrt-change-feed-helpers:v5
-- smrt-change-feed-helpers:v4
DECLARE
  v_base BIGINT;
  v_error_code TEXT;
  v_error_message TEXT;
BEGIN
  BEGIN
    IF pg_current_xact_id_if_assigned() IS NOT NULL THEN RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM _smrt_changes_pending LIMIT 1) THEN RETURN; END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('smrt'), hashtext('change-feed-drain')) THEN
      RETURN;
    END IF;
    SELECT COALESCE(MAX(changes.seq), 0) INTO v_base FROM _smrt_changes AS changes;
    RETURN QUERY
    WITH removed AS (
      DELETE FROM _smrt_changes_pending AS pending
      WHERE pending.pending_id IN (
        SELECT candidate.pending_id FROM _smrt_changes_pending AS candidate
        WHERE NOT (candidate.table_name = ANY(COALESCE(p_excluded_tables, ARRAY[]::TEXT[])))
        ORDER BY candidate.pending_id
        LIMIT GREATEST(COALESCE(p_limit, 1000), 1)
      )
      RETURNING pending.*
    ), numbered AS (
      SELECT removed.*, v_base + row_number() OVER (ORDER BY removed.pending_id) AS new_seq
      FROM removed
    ), inserted AS (
      INSERT INTO _smrt_changes (seq, table_name, row_id, operation, tenant_id, created_at)
      SELECT new_seq, table_name, row_id, operation, tenant_id, created_at FROM numbered
      RETURNING _smrt_changes.seq, _smrt_changes.table_name, _smrt_changes.row_id,
                _smrt_changes.operation, _smrt_changes.tenant_id
    )
    SELECT inserted.seq, inserted.table_name, inserted.row_id, inserted.operation,
           inserted.tenant_id::TEXT, NULL::TEXT, NULL::TEXT
    FROM inserted ORDER BY inserted.seq;
  EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN
    GET STACKED DIAGNOSTICS v_error_code = RETURNED_SQLSTATE, v_error_message = MESSAGE_TEXT;
    RETURN QUERY SELECT NULL::BIGINT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
                        v_error_code, v_error_message;
  END;
END;
$legacy_drain$;
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

/** Resolve to `'timeout'` if `promise` has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Each handle's `application_name`, unique per run, so a test can tell which
 * backend is ITS waiter without matching on SQL text that a sibling suite
 * could also be running.
 */
const applicationNames = new WeakMap<DatabaseInterface, string>();

async function connect(
  label: string,
  baseUrl = pgUrl as string,
): Promise<DatabaseInterface> {
  const separator = baseUrl.includes('?') ? '&' : '?';
  const applicationName = `smrt5271_${label}_${randomUUID().slice(0, 8)}`;
  const handle = (await getDatabase({
    type: 'postgres',
    url:
      `${baseUrl}${separator}options=-c%20search_path%3D${SCHEMA}` +
      `&application_name=${applicationName}`,
    dbid: `smrt-test-5271-${label}-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  applicationNames.set(handle, applicationName);
  return handle;
}

/** The backend PID serving `tx` (a transaction handle is one connection). */
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

interface FeedCounters {
  /** Calls of the single-entry helper itself (not statements in general). */
  appendCalls: number;
  /** Helper result rows (append, batch or drain) that carried `23505`. */
  conflicts: number;
  /** Drain result rows that carried `23505`. */
  drainConflicts: number;
}

/**
 * Count, on the handle itself, what the framework sends to and receives from
 * the feed helpers. Patching `query` keeps the handle's identity, so the feed
 * module's per-handle state is unaffected.
 */
const originalQueries = new Map<
  DatabaseInterface,
  DatabaseInterface['query']
>();

function instrument(db: DatabaseInterface): FeedCounters {
  const counters: FeedCounters = {
    appendCalls: 0,
    conflicts: 0,
    drainConflicts: 0,
  };
  const unpatched = originalQueries.get(db) ?? db.query;
  originalQueries.set(db, unpatched);
  const original = unpatched.bind(db);
  (db as { query: DatabaseInterface['query'] }).query = (async (
    sql: string,
    ...params: unknown[]
  ) => {
    if (/_smrt_append_change\(/.test(sql)) counters.appendCalls += 1;
    const result = await original(sql, ...params);
    if (/_smrt_(append_changes?|drain_changes)\(/.test(sql)) {
      for (const row of rowsOf(result)) {
        if (String(row.error_code ?? '') === '23505') {
          counters.conflicts += 1;
          if (sql.includes('_smrt_drain_changes('))
            counters.drainConflicts += 1;
        }
      }
    }
    return result;
  }) as DatabaseInterface['query'];
  return counters;
}

/** Undo {@link instrument} on every handle it patched. */
function restoreQueries(): void {
  for (const [db, query] of originalQueries) {
    (db as { query: DatabaseInterface['query'] }).query = query;
  }
  originalQueries.clear();
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe(
  'change-feed append under contention (optional, #5271)',
  () => {
    let setup: DatabaseInterface;
    let observer: DatabaseInterface;
    let holder: DatabaseInterface;
    const writers: DatabaseInterface[] = [];

    async function feedSequences(): Promise<number[]> {
      return rowsOf(
        await setup.query('SELECT seq FROM _smrt_changes ORDER BY seq'),
      ).map((row) => Number(row.seq));
    }

    async function expectContiguous(expected: number): Promise<void> {
      const seqs = await feedSequences();
      expect(seqs).toEqual(Array.from({ length: expected }, (_, i) => i + 1));
    }

    async function pendingCount(): Promise<number> {
      return Number(
        rowsOf(
          await setup.query(
            'SELECT count(*)::int AS n FROM _smrt_changes_pending',
          ),
        )[0]?.n ?? 0,
      );
    }

    /**
     * Wait until a backend of `waiter` is waiting on a lock that the backend
     * `blockerPid` holds. Matching both ends, rather than any backend running
     * similar SQL, proves the intended waiter is queued behind the intended
     * holder before the test releases it.
     */
    async function waitUntilBlocked(
      waiter: DatabaseInterface,
      blockerPid: number,
    ): Promise<void> {
      const applicationName = applicationNames.get(waiter);
      if (!applicationName) throw new Error('waiter has no application name');
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const rows = rowsOf(
          await observer.query(
            `SELECT count(*)::int AS blocked
             FROM pg_stat_activity
            WHERE application_name = $1
              AND wait_event_type = 'Lock'
              AND $2::int = ANY(pg_blocking_pids(pid))`,
            applicationName,
            blockerPid,
          ),
        );
        if (Number(rows[0]?.blocked ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Timed out waiting for ${applicationName} to block on backend ${blockerPid}`,
      );
    }

    /**
     * Open a transaction whose FIRST statement allocates directly through the
     * helper (no xid before it), so it holds the head of the log until
     * `release` is called with `'commit'` or `'rollback'`.
     */
    async function holdHead(): Promise<{
      seq: number;
      pid: number;
      release: (outcome: 'commit' | 'rollback') => Promise<void>;
    }> {
      const allocated = deferred<number>();
      const outcome = deferred<'commit' | 'rollback'>();
      let pid = 0;
      const done = runTransaction(holder, async (tx) => {
        pid = await backendPid(tx);
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
        allocated.resolve(Number(rows[0]?.allocated_seq));
        if ((await outcome.promise) === 'rollback') {
          throw new Error('issue-5271 planned rollback');
        }
      }).catch((error: unknown) => {
        if (!/planned rollback/.test(String((error as Error)?.message))) {
          throw error;
        }
      });
      const seq = await allocated.promise;
      return {
        seq,
        pid,
        release: async (result) => {
          outcome.resolve(result);
          await done;
        },
      };
    }

    /** Stage one entry from a transaction that has already written, then commit. */
    async function stageCommitted(
      handle: DatabaseInterface,
      rowId: string,
      table = FEED_TABLE,
    ): Promise<void> {
      await runTransaction(handle, async (tx) => {
        await tx.query('SELECT pg_current_xact_id()');
        expect(await appendChange(tx, { table, rowId })).toBeNull();
      });
    }

    beforeAll(async () => {
      const admin = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-5271-admin-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.query(`CREATE SCHEMA ${SCHEMA}`);

      setup = await connect('setup');
      observer = await connect('observer');
      holder = await connect('holder');
      await ensureChangeFeedTable(setup);
      for (let i = 0; i < 8; i += 1) {
        const writer = await connect(`writer-${i}`);
        await ensureChangeFeedTable(writer);
        writers.push(writer);
      }
      declareChangeFeedSensitiveTable(SECRET_TABLE);
    }, 120_000);

    afterAll(async () => {
      await setup?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    });

    beforeEach(async () => {
      await ensurePostgresChangeFeedAppendFunction(setup, {
        replaceExisting: true,
      });
      await setup.query('DELETE FROM _smrt_changes');
      await setup.query('DELETE FROM _smrt_changes_pending');
      resetChangeFeedWarnings();
    });

    it('installs v6 bodies that carry every older marker and stay VOLATILE', async () => {
      const rows = rowsOf(
        await setup.query(
          `SELECT p.oid::regprocedure::text AS identity, p.prosrc, p.provolatile
           FROM pg_proc AS p
          WHERE p.oid IN (
            to_regprocedure('_smrt_append_change(text,text,text,text,timestamp with time zone)'),
            to_regprocedure('_smrt_append_changes(jsonb)'),
            to_regprocedure('_smrt_drain_changes(integer,text[])'),
            to_regprocedure('_smrt_drain_changes(integer)')
          )`,
        ),
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        for (const marker of MARKERS) {
          expect(String(row.prosrc), String(row.identity)).toContain(marker);
        }
        expect(row.provolatile, String(row.identity)).toBe('v');
      }
    });

    it('8 connections x 100 appends: all succeed, contiguous, no sequence conflicts', async () => {
      const counters = writers.map((writer) => instrument(writer));
      try {
        await Promise.all(
          writers.map(async (writer, w) => {
            for (let i = 0; i < 100; i += 1) {
              await appendChange(writer, {
                table: FEED_TABLE,
                rowId: `w${w}-${i}`,
              });
            }
          }),
        );
        await expectContiguous(800);
        // Cursor pagination sees each entry exactly once.
        const seen = new Set<number>();
        let cursor = 0;
        for (;;) {
          const page = await getChangesSince(setup, {
            since: cursor,
            limit: 100,
          });
          for (const change of page.changes) {
            expect(seen.has(change.seq)).toBe(false);
            seen.add(change.seq);
          }
          if (page.changes.length === 0) break;
          cursor = page.cursor;
        }
        expect(seen.size).toBe(800);
        expect(counters.reduce((sum, c) => sum + c.conflicts, 0)).toBe(0);
      } finally {
        restoreQueries();
      }
    }, 120_000);

    it('a waiter behind a committed holder allocates on its first helper call', async () => {
      const counters = instrument(writers[0]);
      try {
        const held = await holdHead();
        const waiter = appendChange(writers[0], {
          table: FEED_TABLE,
          rowId: 'waiter',
        });
        try {
          await waitUntilBlocked(writers[0], held.pid);
        } finally {
          await held.release('commit');
        }
        await expect(waiter).resolves.toBe(held.seq + 1);
        expect(counters.appendCalls).toBe(1);
      } finally {
        restoreQueries();
      }
    }, 60_000);

    it('a waiter behind a rolled-back holder takes the freed sequence', async () => {
      const held = await holdHead();
      const waiter = appendChange(writers[1], {
        table: FEED_TABLE,
        rowId: 'waiter',
      });
      try {
        await waitUntilBlocked(writers[1], held.pid);
      } finally {
        await held.release('rollback');
      }
      await expect(waiter).resolves.toBe(held.seq);
      await expectContiguous(held.seq);
    }, 60_000);

    it('a lock timeout while waiting stages the entry and leaves the caller transaction usable', async () => {
      // Since #5438 a direct allocation that times out is staged in the same
      // statement (null), not returned as a 55P03 the writer drops.
      const held = await holdHead();
      try {
        await runTransaction(writers[2], async (tx) => {
          await tx.query("SET LOCAL lock_timeout = '200ms'");
          expect(
            await appendChange(tx, { table: FEED_TABLE, rowId: 'timed-out' }),
          ).toBeNull();
          const rows = rowsOf(await tx.query('SELECT 1 AS ok'));
          expect(Number(rows[0]?.ok)).toBe(1);
        });
      } finally {
        await held.release('commit');
      }
      expect(await pendingCount()).toBe(1);
    }, 60_000);

    it('a reader never waits on the head: it serves the committed horizon and a later read delivers', async () => {
      await appendChange(setup, { table: FEED_TABLE, rowId: 'before' });
      await stageCommitted(writers[3], 'staged');
      const held = await holdHead();
      let first: Awaited<ReturnType<typeof getChangesSince>> | 'timeout';
      try {
        first = await within(getChangesSince(writers[4], { since: 0 }), 5_000);
      } finally {
        await held.release('commit');
      }
      expect(first).not.toBe('timeout');
      if (first === 'timeout') return;
      expect(first.changes.map((change) => change.rowId)).toEqual(['before']);

      const later = await getChangesSince(writers[4], { since: first.cursor });
      expect(later.changes.map((change) => change.rowId)).toEqual([
        'held',
        'staged',
      ]);
      await expectContiguous(3);
    }, 60_000);

    it('a SHARE lock holder that appends does not deadlock with a waiting appender', async () => {
      const shareHeld = deferred();
      const waiterBlocked = deferred();
      let waiter: Promise<number | null> | undefined;
      let ownerPid = 0;
      const owner = runTransaction(writers[5], async (tx) => {
        ownerPid = await backendPid(tx);
        await tx.query('LOCK TABLE _smrt_changes IN SHARE MODE');
        shareHeld.resolve();
        await waiterBlocked.promise;
        expect(
          await appendChange(tx, { table: FEED_TABLE, rowId: 'share-owner' }),
        ).toBe(1);
      });
      await shareHeld.promise;
      try {
        waiter = appendChange(writers[6], {
          table: FEED_TABLE,
          rowId: 'share-waiter',
        });
        await waitUntilBlocked(writers[6], ownerPid);
      } finally {
        waiterBlocked.resolve();
      }
      await owner;
      await expect(waiter).resolves.toBe(2);
      await expectContiguous(2);
    }, 60_000);

    it('a drain over credential-table rows alone never holds the head', async () => {
      await setup.query(
        `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
       VALUES ($1, 'secret', 'update', now())`,
        SECRET_TABLE,
      );
      const drained = deferred();
      const appended = deferred();
      // The reader holds its transaction until the append's outcome is
      // recorded, so the append can only finish in time if the drain never
      // took the head.
      const reader = runTransaction(writers[7], async (tx) => {
        expect(await drainChangeFeed(tx)).toBe(0);
        drained.resolve();
        await appended.promise;
      });
      await drained.promise;
      let outcome: number | null | 'timeout';
      try {
        outcome = await within(
          appendChange(writers[0], { table: FEED_TABLE, rowId: 'after' }),
          5_000,
        );
      } finally {
        appended.resolve();
      }
      await reader;
      expect(outcome).toBe(1);
      expect(await pendingCount()).toBe(0);
    }, 60_000);

    it('a reader never waits behind a SHARE lock on the feed table: it serves the committed horizon', async () => {
      await appendChange(setup, { table: FEED_TABLE, rowId: 'before' });
      await stageCommitted(writers[3], 'staged');
      const shareHeld = deferred();
      const release = deferred();
      const owner = runTransaction(writers[5], async (tx) => {
        await tx.query('LOCK TABLE _smrt_changes IN SHARE MODE');
        shareHeld.resolve();
        await release.promise;
      });
      await shareHeld.promise;
      let first: Awaited<ReturnType<typeof getChangesSince>> | 'timeout';
      let pendingWhileHeld: number;
      try {
        first = await within(getChangesSince(writers[4], { since: 0 }), 5_000);
        pendingWhileHeld = await pendingCount();
      } finally {
        // Released only after the read's outcome is recorded.
        release.resolve();
        await owner;
      }
      expect(first).not.toBe('timeout');
      if (first === 'timeout') return;
      expect(first.changes.map((change) => change.rowId)).toEqual(['before']);
      expect(pendingWhileHeld).toBe(1);

      const later = await getChangesSince(writers[4], { since: first.cursor });
      expect(later.changes.map((change) => change.rowId)).toEqual(['staged']);
      await expectContiguous(2);
    }, 60_000);

    it('a role granted only column-level INSERT on the feed appends and drains', async () => {
      const role = `issue_5271_col_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const password = randomUUID();
      const columns =
        'seq, table_name, row_id, operation, tenant_id, created_at';
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
        limited = await connect('column-insert', url.toString());
        const privileges = rowsOf(
          await limited.query(
            `SELECT has_table_privilege('_smrt_changes', 'INSERT') AS table_insert,
                    has_column_privilege('_smrt_changes', 'seq', 'INSERT') AS column_insert`,
          ),
        )[0];
        expect(privileges?.table_insert).toBe(false);
        expect(privileges?.column_insert).toBe(true);

        expect(
          await appendChange(limited, { table: FEED_TABLE, rowId: 'single' }),
        ).toBe(1);
        expect(
          await appendChanges(limited, [
            { table: FEED_TABLE, rowId: 'batch-1' },
            { table: FEED_TABLE, rowId: 'batch-2' },
          ]),
        ).toEqual([2, 3]);
        await stageCommitted(writers[0], 'staged');
        expect(await drainChangeFeed(limited)).toBe(1);
        await expectContiguous(4);
      } finally {
        await (
          limited as { close?: () => Promise<void> } | undefined
        )?.close?.();
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

    describe('a missing staging table', () => {
      afterEach(async () => {
        // Restores the staging table (the helper install creates it).
        await ensurePostgresChangeFeedAppendFunction(setup, {
          replaceExisting: true,
        });
      });

      it('a written or fixed-snapshot transaction neither allocates nor waits on the head', async () => {
        await setup.query('DROP TABLE _smrt_changes_pending');
        const held = await holdHead();
        const outcomes: Array<string | undefined> = [];
        try {
          await runTransaction(writers[1], async (tx) => {
            await tx.query("SET LOCAL lock_timeout = '2s'");
            await tx.query('SELECT pg_current_xact_id()');
            outcomes.push(
              await appendChange(tx, {
                table: FEED_TABLE,
                rowId: 'written',
              }).then(
                () => 'allocated',
                (error: Error & { code?: string }) => error.code,
              ),
            );
          });
          await runTransaction(writers[2], async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await tx.query("SET LOCAL lock_timeout = '2s'");
            outcomes.push(
              await appendChanges(tx, [
                { table: FEED_TABLE, rowId: 'rr-batch' },
              ]).then(
                () => 'allocated',
                (error: Error & { code?: string }) => error.code,
              ),
            );
          });
        } finally {
          await held.release('commit');
        }
        // 42P01 (undefined table) from the staged insert, not 55P03 from
        // waiting on the head, and nothing allocated.
        expect(outcomes).toEqual(['42P01', '42P01']);
        await runTransaction(writers[3], async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await expect(
            appendChange(tx, { table: FEED_TABLE, rowId: 'rr-single' }),
          ).rejects.toMatchObject({ code: '42P01' });
        });
        await expectContiguous(1);
      }, 60_000);
    });

    describe('fixed-snapshot isolation stages instead of allocating', () => {
      it('REPEATABLE READ: an append cannot land behind an observed cursor after a prune', async () => {
        for (const rowId of ['a', 'b', 'c']) {
          await appendChange(setup, { table: FEED_TABLE, rowId });
        }
        const snapshotTaken = deferred();
        const cursorObserved = deferred();
        let staged: number | null | undefined;
        const late = runTransaction(writers[1], async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          await tx.query('SELECT count(*) FROM _smrt_changes');
          snapshotTaken.resolve();
          await cursorObserved.promise;
          staged = await appendChange(tx, { table: FEED_TABLE, rowId: 'late' });
        });
        await snapshotTaken.promise;
        await appendChange(setup, { table: FEED_TABLE, rowId: 'd' });
        await appendChange(setup, { table: FEED_TABLE, rowId: 'e' });
        const observed = await getChangesSince(writers[2], { since: 0 });
        expect(observed.cursor).toBe(5);
        // Retention removes seq 4 while keeping the head.
        await setup.query('DELETE FROM _smrt_changes WHERE seq = 4');
        cursorObserved.resolve();
        await late;

        expect(staged).toBeNull();
        const next = await getChangesSince(writers[2], {
          since: observed.cursor,
        });
        expect(next.changes.map((change) => change.rowId)).toEqual(['late']);
        expect(next.changes[0]?.seq).toBe(6);
      }, 60_000);

      it('SERIALIZABLE: a first-statement append stages and a READ COMMITTED read delivers it', async () => {
        let staged: number | null | undefined;
        await runTransaction(writers[3], async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          staged = await appendChange(tx, { table: FEED_TABLE, rowId: 'ser' });
        });
        expect(staged).toBeNull();
        const page = await getChangesSince(writers[4], { since: 0 });
        expect(page.changes.map((change) => change.rowId)).toEqual(['ser']);
      }, 60_000);

      it('REPEATABLE READ: a batch append stages', async () => {
        let staged: Array<number | null> | undefined;
        await runTransaction(writers[5], async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          staged = await appendChanges(tx, [
            { table: FEED_TABLE, rowId: 'b1' },
            { table: FEED_TABLE, rowId: 'b2' },
          ]);
        });
        expect(staged).toEqual([null, null]);
        const page = await getChangesSince(writers[6], { since: 0 });
        expect(page.changes.map((change) => change.rowId)).toEqual([
          'b1',
          'b2',
        ]);
      }, 60_000);

      it('REPEATABLE READ: a drain allocates nothing; a READ COMMITTED drain does', async () => {
        await stageCommitted(writers[0], 'pending-rr');
        let drained: number | undefined;
        await runTransaction(writers[7], async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          drained = await drainChangeFeed(tx);
        });
        expect(drained).toBe(0);
        expect(await pendingCount()).toBe(1);
        expect(await drainChangeFeed(writers[7])).toBe(1);
        await expectContiguous(1);
      }, 60_000);
    });

    it('mixed single, batch and draining writers on 8 connections stay contiguous without conflicts', async () => {
      const counters = writers.map((writer) => instrument(writer));
      let expected = 0;
      try {
        await Promise.all(
          writers.map(async (writer, w) => {
            for (let i = 0; i < 30; i += 1) {
              if (w < 3) {
                await appendChange(writer, {
                  table: FEED_TABLE,
                  rowId: `s${w}-${i}`,
                });
              } else if (w < 6) {
                await appendChanges(
                  writer,
                  Array.from({ length: 5 }, (_, k) => ({
                    table: FEED_TABLE,
                    rowId: `b${w}-${i}-${k}`,
                  })),
                );
              } else {
                await stageCommitted(writer, `t${w}-${i}`);
                await getChangesSince(writer, { since: 0, limit: 1 });
              }
            }
          }),
        );
        expected = 3 * 30 + 3 * 30 * 5 + 2 * 30;
        for (let i = 0; i < 20 && (await pendingCount()) > 0; i += 1) {
          await drainChangeFeed(setup);
        }
        expect(await pendingCount()).toBe(0);
        await expectContiguous(expected);
        expect(counters.reduce((sum, c) => sum + c.conflicts, 0)).toBe(0);
        expect(counters.reduce((sum, c) => sum + c.drainConflicts, 0)).toBe(0);
      } finally {
        restoreQueries();
      }
    }, 120_000);

    it('stays contiguous with an older drain still installed mid-rollout', async () => {
      await setup.query(LEGACY_V5_DRAIN);
      await Promise.all(
        writers.map(async (writer, w) => {
          for (let i = 0; i < 40; i += 1) {
            if (w < 6) {
              await appendChange(writer, {
                table: FEED_TABLE,
                rowId: `v5d-${w}-${i}`,
              });
            } else {
              await stageCommitted(writer, `v5d-staged-${w}-${i}`);
              await drainChangeFeed(writer);
            }
          }
        }),
      );
      for (let i = 0; i < 20 && (await pendingCount()) > 0; i += 1) {
        await drainChangeFeed(setup);
      }
      expect(await pendingCount()).toBe(0);
      await expectContiguous(6 * 40 + 2 * 40);
    }, 120_000);

    it('stays contiguous with an older append body racing v6 batch appends and drains', async () => {
      // Only the single append is the v5 body (no head lock); the batch append
      // and the drain stay v6 and serialize on the head while it races them.
      await setup.query(LEGACY_V5_APPEND);
      await Promise.all(
        writers.map(async (writer, w) => {
          for (let i = 0; i < 30; i += 1) {
            if (w < 4) {
              await appendChange(writer, {
                table: FEED_TABLE,
                rowId: `v5a-${w}-${i}`,
              });
            } else if (w < 6) {
              await appendChanges(
                writer,
                Array.from({ length: 3 }, (_, k) => ({
                  table: FEED_TABLE,
                  rowId: `v6b-${w}-${i}-${k}`,
                })),
              );
            } else {
              await stageCommitted(writer, `v6d-${w}-${i}`);
              await drainChangeFeed(writer);
            }
          }
        }),
      );
      for (let i = 0; i < 20 && (await pendingCount()) > 0; i += 1) {
        await drainChangeFeed(setup);
      }
      expect(await pendingCount()).toBe(0);
      await expectContiguous(4 * 30 + 2 * 30 * 3 + 2 * 30);
      const rowIds = rowsOf(
        await setup.query('SELECT row_id FROM _smrt_changes'),
      ).map((row) => String(row.row_id));
      expect(new Set(rowIds).size).toBe(rowIds.length);
    }, 120_000);

    it('an older installer replacing v6 keeps the feed contiguous, and a v6 process repairs it', async () => {
      await setup.query(LEGACY_V5_APPEND);
      await setup.query(LEGACY_V5_DRAIN);
      await Promise.all(
        writers.slice(0, 4).map(async (writer, w) => {
          for (let i = 0; i < 50; i += 1) {
            await appendChange(writer, {
              table: FEED_TABLE,
              rowId: `old-${w}-${i}`,
            });
          }
        }),
      );
      await expectContiguous(200);

      await ensurePostgresChangeFeedHelpers(setup);
      const repaired = rowsOf(
        await setup.query(
          `SELECT bool_and(prosrc LIKE '%' || $1 || '%') AS current
           FROM pg_proc
          WHERE oid IN (
            to_regprocedure('_smrt_append_change(text,text,text,text,timestamp with time zone)'),
            to_regprocedure('_smrt_drain_changes(integer,text[])')
          )`,
          MARKERS[0],
        ),
      );
      expect(repaired[0]?.current).toBe(true);

      const counters = writers.slice(0, 4).map((writer) => instrument(writer));
      try {
        await Promise.all(
          writers.slice(0, 4).map(async (writer, w) => {
            for (let i = 0; i < 50; i += 1) {
              await appendChange(writer, {
                table: FEED_TABLE,
                rowId: `new-${w}-${i}`,
              });
            }
          }),
        );
        await expectContiguous(400);
        expect(counters.reduce((sum, c) => sum + c.conflicts, 0)).toBe(0);
      } finally {
        restoreQueries();
      }
    }, 120_000);
  },
);
