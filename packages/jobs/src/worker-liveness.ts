import { detectEngine } from '@happyvertical/smrt-core';
import type {
  DatabaseInterface,
  ReopenOptions,
  DatabaseEngine as SqlEngine,
} from '@happyvertical/sql';
import { createId } from '@happyvertical/utils';

type DatabaseEngine = ReturnType<typeof detectEngine>;

/**
 * Worker liveness primitives shared by {@link ../runner.js} and
 * {@link ../schedule-runner.js}.
 *
 * Job recovery keys on whether a job's *owning worker* is alive, never on
 * per-job heartbeat freshness (issue #1474). "Alive" has two independent
 * sources, combined by {@link isWorkerAlive}:
 *
 * 1. **Process-global live set** — an in-memory {@link Set} of worker keys
 *    whose runner is live *in this process*. Checked synchronously, so it can
 *    never be starved by a CPU-bound handler holding the event loop. Covers
 *    every same-process topology (a runner's own jobs, a co-located
 *    ScheduleRunner, a second in-process runner).
 * 2. **Database lease** — a `_smrt_workers` row whose `lease_expires_at` is
 *    still in the future. Covers cross-process recovery. The lease is renewed
 *    by the owning runner; a dead worker stops renewing and its lease expires.
 *
 * The live set takes precedence: a worker live in this process is alive even
 * if its database lease looks stale.
 *
 * The lease is compared against the recovering host's clock (the same approach
 * the previous heartbeat recovery used), so it is no more sensitive to clock
 * skew than the code it replaces. For eligible engines the lease is renewed off
 * the main loop by a worker thread (see worker-liveness-ticker.ts) so a blocked
 * handler can't starve it; otherwise it is renewed on the main loop and the
 * live set covers same-process correctness.
 */

const LIVE_WORKERS_KEY = '__smrtLiveWorkers';

type GlobalWithLiveWorkers = typeof globalThis & {
  [LIVE_WORKERS_KEY]?: Set<string>;
};

function liveWorkers(): Set<string> {
  const g = globalThis as GlobalWithLiveWorkers;
  let set = g[LIVE_WORKERS_KEY];
  if (!set) {
    // Singleton on globalThis so it survives HMR / duplicate module instances,
    // mirroring the ObjectRegistry pattern.
    set = new Set<string>();
    g[LIVE_WORKERS_KEY] = set;
  }
  return set;
}

/** Mark a worker key as live in this process. */
export function registerLiveWorker(workerKey: string): void {
  liveWorkers().add(workerKey);
}

/** Remove a worker key from this process's live set. */
export function unregisterLiveWorker(workerKey: string): void {
  liveWorkers().delete(workerKey);
}

/** Whether a worker key is live in this process. */
export function isLiveWorker(workerKey: string): boolean {
  return liveWorkers().has(workerKey);
}

/** Snapshot of every worker key live in this process. */
export function liveWorkerKeys(): Set<string> {
  return new Set(liveWorkers());
}

/**
 * Whether a worker is alive: live in *this* process (synchronous truth, never
 * starved), or holding a fresh database lease in some process. `null`/unknown
 * worker keys are never alive.
 */
export function isWorkerAlive(
  workerKey: string | null | undefined,
  freshLeaseKeys: Set<string>,
): boolean {
  if (!workerKey) return false;
  return isLiveWorker(workerKey) || freshLeaseKeys.has(workerKey);
}

/**
 * Build a per-incarnation-unique worker key.
 *
 * Recovery treats a worker key as the unit of liveness, so the key must be
 * unique per process incarnation: a runner that crashes and restarts under the
 * same configured `id` must get a *new* key, otherwise its orphaned `running`
 * jobs would look owned by the live restart and never be recovered. We append
 * a random token to the (optional) configured id, which also keeps the
 * human-facing runner id stable for logs/events.
 */
export function createWorkerKey(baseId: string): string {
  return `${baseId}~${createId().slice(0, 8)}`;
}

/**
 * The connection URL, honoring adapters that leave `db.url` empty and carry the
 * real URL on `db.config.url`. Used consistently for engine detection, the
 * in-memory check, and the URL handed to the off-loop thread so they never
 * disagree.
 */
export function resolveUrl(db: DatabaseInterface): string {
  const withConfig = db as DatabaseInterface & { config?: { url?: string } };
  return db.url || withConfig.config?.url || '';
}

