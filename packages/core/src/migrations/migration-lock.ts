/**
 * Cross-process mutual exclusion for schema migration runs (issue #3634).
 *
 * Two processes that run `smrt db:migrate` against one PostgreSQL database at
 * the same time — two workloads gating their startup on the migration, a
 * rolling restart, a break-glass Job beside running pods — both compare the
 * live schema, both plan the same batch, and the second one fails part way
 * with `42701 column ... already exists` or `42P07 relation ... already
 * exists`. The tracker's per-migration `running` rows cannot prevent this:
 * they are written after the diff, so both runners have already planned.
 *
 * The lock below covers the whole diff → plan → apply window. It is a
 * session-level advisory lock on a pinned connection, so it is held across
 * the run's many statements and transactions, and PostgreSQL frees it the
 * moment that connection ends: a migrator that crashes or is killed never
 * leaves the lock behind for the next one. A waiting runner acquires it after
 * the holder finishes, compares a schema that is already current, and has
 * nothing to apply.
 *
 * SQLite and DuckDB are single-writer files whose engines already serialize
 * schema changes, so the lock is a no-op there.
 */

import { detectEngine } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type { DatabaseInterface } from './types.js';

/**
 * The two-key advisory lock id every `db:migrate` run takes. The `smrt`
 * class id matches the framework's other advisory locks (system-table
 * bootstrap uses `hashtext('smrt'), hashtext('system-tables')`), so the
 * object id alone separates them. Changing either key would let a run of the
 * new release and a run of an older release migrate concurrently.
 */
export const MIGRATION_ADVISORY_LOCK_KEYS =
  "hashtext('smrt'), hashtext('db:migrate')";

/** Default bound on waiting for another run to finish: 15 minutes. */
export const DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Thrown when another run still holds the migration lock at the deadline. */
export class MigrationLockTimeoutError extends Error {
  constructor(public readonly waitedMs: number) {
    super(
      `Another db:migrate run held the migration lock for ${Math.round(
        waitedMs / 1000,
      )}s; giving up. The lock is released when that run's database connection ends. Raise migrations.postgres.migrationLockTimeout if a migration legitimately runs longer.`,
    );
    this.name = 'MigrationLockTimeoutError';
  }
}

/** Thrown when a PostgreSQL adapter cannot pin the connection the lock needs. */
/**
 * Thrown when the lock's pinned connection has died mid-run. PostgreSQL frees
 * a session lock when its backend ends, so another migrator may already be
 * running; the run must stop rather than keep applying unserialized.
 */
