/**
 * Mutual exclusion for schema migrate runs on one PostgreSQL database
 * (#3634, #5435).
 *
 * Two runs that compare the live schema at the same time both plan the same
 * batch, and the second fails part way (`42701 column ... already exists`).
 * Every migrate entry point therefore takes one advisory lock, held from its
 * first schema read to its migrate record: `smrt db:migrate`,
 * `migrateSmrtSchemas` on any handle, lazy activation, the app model editor,
 * and work under {@link withMigrationLock} or {@link acquireMigrationLock}.
 * A run that waited plans against what the run before it left.
 *
 * **Session run.** On a pool handle the lock is a session-level advisory lock
 * on one pinned connection, and the run's work executes on that same
 * connection (`lock.db`, the session's database). So the writer ends with its
 * lock: when the backend ends, the run's next statement fails and the server
 * rolls back its open transaction, and no other run can be migrating beside
 * it. A run needs no connection besides that one, so a pool of one works.
 * A waiting run holds no transaction and no snapshot: it polls
 * `pg_try_advisory_lock` on its session and sleeps, so it can never be the
 * older snapshot a holder's `CREATE INDEX CONCURRENTLY` waits for.
 *
 * **Caller transactions.** On a transaction handle the lock is taken at
 * transaction level with one try and no wait, and lasts until the caller's
 * COMMIT or ROLLBACK. A transaction under `REPEATABLE READ` or `SERIALIZABLE`
 * is refused: its snapshot may predate the run before it. A transaction of a
 * live run (opened on `lock.db`) runs under that run's lock.
 *
 * **Handles.** A server PostgreSQL handle is locked only when the adapter
 * that made it claims, through the connection-affinity symbol, which
 * connection all its members use; a wrapper, spread copy or proxy does not
 * inherit the claim and is refused before any statement. SQLite, DuckDB,
 * JSON and PGlite are single-process engines and take no lock.
 *
 * **One deadline.** `timeoutMs` bounds everything before the work starts,
 * from the public entry point: in-memory queues, the checkout, set-up
 * statements, every attempt and sleep. On the deadline nothing is awaited:
 * the call rejects and the session is destroyed without sending anything.
 *
 * **Lock order.** Editor tail, process activation queue, migration lock,
 * system-table bootstrap lock, backfill claim, table and row locks. A holder
 * that calls back into activation, the editor, or a migrate run on its own
 * pool handle is refused at once ({@link MigrationLockOrderError}) instead of
 * waiting at an earlier lock while holding a later one.
 */

import { getDatabaseEngine } from '../system/compatibility.js';
import { createAsyncContext } from '../utils/async-context.js';
import type { DatabaseInterface } from './types.js';

/**
 * The two-key advisory lock id every migrate run takes. The `smrt` class id
 * matches the framework's other advisory locks (system-table bootstrap uses
 * `hashtext('smrt'), hashtext('system-tables')`), so the object id alone
 * separates them. Changing either key would let a run of the new release and
 * a run of an older release migrate concurrently.
 */
export const MIGRATION_ADVISORY_LOCK_KEYS =
  "hashtext('smrt'), hashtext('db:migrate')";

/** Default bound on waiting for another run to finish: 15 minutes. */
export const DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The first `@happyvertical/sql` release whose PostgreSQL handles carry the
 * connection-affinity claim and whose sessions offer `database()` and
 * `destroy()`.
 */
export const MIGRATION_LOCK_MINIMUM_SQL_VERSION = '0.117.0';

const DEFAULT_POLL_INTERVAL_MS = 1000;
/** How long a normal release may take before the session is destroyed. */
const RELEASE_GRACE_MS = 5000;
const CONNECTION_AFFINITY = Symbol.for(
  '@happyvertical/sql/connection-affinity',
);

/** Where a timed-out call was when its deadline passed. */
export type MigrationLockTimeoutPhase = 'queue' | 'setup' | 'checkout' | 'lock';

/** Thrown when a call has not acquired the migration lock by its deadline. */
export class MigrationLockTimeoutError extends Error {
  readonly phase: MigrationLockTimeoutPhase;
  /**
   * Whether a run in this process held the lock on this database at the
   * deadline: the caller may be waiting for its own process.
   */
  readonly heldByThisProcess: boolean;
  constructor(
    public readonly waitedMs: number,
    options: {
      phase?: MigrationLockTimeoutPhase;
      heldByThisProcess?: boolean;
    } = {},
  ) {
    const phase = options.phase ?? 'lock';
    const held = options.heldByThisProcess ?? false;
    super(
      `Gave up on the migration lock after ${Math.round(waitedMs / 1000)}s (${phase}). ${
        held
          ? 'A migrate run in this process holds it: code holding acquireMigrationLock must run its work on lock.db and release it before migrating again.'
          : "Another migrate run holds it; the lock is released when that run's database connection ends."
      } Raise migrationLockTimeout (migrations.postgres.migrationLockTimeout for smrt db:migrate) if a migration legitimately runs longer.`,
    );
    this.name = 'MigrationLockTimeoutError';
    this.phase = phase;
    this.heldByThisProcess = held;
  }
}

