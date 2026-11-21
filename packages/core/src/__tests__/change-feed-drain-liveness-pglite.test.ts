/**
 * Waiting drains and the root drainer, on PGlite (#5403).
 *
 * A try-only drain fails while the head of the log is held or queued for, so
 * under steady direct appends staged entries could stay invisible for as long
 * as the load lasted. The status drain now has a wait mode bounded by one
 * budget (never an unbounded `lock_timeout`, always below
 * `statement_timeout`), and each root database handle gets one detached
 * drainer that feed activity kicks and that keeps going while a status
 * reports work it could not finish. Detached work never runs inside a
 * transaction block a caller opened on the root.
 *
 * PGlite is one session, so these cases cover the bodies, the statuses and
 * the drainer's kicks; contention runs in the PostgreSQL lane. Runs under
 * `pnpm test:pglite`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  changeFeedDrainerSnapshot,
  drainChangeFeed,
  ensureChangeFeedTable,
  getChangesSince,
  getTableVersion,
  probeChangeFeedHelperState,
  resetChangeFeedWarnings,
  settleChangeFeedDrainers,
  stopChangeFeedDrainers,
} from '../change-feed';
import { subscribeToChangeSignals } from '../change-signals';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue';
import { getTestDatabase } from '../testing/database';

const SUBJECT = 'drain_liveness_pglite_notes';
const STATUS_DRAIN = '_smrt_drain_changes(integer,text[],jsonb)';
const RUNTIME_ROLE = 'drain_liveness_runtime';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

async function one(
  db: DatabaseInterface,
  sql: string,
  ...params: unknown[]
): Promise<Record<string, unknown>> {
  return rowsOf(await db.query(sql, ...params))[0] ?? {};
}

async function count(db: DatabaseInterface, table: string): Promise<number> {
  return Number((await one(db, `SELECT count(*)::int AS n FROM ${table}`)).n);
}

/** A committed staged row, as another process's transaction leaves it. */
async function stageCommitted(
  db: DatabaseInterface,
  rowId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at)
     VALUES ($1, $2, 'update', now())`,
    SUBJECT,
    rowId,
  );
}

async function statusDrain(
  db: DatabaseInterface,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  if (options.firstStatement) {
    // One simple-protocol statement, as the drainer sends it: a
    // parameterized call starts its transaction before its statement time.
    return rowsOf(
      await db.query(
        `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], '${JSON.stringify(options)}'::jsonb)`,
      ),
    );
  }
  return rowsOf(
    await db.query(
      `SELECT * FROM _smrt_drain_changes(1000, ARRAY[]::text[], $1::jsonb)`,
      JSON.stringify(options),
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'change-feed waiting drain and root drainer on PGlite (#5403)',
  () => {
    let db: DatabaseInterface;

    beforeEach(async () => {
      resetChangeFeedWarnings();
      db = (await getTestDatabase({
        type: 'pglite',
        classes: [],
      })) as DatabaseInterface;
      await ensureChangeFeedTable(db);
    });

    afterEach(async () => {
      stopChangeFeedDrainers();
      await settleChangeFeedDrainers();
      vi.restoreAllMocks();
      try {
        await db.query('RESET ROLE');
      } catch {
        // Already closed.
      }
      await db.close?.();
    });

    it('a waiting status drain sequences and leaves lock_timeout as the caller set it', async () => {
      await db.query(`SET lock_timeout = '7s'`);
      await stageCommitted(db, 'a');
      const rows = await statusDrain(db, { waitMs: 2000 });
      expect(rows.map((row) => row.drained_row_id)).toEqual(['a', null]);
      expect(rows.at(-1)).toMatchObject({
        status: 'drained',
        backlog_remaining: false,
      });
      expect((await one(db, 'SHOW lock_timeout')).lock_timeout).toBe('7s');
    });

    it('ends a spent budget as timeout before taking any lock', async () => {
      await db.query(`SET lock_timeout = '7s'`);
      await stageCommitted(db, 'a');
      await db.query('BEGIN');
      const rows = await statusDrain(db, { waitMs: 0.5 });
      const held = await one(
        db,
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE pid = pg_backend_pid()
            AND (locktype = 'advisory'
                 OR relation IN (to_regclass('_smrt_changes'),
                                 to_regclass('_smrt_changes_pending')))`,
      );
      const timeout = (await one(db, 'SHOW lock_timeout')).lock_timeout;
      await db.query('ROLLBACK');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'timeout', error_code: null });
      expect(Number(held.n)).toBe(0);
      expect(timeout).toBe('7s');
      expect(await count(db, '_smrt_changes_pending')).toBe(1);
    });

    it('keeps a waiting pass inside a short statement_timeout: timeout, never a cancelled statement', async () => {
      await stageCommitted(db, 'a');
      await db.query(`SET statement_timeout = '40ms'`);
      try {
        const rows = await statusDrain(db, { waitMs: 2000 });
        expect(rows.map((row) => row.error_code)).toEqual([null]);
        expect(rows[0]?.status).toBe('timeout');
      } finally {
        await db.query('RESET statement_timeout');
      }
    });

    it('refuses a firstStatement pass inside an open transaction block, written or not', async () => {
      await stageCommitted(db, 'a');
      await db.query('BEGIN');
      // The guard compares statement and transaction start times; PGlite's
      // clock has millisecond resolution, so let one tick pass. (The drainer
      // also checks the client's own transaction state first.)
      await sleep(5);
      const rows = await statusDrain(db, { firstStatement: true });
      await db.query('ROLLBACK');
      expect(rows).toEqual([
        expect.objectContaining({ status: 'in_transaction' }),
      ]);
      // As its own transaction it runs.
      const alone = await statusDrain(db, { firstStatement: true });
      expect(alone.at(-1)?.status).toBe('drained');
    });

    it('drainChangeFeed({ wait: true }) drains on a root handle', async () => {
      await stageCommitted(db, 'a');
      await stageCommitted(db, 'b');
      expect(await drainChangeFeed(db, { wait: true })).toBe(2);
    });

    it('starts one pass on a root’s first feed call, which sequences an earlier backlog', async () => {
      await stageCommitted(db, 'left-by-previous-process');
      await getTableVersion(db, SUBJECT);
      await settleChangeFeedDrainers();
      expect(await count(db, '_smrt_changes_pending')).toBe(0);
      expect(await count(db, '_smrt_changes')).toBe(1);
    });

    it('drains and signals what a framework transaction staged once it commits', async () => {
      const signals: unknown[] = [];
      const unsubscribe = subscribeToChangeSignals(db, (signal) => {
        signals.push(signal);
      });
      try {
        await withEmbeddedWriteTransaction(db, true, async (tx) => {
          await tx.query('SELECT pg_current_xact_id()');
          expect(
            await appendChange(tx, { table: SUBJECT, rowId: 'framework' }),
          ).toBeNull();
        });
        await settleChangeFeedDrainers();
        expect(await count(db, '_smrt_changes_pending')).toBe(0);
        expect(signals).toEqual([
          expect.objectContaining({
            table: SUBJECT,
            rowId: 'framework',
            seq: 1,
          }),
        ]);
      } finally {
        unsubscribe();
      }
    });

    it('follows a write-path drain the throttle skipped with one trailing pass', async () => {
      expect(await appendChange(db, { table: SUBJECT, rowId: 'first' })).toBe(
        1,
      );
      await settleChangeFeedDrainers();
      // Outside the throttle window: this append's own drain runs, empty.
      await sleep(300);
      expect(await appendChange(db, { table: SUBJECT, rowId: 'second' })).toBe(
        2,
      );
      // Another process commits a staged row; the next append is inside the
      // window, so its drain is skipped and it is the last feed call.
      await stageCommitted(db, 'from-elsewhere');
      expect(await appendChange(db, { table: SUBJECT, rowId: 'third' })).toBe(
        3,
      );
      await settleChangeFeedDrainers();
      expect(await count(db, '_smrt_changes_pending')).toBe(0);
      const page = await getChangesSince(db, { since: 0 });
      expect(page.changes.map((change) => change.rowId)).toEqual([
        'first',
        'second',
        'third',
        'from-elsewhere',
      ]);
    });

    it('never runs a detached pass inside a transaction a caller opened on the root', async () => {
      await stageCommitted(db, 'a');
      await db.query('BEGIN');
      await getTableVersion(db, SUBJECT);
      await sleep(700);
      // Had a pass run inside this block, its sequence would be visible here.
      const inside = await count(db, '_smrt_changes');
      await db.query('ROLLBACK');
      expect(inside).toBe(0);
      await settleChangeFeedDrainers();
      expect(await count(db, '_smrt_changes_pending')).toBe(0);
      expect(await count(db, '_smrt_changes')).toBe(1);
    });

    it('reads in a caller transaction through the protected entry point when the status drain is not granted', async () => {
      await db.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
      await db.query(`CREATE ROLE ${RUNTIME_ROLE} NOSUPERUSER`);
      await db.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON _smrt_changes, _smrt_changes_pending TO ${RUNTIME_ROLE}`,
      );
      await db.query(`REVOKE EXECUTE ON FUNCTION ${STATUS_DRAIN} FROM PUBLIC`);
      await stageCommitted(db, 'a');
      await db.query('BEGIN');
      await db.query(`SET LOCAL ROLE ${RUNTIME_ROLE}`);
      const page = await getChangesSince(db, { since: 0 });
      // The transaction is still usable: nothing aborted it.
      const ok = await one(db, 'SELECT 1 AS ok');
      await db.query('ROLLBACK');
      expect(page.changes).toEqual([]);
      expect(ok.ok).toBe(1);
    });

    it('reinstalls helpers an older installer restored at most once per probe result, from the drainer only', async () => {
      // An older installer put back an append body without the v7 marker.
      const def = String(
        (
          await one(
            db,
            `SELECT pg_get_functiondef(to_regprocedure('_smrt_append_changes(jsonb)')) AS def`,
          )
        ).def,
      ).replace('-- smrt-change-feed-helpers:v7\n', '');
      await db.query(def);
      expect(await probeChangeFeedHelperState(db)).toBe('mixed');
      await db.query(`DROP ROLE IF EXISTS ${RUNTIME_ROLE}`);
      await db.query(`CREATE ROLE ${RUNTIME_ROLE} NOSUPERUSER`);
      await db.query(`GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE}`);
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON _smrt_changes, _smrt_changes_pending TO ${RUNTIME_ROLE}`,
      );
      const installs: string[] = [];
      const query = db.query.bind(db);
      (db as { query: unknown }).query = (sql: string, ...rest: unknown[]) => {
        if (/^\s*DO\b/.test(sql)) installs.push(sql);
        return query(sql, ...rest);
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await db.query(`SET ROLE ${RUNTIME_ROLE}`);
      for (const rowId of ['a', 'b']) {
        await stageCommitted(db, rowId);
        // A caller's drain reports the older helpers and hands over.
        expect(await drainChangeFeed(db)).toBe(1);
        await settleChangeFeedDrainers();
      }
      await db.query('RESET ROLE');
      expect(installs).toHaveLength(1);
      expect(
        warn.mock.calls.filter((call) =>
          call.some((part) => String(part).includes('could not be upgraded')),
        ),
      ).toHaveLength(1);
      expect(await probeChangeFeedHelperState(db)).toBe('mixed');
    });

    it('does not open a transaction form on a one-session root with a fixed-snapshot default; it warns once', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await db.query(`SET default_transaction_isolation = 'repeatable read'`);
      try {
        expect(await appendChange(db, { table: SUBJECT, rowId: 'rr' })).toBe(
          null,
        );
        await settleChangeFeedDrainers();
        expect(await count(db, '_smrt_changes_pending')).toBe(1);
        expect(
          warn.mock.calls.filter((call) =>
            call.some((part) => String(part).includes('fixed snapshot')),
          ),
        ).toHaveLength(1);
      } finally {
        await db.query('RESET default_transaction_isolation');
      }
    });

    it('ends a root’s drainer silently when the root closes with a pass pending', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await stageCommitted(db, 'a');
      await getTableVersion(db, SUBJECT);
      expect(changeFeedDrainerSnapshot(db)).toMatchObject({
        scheduled: true,
        timerHasRef: false,
      });
      await db.close?.();
      await settleChangeFeedDrainers();
      expect(changeFeedDrainerSnapshot(db)).toMatchObject({
        scheduled: false,
        terminal: true,
      });
      expect(warn).not.toHaveBeenCalled();
    });
  },
);