/**
 * Busy timeout, in milliseconds, applied to the runner's SQLite connection and
 * to the liveness thread's reopened connection. It matches the value the local
 * runtime sets on its own connection (`tuneLocalSqlite` in
 * `@happyvertical/smrt-app-runtime`). Neither SQLite engine waits for a lock
 * by default, and a reopened connection does not inherit the first one's
 * PRAGMAs.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Tune a SQLite connection for the off-loop liveness topology.
 *
 * The runner's main connection and the off-loop ticker's connection both touch
 * the same file. Stock libsql/SQLite opens in rollback-journal mode with no busy
 * timeout, so the instant two connections contend it returns `SQLITE_BUSY` —
 * surfacing as a flaky "Failed to execute raw query" under CI load. WAL lets
 * readers run concurrently with the single writer, and `busy_timeout` makes a
 * contended writer wait for the lock instead of failing immediately. Both are
 * idempotent and file-level (WAL persists for every connection to the file).
 *
 * Best-effort: a PRAGMA failure must never break startup — the in-process live
 * set keeps same-process recovery correct regardless. Callers gate this on a
 * SQLite engine so it is never issued to Postgres.
 */
export async function tuneSqliteForConcurrency(
  db: DatabaseInterface,
): Promise<void> {
  try {
    await db.query(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    await db.query('PRAGMA journal_mode = WAL');
  } catch {
    // Best-effort connection tuning.
  }
}

/** Resolve the database engine for a connection. */
export function resolveEngine(db: DatabaseInterface): DatabaseEngine {
  const withConfig = db as DatabaseInterface & {
    config?: { type?: string };
    type?: string;
  };
  const type = withConfig.type || withConfig.config?.type;
  return detectEngine(resolveUrl(db), type);
}

/**
 * Whether a connection points at an in-memory SQLite database. In-memory
 * databases are single-process (nothing to recover cross-process) and a second
 * connection cannot see the same data, so the off-loop liveness thread is
 * skipped for them.
 */
export function isInMemory(db: DatabaseInterface): boolean {
  const url = resolveUrl(db).toLowerCase();
  return (
    url === ':memory:' ||
    url.includes('mode=memory') ||
    url.includes('file::memory:')
  );
}

/**
 * How the off-loop liveness thread gets its database connection, or why it
 * must not run.
 *
 * - `reopen`: file-backed SQLite whose connection can be reopened on the same
 *   engine (`db.engine` plus `db.reopenOptions()`). The thread opens exactly
 *   those options and checks that the engine it got is `engine`.
 * - `url`: PostgreSQL, which has no second-engine hazard. The thread builds its
 *   own pooled connection from the URL, as it always has.
 * - `none`: no safe second connection; the runner renews the lease on its own
 *   connection from the main loop and logs `reason` once.
 *
 * Two SQLite engines (`node:sqlite`, `@libsql/client`) hold their own copy of
 * SQLite whose file locks do not coordinate, so a second connection on the
 * other engine can corrupt a WAL file (#4978). A connection that does not say
 * which engine it uses is treated as unsafe to share.
 */
export type LivenessConnectionPlan =
  | {
      kind: 'reopen';
      engine: SqlEngine;
      reopen: ReopenOptions;
    }
  | { kind: 'url'; url: string; type: string }
  | { kind: 'none'; reason: string };

/** Decide how (and whether) the liveness thread may open its connection. */
export function planLivenessConnection(
  db: DatabaseInterface,
  platform: NodeJS.Platform = process.platform,
): LivenessConnectionPlan {
  const engine = resolveEngine(db);
  if (engine === 'postgres') {
    return { kind: 'url', url: resolveUrl(db), type: engine };
  }
  if (engine !== 'sqlite') {
    return {
      kind: 'none',
      reason: `the ${engine} engine has one owner per database`,
    };
  }
  if (isInMemory(db)) {
    return {
      kind: 'none',
      reason:
        'an in-memory SQLite database cannot be reached by a second connection',
    };
  }
  const dbEngine = db.engine;
  if (dbEngine !== 'node-sqlite' && dbEngine !== 'libsql') {
    return {
      kind: 'none',
      reason:
        'the connection does not report which SQLite engine it uses, so a second connection may use a different engine on the same file',
    };
  }
  if (typeof db.reopenOptions !== 'function') {
    return {
      kind: 'none',
      reason: 'the connection cannot give options to reopen the same database',
    };
  }
  let reopen: ReopenOptions;
  try {
    reopen = db.reopenOptions();
  } catch (error) {
    return {
      kind: 'none',
      reason: `the connection cannot be reopened on the same engine (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
  if (
    platform === 'win32' &&
    dbEngine === 'node-sqlite' &&
    (reopen as { secureFile?: unknown }).secureFile
  ) {
    return {
      kind: 'none',
      reason:
        'on Windows the secure SQLite custody verifier cannot be handed to a worker thread',
    };
  }
  return { kind: 'reopen', engine: dbEngine, reopen };
}