/**
 * Thrown when the lock's connection has ended mid-run. PostgreSQL frees a
 * session lock when its backend ends, so another run may already be
 * migrating; the run must stop rather than keep applying unserialized.
 */
export class MigrationLockLostError extends Error {
  constructor(cause?: unknown) {
    super(
      'The migration lock was lost: its database connection ended mid-run, so another run may be migrating concurrently. Stopping; rerun the migration to converge.',
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MigrationLockLostError';
  }
}

/**
 * Thrown before any statement when a PostgreSQL handle cannot carry the lock:
 * it has no connection-affinity claim, its session lacks `database()` or
 * `destroy()`, or the database did not confirm the lock on the claimed
 * connection.
 */
export class MigrationLockUnsupportedError extends Error {
  constructor(detail?: string) {
    super(
      `${detail ?? 'This PostgreSQL handle cannot hold the migration lock.'} A migrate run needs a PostgreSQL handle made by @happyvertical/sql ${MIGRATION_LOCK_MINIMUM_SQL_VERSION} or later: the copy of @happyvertical/sql that created this handle must be at least that version, not only the copy smrt-core uses. A wrapper, spread copy or proxy of an adapter handle does not carry the adapter's connection-affinity claim; pass the adapter's own handle, or make the claim on the wrapper's handles.`,
    );
    this.name = 'MigrationLockUnsupportedError';
  }
}

/**
 * Thrown at once, without waiting, when a caller's transaction tries to take
 * the migration lock while another run holds it. Nothing was read; roll the
 * transaction back and retry in a new one.
 */
export class MigrationLockBusyError extends Error {
  readonly retryable = true;
  constructor() {
    super(
      'Another migrate run holds the migration lock. A caller transaction never waits for it; roll this transaction back and retry in a new one, or migrate on the database handle, which waits.',
    );
    this.name = 'MigrationLockBusyError';
  }
}

/**
 * Thrown when a caller's transaction runs at an isolation level whose
 * snapshot may predate the run before it. Nothing was acquired and the
 * transaction stays usable.
 */
export class MigrationLockIsolationError extends Error {
  constructor(public readonly isolation: string) {
    super(
      `A migrate run on a caller transaction needs READ COMMITTED; this transaction runs at ${isolation.toUpperCase()}, whose snapshot may predate the run before it. Migrate on the database handle, or in a READ COMMITTED transaction.`,
    );
    this.name = 'MigrationLockIsolationError';
  }
}

/** Why a call made inside a holder was refused. */
export type MigrationLockOrderReason =
  | 'reentry'
  | 'activation-inside-holder'
  | 'editor-inside-holder';

/**
 * Thrown at once when code holding the migration lock calls an entry point
 * that would wait at an earlier lock (the activation queue, the editor's
 * queue) or for the lock it holds (a migrate run on its own pool handle).
 */
export class MigrationLockOrderError extends Error {
  constructor(public readonly reason: MigrationLockOrderReason) {
    super(
      reason === 'reentry'
        ? 'This code holds the migration lock for this database; a migrate run on the pool handle would wait for it. Run nested work on lock.db.'
        : reason === 'activation-inside-holder'
          ? 'Lazy activation cannot start while this code holds the migration lock: activation waits in its process queue before the lock, and the queue may be waiting for this holder. Activate before taking the lock.'
          : 'The app model editor cannot open or apply an edit while this code holds the migration lock: the editor waits in its queue before the lock, and the queue may be waiting for this holder. Edit before taking the lock.',
    );
    this.name = 'MigrationLockOrderError';
  }
}

/**
 * Thrown when a second migrate operation starts on a backend that already
 * runs one, through any handle (the run's database, a transaction or
 * savepoint of it, a caller's transaction). The refused call planned
 * nothing; on a caller transaction, roll it back before retrying.
 */
export class MigrationRunOverlapError extends Error {
  constructor() {
    super(
      'A migrate operation is already running on this database connection. Await it before starting another; on a caller transaction, roll back before retrying.',
    );
    this.name = 'MigrationRunOverlapError';
  }
}

/**
 * One monotonic deadline from a public entry point, carried through queues,
 * checkouts and lock attempts. `at === null` means no deadline.
 * @internal
 */
export interface MigrationLockDeadline {
  readonly startedAt: number;
  readonly at: number | null;
  now(): number;
}

/** @internal */
export function startMigrationLockDeadline(
  timeoutMs: number | undefined = DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS,
  now: () => number = () => performance.now(),
): MigrationLockDeadline {
  const startedAt = now();
  return {
    startedAt,
    at: timeoutMs > 0 ? startedAt + timeoutMs : null,
    now,
  };
}

function remaining(deadline: MigrationLockDeadline): number {
  return deadline.at === null
    ? Number.POSITIVE_INFINITY
    : deadline.at - deadline.now();
}

function expired(deadline: MigrationLockDeadline): boolean {
  return remaining(deadline) <= 0;
}

export interface AcquireMigrationLockOptions {
  /**
   * How long to wait for the lock, in milliseconds, counted from the call:
   * the checkout, set-up statements and every attempt. `0` waits
   * indefinitely.
   * @default DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS
   */
  timeoutMs?: number;
  /** Delay between attempts while another run holds the lock. @default 1000 */
  pollIntervalMs?: number;
  /** Engine override for a handle that reports no engine. */
  engineHint?: string;
  /** Called once, when the first attempt finds the lock held. */
  onWait?: () => void;
  /** Injectable monotonic clock and sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * A deadline started by an outer entry point; replaces `timeoutMs`.
   * @internal
   */
  deadline?: MigrationLockDeadline;
}

export interface MigrationLock {
  /** False when the engine needs no lock (SQLite, DuckDB, JSON, PGlite). */
  readonly held: boolean;
  /**
   * `session`: a session lock on a pinned connection; `transaction`: a
   * transaction-level lock held to the caller's COMMIT or ROLLBACK; `none`.
   */
  readonly kind: 'session' | 'transaction' | 'none';
  /** Milliseconds spent waiting for another run; 0 when uncontended. */
  readonly waitedMs: number;
  /**
   * The handle to run the migration on. For a session lock it is the pinned
   * session's database: every statement on it runs on the backend that holds
   * the lock, and it rejects every call once the lock is released. For a
   * transaction lock, or no lock, it is the handle that was passed.
   */
  readonly db: DatabaseInterface;
  /**
   * Confirm that this run still holds the lock, and throw
   * {@link MigrationLockLostError} if its connection ended or the probe says
   * it does not. A statement error on a live connection is rethrown as it is.
   * A no-op when the engine needs no lock.
   */
  assertHeld(): Promise<void>;
  /**
   * Release the lock and its pinned connection. Idempotent. A no-op for a
   * transaction lock (the caller's transaction ends it) and for no lock.
   */
  release(): Promise<void>;
}

/** The pinned session the adapter returns, with the optional members v3 needs. */
interface PinnedSession {
  query: (
    sql: string,
    ...vars: unknown[]
  ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  isActive: () => boolean;
  release: () => Promise<void>;
  destroy?: () => void;
  database?: () => DatabaseInterface;
}

/** A live session run: from acquisition to release. */
interface SessionRun {
  readonly kind: 'session';
  readonly backend: string;
  readonly databaseKey: unknown;
  readonly db: DatabaseInterface;
  readonly session: PinnedSession;
  readonly lock: MigrationLock;
}
/** A caller transaction holding the lock for a callback or a migrate call. */
interface BorrowedOwner {
  readonly kind: 'transaction';
  readonly backend: string;
}
type BackendOwner = SessionRun | BorrowedOwner;

/** Live session runs by their database handle (`lock.db`). */
const runs = new WeakMap<object, SessionRun>();
/** Lock-owning backends, keyed `<postmaster start time>:<backend pid>`. */
const backends = new Map<string, BackendOwner>();
/** Backends running a migrate operation now. */
const operations = new Set<string>();
/** Live session runs per database, for the timeout error. */
const liveRunsByDatabase = new Map<unknown, number>();

/** The async-context entry of code running as a holder. */
interface HolderScope {
  readonly databaseKey: unknown;
  active: boolean;
  readonly outer?: HolderScope;
}
const holderScope = createAsyncContext<HolderScope>();

function activeHolderScope(): HolderScope | undefined {
  for (let scope = holderScope.getStore(); scope; scope = scope.outer)
    if (scope.active) return scope;
  return undefined;
}

/**
 * Throw {@link MigrationLockOrderError} when the calling code runs as a
 * holder of the migration lock. The first statement of every entry point
 * that would wait at an earlier lock. Async context only refuses; it grants
 * nothing, so a host without it is still correct and ends these orderings at
 * the waiter's deadline.
 * @internal
 */
export function refuseInsideMigrationLockHolder(
  reason: Exclude<MigrationLockOrderReason, 'reentry'>,
): void {
  if (activeHolderScope()) throw new MigrationLockOrderError(reason);
}

function runAsHolder<T>(databaseKey: unknown, work: () => Promise<T>) {
  const scope: HolderScope = {
    databaseKey,
    active: true,
    outer: holderScope.getStore(),
  };
  return holderScope.run(scope, async () => {
    try {
      return await work();
    } finally {
      scope.active = false;
    }
  });
}

function databaseKeyOf(db: DatabaseInterface): unknown {
  const config = (db as { config?: { url?: unknown } }).config;
  const url =
    typeof db.url === 'string' && db.url
      ? db.url
      : typeof config?.url === 'string'
        ? config.url
        : '';
  return url || db;
}

function refuseReentry(db: DatabaseInterface): void {
  const scope = activeHolderScope();
  if (scope && scope.databaseKey === databaseKeyOf(db))
    throw new MigrationLockOrderError('reentry');
}

type AffinityKind = 'pool' | 'session' | 'transaction';

/** The adapter's claim, valid only when it names this very object. */
function affinityOf(db: unknown): AffinityKind | undefined {
  if (db === null || (typeof db !== 'object' && typeof db !== 'function'))
    return undefined;
  const claim = (db as Record<symbol, unknown>)[CONNECTION_AFFINITY] as
    | { kind?: unknown; handle?: unknown }
    | undefined;
  if (!claim || claim.handle !== db) return undefined;
  return claim.kind === 'pool' ||
    claim.kind === 'session' ||
    claim.kind === 'transaction'
    ? claim.kind
    : undefined;
}

/**
 * Whether `db` is a server PostgreSQL handle for locking: the adapter's own
 * `engine` decides when it reports one (`postgres` is a server; `pglite` and
 * every other engine are not), otherwise the URL or hint.
 * @internal
 */
export function isServerPostgresHandle(
  db: DatabaseInterface,
  engineHint?: string,
): boolean {
  if (runs.has(db as object)) return true;
  const engine = (db as { engine?: unknown }).engine;
  if (typeof engine === 'string') return engine === 'postgres';
  return getDatabaseEngine(db, engineHint) === 'postgres';
}

type HandleClass =
  | { kind: 'none' }
  | { kind: 'run'; run: SessionRun }
  | { kind: 'pool' }
  | { kind: 'transaction' }
  | { kind: 'unsupported'; detail: string };

function classify(db: DatabaseInterface, engineHint?: string): HandleClass {
  const run = runs.get(db as object);
  if (run) return { kind: 'run', run };
  if (!isServerPostgresHandle(db, engineHint)) return { kind: 'none' };
  const claim = affinityOf(db);
  if (claim === 'pool' && typeof db.acquireSession === 'function')
    return { kind: 'pool' };
  if (claim === 'transaction') return { kind: 'transaction' };
  if (claim === 'session')
    return {
      kind: 'unsupported',
      detail:
        'This is a pinned session database that is not a live migrate run; migrate on the pool handle or on lock.db of a live run.',
    };
  return {
    kind: 'unsupported',
    detail:
      'This PostgreSQL handle carries no connection-affinity claim, so smrt cannot tell which connection its statements and transactions use.',
  };
}

function noLock(db: DatabaseInterface): MigrationLock {
  return {
    held: false,
    kind: 'none',
    waitedMs: 0,
    db,
    assertHeld: async () => {},
    release: async () => {},
  };
}

function timeoutError(
  deadline: MigrationLockDeadline,
  phase: MigrationLockTimeoutPhase,
  databaseKey: unknown,
): MigrationLockTimeoutError {
  return new MigrationLockTimeoutError(deadline.now() - deadline.startedAt, {
    phase,
    heldByThisProcess: (liveRunsByDatabase.get(databaseKey) ?? 0) > 0,
  });
}

/**
 * Race `promise` against the deadline. On the deadline the returned promise
 * rejects at once; when `promise` settles later, `onLate` receives its value.
 * @internal
 */
export function raceMigrationLockDeadline<T>(
  deadline: MigrationLockDeadline,
  promise: Promise<T>,
  fail: () => Error,
  onLate?: (value: T) => void,
): Promise<T> {
  if (deadline.at === null) return promise;
  const left = remaining(deadline);
  if (left <= 0) {
    void promise.then(
      (value) => onLate?.(value),
      () => {},
    );
    return Promise.reject(fail());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(fail());
      },
      Math.max(1, Math.ceil(left)),
    );
    (timer as { unref?: () => void }).unref?.();
    promise.then(
      (value) => {
        if (settled) {
          onLate?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Join an in-memory queue (the activation queue, an editor's edit queue)
 * behind `previous`, bounded by `deadline`. `result` rejects at the deadline
 * (`phase: 'queue'`) while the turn has not come; the queued turn then sees
 * it was abandoned and returns at once, so the queue is neither blocked nor
 * poisoned. Once the turn has started, `result` follows `work`, whose own
 * lock acquisition carries the same deadline. Chain the queue's tail on
 * `operation`.
 * @internal
 */
export function joinQueueWithDeadline<T>(
  previous: Promise<unknown>,
  work: () => Promise<T>,
  deadline: MigrationLockDeadline | undefined,
  databaseKey?: unknown,
): { operation: Promise<T | undefined>; result: Promise<T> } {
  let abandoned = false;
  let started = false;
  const operation = previous.then(() => {
    if (abandoned) return undefined;
    started = true;
    return work();
  });
  if (!deadline || deadline.at === null)
    return { operation, result: operation as Promise<T> };
  const result = new Promise<T>((resolve, reject) => {
    const abandon = () => {
      if (started || abandoned) return;
      abandoned = true;
      reject(timeoutError(deadline, 'queue', databaseKey));
    };
    const left = remaining(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (left <= 0) abandon();
    else {
      timer = setTimeout(abandon, Math.max(1, Math.ceil(left)));
      (timer as { unref?: () => void }).unref?.();
    }
    operation.then(
      (value) => {
        clearTimeout(timer);
        if (!abandoned) resolve(value as T);
      },
      (error) => {
        clearTimeout(timer);
        if (!abandoned) reject(error);
      },
    );
  });
  return { operation, result };
}

/** Discard a session without waiting: destroy when offered, else release. */
function discard(session: PinnedSession): void {
  try {
    if (typeof session.destroy === 'function') session.destroy();
    else void Promise.resolve(session.release()).catch(() => {});
  } catch {
    // Discarding is best effort; the server frees the lock when the
    // connection ends.
  }
}

/** Release a session normally, destroying it if release does not finish in time. */
async function releaseBounded(session: PinnedSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), RELEASE_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  const released = Promise.resolve()
    .then(() => session.release())
    .then(
      () => 'released' as const,
      () => 'failed' as const,
    );
  const outcome = await Promise.race([released, graceExpired]);
  clearTimeout(timer);
  if (outcome !== 'released') discard(session);
}

function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows)
    ? (rows[0] as Record<string, unknown> | undefined)
    : undefined;
}

function isTrue(value: unknown): boolean {
  return value === true || value === 't' || value === 'true' || value === 1;
}

/**
 * Whether this backend holds the migration lock. Two-key advisory locks
 * appear in `pg_locks` with `objsubid = 2`; `hashtext` returns int4, and the
 * `::oid` cast maps a negative hash onto the same unsigned value the catalog
 * stores.
 */
const HELD_EXPRESSION = `EXISTS (
  SELECT 1 FROM pg_locks
   WHERE locktype = 'advisory' AND granted AND objsubid = 2
     AND pid = pg_backend_pid()
     AND classid = (hashtext('smrt'))::oid
     AND objid = (hashtext('db:migrate'))::oid
)`;
const PROOF_SQL = `SELECT ${HELD_EXPRESSION} AS held, pg_backend_pid() AS pid`;
const SESSION_IDENTITY_SQL =
  "SELECT pg_backend_pid() AS pid, pg_postmaster_start_time()::text AS started, current_setting('server_version_num')::int AS version";
const TRANSACTION_IDENTITY_SQL = `SELECT pg_backend_pid() AS pid, pg_postmaster_start_time()::text AS started, current_setting('transaction_isolation') AS isolation, ${HELD_EXPRESSION} AS held`;
const TRY_SESSION_SQL = `SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS acquired`;
const TRY_TRANSACTION_SQL = `SELECT pg_try_advisory_xact_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS acquired`;

function backendKey(row: Record<string, unknown> | undefined) {
  const pid = row?.pid;
  const started = row?.started;
  if (
    (typeof pid !== 'number' && typeof pid !== 'string') ||
    String(pid) === '' ||
    typeof started !== 'string' ||
    started === ''
  )
    return undefined;
  return { pid: String(pid), key: `${started}:${pid}` };
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Acquire the session lock on a pinned connection of `db` (2.2 steps 1-6).
 * On any failure before it returns, the session is discarded without
 * waiting, and the call rejects.
 */
async function acquireSessionRun(
  db: DatabaseInterface,
  options: AcquireMigrationLockOptions,
  deadline: MigrationLockDeadline,
): Promise<{ run: SessionRun; finish: () => Promise<void> }> {
  const databaseKey = databaseKeyOf(db);
  const fail = (phase: MigrationLockTimeoutPhase) => () =>
    timeoutError(deadline, phase, databaseKey);
  if (expired(deadline)) throw fail('checkout')();
  const session = (await raceMigrationLockDeadline(
    deadline,
    Promise.resolve().then(() =>
      (db.acquireSession as () => Promise<PinnedSession>)(),
    ),
    fail('checkout'),
    (late) => discard(late),
  )) as PinnedSession;
  if (
    typeof session.database !== 'function' ||
    typeof session.destroy !== 'function'
  ) {
    discard(session);
    throw new MigrationLockUnsupportedError(
      'This PostgreSQL adapter pins a session without database() or destroy(), so the migration cannot run on the connection that holds its lock.',
    );
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const statement = (sql: string) =>
    raceMigrationLockDeadline(deadline, session.query(sql), fail('lock'));
  let run: SessionRun;
  try {
    const identity = firstRow(await statement(SESSION_IDENTITY_SQL));
    const backend = backendKey(identity);
    if (!backend)
      throw new MigrationLockUnsupportedError(
        'The lock session did not report its backend.',
      );
    if (Number(identity?.version) >= 140000) {
      // The lock session can sit idle between the run's statements; a role-
      // or database-level idle_session_timeout would reap it and free the
      // lock. Older servers have no such setting.
      await statement('SET idle_session_timeout = 0');
      // A session destroyed on the deadline path keeps its lock until its
      // backend notices the closed connection; a backend busy in a statement
      // notices only when it next talks to the client. Check the connection
      // once a second so that wait is bounded. Before PostgreSQL 14 there is
      // no such check: the lock is freed when that statement ends.
      await statement("SET client_connection_check_interval = '1s'");
    }
    let waited = false;
    while (true) {
      if (expired(deadline)) throw fail('lock')();
      const attempt = firstRow(await statement(TRY_SESSION_SQL));
      if (isTrue(attempt?.acquired)) break;
      if (!waited) {
        waited = true;
        options.onWait?.();
      }
      if (expired(deadline)) throw fail('lock')();
      await sleep(Math.max(1, Math.min(pollIntervalMs, remaining(deadline))));
    }
    const proof = firstRow(await statement(PROOF_SQL));
    if (!isTrue(proof?.held) || String(proof?.pid) !== backend.pid)
      throw new MigrationLockUnsupportedError(
        'The database did not confirm the migration lock on the connection the adapter pinned.',
      );
    const runDb = session.database();
    const waitedMs = waited ? deadline.now() - deadline.startedAt : 0;
    let released = false;
    const lock: MigrationLock = {
      held: true,
      kind: 'session',
      waitedMs,
      db: runDb,
      assertHeld: async () => {
        if (released || !session.isActive()) throw new MigrationLockLostError();
        let probe: Record<string, unknown> | undefined;
        try {
          probe = firstRow(await session.query(PROOF_SQL));
        } catch (error) {
          if (!session.isActive()) throw new MigrationLockLostError(error);
          throw error;
        }
        if (!isTrue(probe?.held)) throw new MigrationLockLostError();
      },
      release: async () => {
        if (released) return;
        released = true;
        await finish();
      },
    };
    run = {
      kind: 'session',
      backend: backend.key,
      databaseKey,
      db: runDb,
      session,
      lock,
    };
    let finished: Promise<void> | undefined;
    const finish = () => {
      finished ??= (async () => {
        released = true;
        runs.delete(runDb as object);
        if (backends.get(run.backend) === run) backends.delete(run.backend);
        const count = (liveRunsByDatabase.get(databaseKey) ?? 1) - 1;
        if (count > 0) liveRunsByDatabase.set(databaseKey, count);
        else liveRunsByDatabase.delete(databaseKey);
        await releaseBounded(session);
      })();
      return finished;
    };
    runs.set(runDb as object, run);
    backends.set(run.backend, run);
    liveRunsByDatabase.set(
      databaseKey,
      (liveRunsByDatabase.get(databaseKey) ?? 0) + 1,
    );
    return { run, finish };
  } catch (error) {
    discard(session);
    throw error;
  }
}

/** A caller transaction's lock: held to its COMMIT or ROLLBACK. */
interface TransactionLock {
  lock: MigrationLock;
  backend: string;
  /** The transaction belongs to a live session run. */
  ofLiveRun: boolean;
}

/** The transaction rules (2.5): at most three statements, never waiting. */
async function lockTransaction(
  db: DatabaseInterface,
  deadline: MigrationLockDeadline,
): Promise<TransactionLock> {
  const databaseKey = databaseKeyOf(db);
  const statement = (sql: string) =>
    raceMigrationLockDeadline(deadline, db.query(sql), () =>
      timeoutError(deadline, 'lock', databaseKey),
    );
  if (expired(deadline)) throw timeoutError(deadline, 'lock', databaseKey);
  const identity = firstRow(await statement(TRANSACTION_IDENTITY_SQL));
  const backend = backendKey(identity);
  if (!backend)
    throw new MigrationLockUnsupportedError(
      'The transaction did not report its backend.',
    );
  const lockOf = (): MigrationLock => ({
    held: true,
    kind: 'transaction',
    waitedMs: 0,
    db,
    assertHeld: async () => {
      let probe: Record<string, unknown> | undefined;
      try {
        probe = firstRow(await db.query(PROOF_SQL));
      } catch (error) {
        throw new MigrationLockLostError(error);
      }
      if (!isTrue(probe?.held)) throw new MigrationLockLostError();
    },
    release: async () => {},
  });
  const owner = backends.get(backend.key);
  if (owner?.kind === 'session')
    // It began after the run acquired, so any isolation is safe.
    return { lock: lockOf(), backend: backend.key, ofLiveRun: true };
  const isolation = String(identity?.isolation ?? '').toLowerCase();
  if (isolation !== 'read committed' && isolation !== 'read uncommitted')
    throw new MigrationLockIsolationError(isolation || 'unknown');
  if (!isTrue(identity?.held)) {
    const attempt = firstRow(await statement(TRY_TRANSACTION_SQL));
    if (!isTrue(attempt?.acquired)) throw new MigrationLockBusyError();
    const proof = firstRow(await statement(PROOF_SQL));
    if (!isTrue(proof?.held) || String(proof?.pid) !== backend.pid)
      throw new MigrationLockUnsupportedError(
        'The database did not confirm the migration lock on the transaction the adapter claimed.',
      );
  }
  return { lock: lockOf(), backend: backend.key, ofLiveRun: false };
}

/** Run `work` with a borrowed transaction registered as its backend's owner. */
async function asBorrowedOwner<T>(
  db: DatabaseInterface,
  held: TransactionLock,
  work: () => Promise<T>,
): Promise<T> {
  if (held.ofLiveRun) return work();
  const registered = !backends.has(held.backend);
  const owner: BorrowedOwner = { kind: 'transaction', backend: held.backend };
  if (registered) backends.set(held.backend, owner);
  try {
    return await runAsHolder(databaseKeyOf(db), work);
  } finally {
    if (registered && backends.get(held.backend) === owner)
      backends.delete(held.backend);
  }
}

function startDeadline(
  options: AcquireMigrationLockOptions,
): MigrationLockDeadline {
  return (
    options.deadline ??
    startMigrationLockDeadline(
      options.timeoutMs ?? DEFAULT_MIGRATION_LOCK_WAIT_TIMEOUT_MS,
      options.now,
    )
  );
}

/**
 * Take the migration lock and return it; release it in a `finally`.
 *
 * Run the migration on `lock.db`: on PostgreSQL that is the pinned session
 * that holds the lock, and a migrate call on the original pool handle waits
 * for this lock like any other run. Code between this call and `release()`
 * runs as no holder scope, so it is not refused anything; it ends at its
 * deadline instead.
 *
 * | Handle | Lock |
 * | --- | --- |
 * | PostgreSQL pool handle | session lock on a pinned connection; `lock.db` is that session |
 * | PostgreSQL transaction handle | transaction-level lock, one try, no wait; `lock.db` is the transaction |
 * | `lock.db` of a live run | that run's lock |
 * | SQLite, DuckDB, JSON, PGlite | none (`held: false`, `lock.db === db`) |
 */
export async function acquireMigrationLock(
  db: DatabaseInterface,
  options: AcquireMigrationLockOptions = {},
): Promise<MigrationLock> {
  const deadline = startDeadline(options);
  const target = classify(db, options.engineHint);
  switch (target.kind) {
    case 'none':
      return noLock(db);
    case 'run':
      return { ...target.run.lock, release: async () => {} };
    case 'pool': {
      refuseReentry(db);
      const { run } = await acquireSessionRun(db, options, deadline);
      return run.lock;
    }
    case 'transaction':
      return (await lockTransaction(db, deadline)).lock;
    default:
      throw new MigrationLockUnsupportedError(target.detail);
  }
}

/**
 * Run `work` holding the migration lock, waiting for a concurrent run first.
 * Read and plan inside `work`, on `lock.db`, so a run that waited plans
 * against what the run before it left.
 *
 * The handle decides the lock (see {@link acquireMigrationLock}). On a pool
 * handle the lock is released when `work` settles; on a transaction it lasts
 * to the caller's COMMIT or ROLLBACK. Inside `work`, lazy activation, the
 * app model editor and a migrate run on the same pool handle are refused
 * ({@link MigrationLockOrderError}); nested migrate work runs on `lock.db` or
 * a transaction of it.
 */
export async function withMigrationLock<T>(
  db: DatabaseInterface,
  work: (lock: MigrationLock) => Promise<T>,
  options: AcquireMigrationLockOptions = {},
): Promise<T> {
  const deadline = startDeadline(options);
  const target = classify(db, options.engineHint);
  switch (target.kind) {
    case 'none':
      return work(noLock(db));
    case 'run':
      return work(target.run.lock);
    case 'pool': {
      refuseReentry(db);
      return runSession(db, options, deadline, (run) => work(run.lock));
    }
    case 'transaction': {
      const held = await lockTransaction(db, deadline);
      return asBorrowedOwner(db, held, () => work(held.lock));
    }
    default:
      throw new MigrationLockUnsupportedError(target.detail);
  }
}

async function runSession<T>(
  db: DatabaseInterface,
  options: AcquireMigrationLockOptions,
  deadline: MigrationLockDeadline,
  work: (run: SessionRun) => Promise<T>,
): Promise<T> {
  const { run, finish } = await acquireSessionRun(db, options, deadline);
  try {
    return await runAsHolder(run.databaseKey, () => work(run));
  } finally {
    await finish();
  }
}

function withOperation<T>(backend: string, work: () => Promise<T>): Promise<T> {
  if (operations.has(backend))
    return Promise.reject(new MigrationRunOverlapError());
  operations.add(backend);
  return (async () => {
    try {
      return await work();
    } finally {
      operations.delete(backend);
    }
  })();
}

/**
 * Run one migrate operation under the migration lock: the entry point
 * `migrateSmrtSchemas` uses. On a pool handle a session run; on a live run's
 * handle or a transaction of it, that run's lock; on a caller's transaction,
 * the transaction rules. A second operation on the same backend is refused
 * before it plans. Must be called synchronously from the public entry point.
 * @internal
 */
export function runMigrationOperation<T>(
  db: DatabaseInterface,
  options: AcquireMigrationLockOptions,
  work: (db: DatabaseInterface, lock: MigrationLock) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(options);
  let target: HandleClass;
  try {
    target = classify(db, options.engineHint);
    if (target.kind === 'pool') refuseReentry(db);
  } catch (error) {
    return Promise.reject(error);
  }
  switch (target.kind) {
    case 'none':
      return work(db, noLock(db));
    case 'run': {
      const run = target.run;
      return withOperation(run.backend, () => work(db, run.lock));
    }
    case 'pool':
      return runSession(db, options, deadline, (run) =>
        withOperation(run.backend, () => work(run.db, run.lock)),
      );
    case 'transaction':
      return lockTransaction(db, deadline).then((held) =>
        withOperation(held.backend, () =>
          asBorrowedOwner(db, held, () => work(db, held.lock)),
        ),
      );
    default:
      return Promise.reject(new MigrationLockUnsupportedError(target.detail));
  }
}

/**
 * The live run's session for the tracker's pinned-session phases, when `db`
 * is a live run's handle: statements on the run's connection, and a
 * `release()` that only resets the session timeouts the phase set.
 * @internal
 */
export function borrowMigrationRunSession(db: DatabaseInterface):
  | {
      query: (
        sql: string,
        ...vars: unknown[]
      ) => Promise<{ rows: Record<string, unknown>[] }>;
      release: () => Promise<void>;
    }
  | undefined {
  const run = runs.get(db as object);
  if (!run) return undefined;
  const query = (sql: string, ...vars: unknown[]) =>
    run.db.query(sql, ...vars) as Promise<{ rows: Record<string, unknown>[] }>;
  return {
    query,
    release: async () => {
      // Best effort: on a lost connection the run's next statement fails on
      // its own, and the phase's result must not be replaced by this error.
      await query('RESET lock_timeout')
        .then(() => query('RESET statement_timeout'))
        .catch(() => {});
    },
  };
}