export class MigrationLockLostError extends Error {
  constructor(cause?: unknown) {
    super(
      'The db:migrate migration lock was lost: its database connection ended mid-run, so another run may be migrating concurrently. Stopping; rerun db:migrate to converge.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MigrationLockLostError';
  }
}

export class MigrationLockUnsupportedError extends Error {
  constructor() {
    super(
      'This PostgreSQL adapter does not expose acquireSession(), so db:migrate cannot hold the migration lock on one connection. Upgrade @happyvertical/sql.',
    );
    this.name = 'MigrationLockUnsupportedError';
  }
}

export interface AcquireMigrationLockOptions {
  /**
   * How long to wait for another run to release the lock, in milliseconds.
   * `0` waits indefinitely, matching PostgreSQL's meaning of a zero timeout.
   * @default DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS
   */
  timeoutMs?: number;
  /** Delay between attempts while another run holds the lock. @default 1000 */
  pollIntervalMs?: number;
  /** Engine override; otherwise detected from the database URL. */
  engineHint?: string;
  /** Called once, when the first attempt finds the lock held. */
  onWait?: () => void;
  /** Injectable clock and sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MigrationLock {
  /** False when the engine needs no lock (SQLite, DuckDB). */
  readonly held: boolean;
  /** Milliseconds spent waiting for another run; 0 when uncontended. */
  readonly waitedMs: number;
  /** Release the lock and its pinned connection. Idempotent. */
  /**
   * Confirm on the pinned connection that this run still holds the lock, and
   * throw {@link MigrationLockLostError} if it does not. Call it before each
   * phase that writes schema. A no-op when the engine needs no lock.
   */
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Take the migration lock, waiting for a concurrent run to finish.
 *
 * Call it after connecting and before anything that reads or writes schema
 * (system-table bootstrap, schema comparison, apply), and release it in a
 * `finally` after the run. On PostgreSQL the lock lives on its own pinned
 * connection, separate from the pool the migration itself uses.
 */
export async function acquireMigrationLock(
  db: DatabaseInterface,
  options: AcquireMigrationLockOptions = {},
): Promise<MigrationLock> {
  const engine = resolveEngine(db, options.engineHint);
  if (engine !== 'postgres') {
    return {
      held: false,
      waitedMs: 0,
      assertHeld: async () => {},
      release: async () => {},
    };
  }
  if (typeof db.acquireSession !== 'function') {
    throw new MigrationLockUnsupportedError();
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const session = await db.acquireSession();
  const startedAt = now();
  let notifiedWait = false;

  try {
    await exemptFromIdleSessionTimeout(session);
    while (true) {
      const result = await session.query(
        `SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS acquired`,
      );
      if (isTrue(result.rows?.[0]?.acquired)) {
        const waitedMs = notifiedWait ? now() - startedAt : 0;
        let released = false;
        return {
          held: true,
          waitedMs,
          assertHeld: async () => {
            if (released) throw new MigrationLockLostError();
            let stillHeld: boolean;
            try {
              const probe = await session.query(HELD_PROBE_SQL);
              stillHeld = isTrue(probe.rows?.[0]?.held);
            } catch (error) {
              throw new MigrationLockLostError(error);
            }
            if (!stillHeld) throw new MigrationLockLostError();
          },
          release: async () => {
            if (released) return;
            released = true;
            // The adapter's release() runs pg_advisory_unlock_all() and then
            // destroys the connection, which frees the lock even if the
            // unlock could not be sent.
            await session.release();
          },
        };
      }

      const waitedMs = now() - startedAt;
      if (timeoutMs > 0 && waitedMs >= timeoutMs) {
        throw new MigrationLockTimeoutError(waitedMs);
      }
      if (!notifiedWait) {
        notifiedWait = true;
        options.onWait?.();
      }
      await sleep(
        timeoutMs > 0
          ? Math.min(pollIntervalMs, Math.max(1, timeoutMs - waitedMs))
          : pollIntervalMs,
      );
    }
  } catch (error) {
    await session.release();
    throw error;
  }
}

/**
 * Whether this backend still holds the db:migrate lock. Two-key advisory
 * locks appear in `pg_locks` with `objsubid = 2`; `hashtext` returns int4, and
 * the `::oid` cast maps a negative hash onto the same unsigned value the
 * catalog stores.
 */
const HELD_PROBE_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND objsubid = 2
     AND pid = pg_backend_pid()
     AND classid = (hashtext('smrt'))::oid
     AND objid = (hashtext('db:migrate'))::oid
) AS held`;

/**
 * The lock session runs one statement and then sits idle for the whole
 * migration, so a role- or database-level `idle_session_timeout` (PostgreSQL
 * 14+) would reap it first and silently free the lock. Exempt this one
 * session; older servers have no such setting.
 */
async function exemptFromIdleSessionTimeout(
  session: Awaited<
    ReturnType<NonNullable<DatabaseInterface['acquireSession']>>
  >,
): Promise<void> {
  const version = await session.query(
    "SELECT current_setting('server_version_num')::int AS version",
  );
  if (Number(version.rows?.[0]?.version) >= 140000) {
    await session.query('SET idle_session_timeout = 0');
  }
}

function resolveEngine(
  db: DatabaseInterface,
  engineHint: string | undefined,
): DatabaseEngine {
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  const url = db.url || dbWithConfig.config?.url || '';
  return detectEngine(url, engineHint);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}
