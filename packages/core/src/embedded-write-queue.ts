import type { DatabaseInterface } from '@happyvertical/sql';
import { NestedTransactionError } from './host.js';
import { noteNativeDuckDbHandle } from './native-duckdb.js';
import { inheritDatabaseSyncDeviceId } from './sync-device.js';
import { createAsyncContext } from './utils/async-context.js';
import { isPerConnectionMemoryUrl } from './utils/database-url.js';

/**
 * In-process write serialization for embedded database engines (#2360).
 *
 * File-backed SQLite (libsql) allows one writer at a time and the SDK opens a
 * NEW connection for every null-aware upsert attempt (`transaction("write")`),
 * with no busy timeout on either connection. Any other write on the root
 * connection while such a transaction is open — most commonly the change-feed
 * append that follows every model save — collides as `SQLITE_BUSY`, and under
 * sustained concurrency (a `Promise.all` of creates) the two sides livelock
 * through every retry tier. Before the tenant-led conflict target (#2360) the
 * null-aware path was rare (custom conflict keys with NULL values, #1246);
 * with `tenant_id` leading every tenant-scoped default key, EVERY NULL-tenant
 * (global) create takes it, so the collision became the steady state.
 *
 * The queue makes the process a single writer per embedded database for:
 *
 * - a `save()` whose upsert conflict values contain NULL (the only shape the
 *   SDK routes through a second-connection transaction), and
 * - the change-feed append (a root-connection write that follows every save).
 * - every model save and delete, so the embedded revision-CAS compare/upsert
 *   fallback cannot race an ordinary save, natural-key create, or delete.
 * - a complete root `SmrtObject.withTransaction()` callback, with writes on
 *   its bound handle re-entering the same hold instead of self-deadlocking.
 *
 * Ordinary save/delete holds contain database calls only — never an
 * interceptor or hook. Explicit transaction callbacks are caller-controlled,
 * so their bound model writes re-enter the existing hold. PostgreSQL is never
 * serialized here:
 * its null-aware upsert already arbitrates through advisory locks
 * server-side, and cross-process writers exist that an in-process queue could
 * not order anyway (which is also why this queue is a mitigation for embedded
 * engines' in-process writers, not a cross-process guarantee — embedded
 * engines have no cross-process writers in supported deployments).
 */

/** Queue tail per database identity (URL string, or the handle itself). */
const urlQueues = new Map<string, Promise<unknown>>();
const handleQueues = new WeakMap<object, Promise<unknown>>();
const remoteLibSqlHandles = new WeakSet<object>();
const activeQueueKeys = createAsyncContext<ReadonlySet<string | object>>();
const frameworkTransactions =
  createAsyncContext<ReadonlySet<DatabaseInterface>>();

/**
 * Work to run once a framework transaction has committed, one frame per
 * active transaction (innermost last). See {@link deferUntilFrameworkCommit}.
 */
interface CommitFrame {
  /** The transaction's bound handle. */
  readonly handle: DatabaseInterface;
  /** The root database the outermost transaction was opened on. */
  readonly root: DatabaseInterface;
  readonly callbacks: Array<(root: DatabaseInterface) => void>;
}
const commitFrames = createAsyncContext<readonly CommitFrame[]>();

/**
 * Run `callback` after the framework transaction that `db` is bound to has
 * committed, and never if it rolls back. The callback receives the root
 * database the transaction was opened on — the handle other parties key
 * their subscriptions by, since a transaction's bound handle can carry a
 * different identity. Returns false — and does nothing —
 * when `db` is not the handle of an active framework transaction in this
 * async context; the caller then runs the work itself.
 *
 * Exists for side effects that announce a write to other parties, such as
 * the change feed's live signals: announced before commit, a write a later
 * rollback undoes is still announced, and on engines that allocate the feed
 * sequence inside the transaction a rollback frees that sequence for the next
 * write — so a client that dedupes by sequence drops the real change. A nested
 * framework transaction on the same handle hands its callbacks to the
 * enclosing one, so they wait for the outermost commit. Hosts without async
 * context propagation (a browser) cannot see the frame and run the work
 * immediately, as before.
 */
export function deferUntilFrameworkCommit(
  db: DatabaseInterface,
  callback: (root: DatabaseInterface) => void,
): boolean {
  const frames = commitFrames.getStore();
  if (!frames) return false;
  for (let index = frames.length - 1; index >= 0; index--) {
    if (frames[index].handle === db) {
      frames[index].callbacks.push(callback);
      return true;
    }
  }
  return false;
}

/**
 * The root database behind `db`: the database the outermost framework
 * transaction was opened on when `db` is the handle of an active framework
 * transaction in this async context, otherwise `db` itself.
 */
export function resolveFrameworkTransactionRoot(
  db: DatabaseInterface,
): DatabaseInterface {
  const frames = commitFrames.getStore();
  if (frames) {
    for (let index = frames.length - 1; index >= 0; index--) {
      if (frames[index].handle === db) return frames[index].root;
    }
  }
  return db;
}

function runCommitCallbacks(
  callbacks: Array<(root: DatabaseInterface) => void>,
  root: DatabaseInterface,
): void {
  for (const callback of callbacks) {
    try {
      callback(root);
    } catch {
      // A post-commit announcement must never fail the committed write.
    }
  }
}

/**
 * Run `operation` with none of the caller's write-queue holds, framework
 * transactions or commit frames in its async context.
 *
 * For long-lived background work that is merely *started* from inside a
 * hold — such as an `_events` stream woken by a signal a commit callback
 * published. Without this, every later await of that work would inherit the
 * hold and treat itself as re-entrant, so its reads would no longer wait for
 * transactions that open afterwards.
 */
export function runOutsideWriteContext<T>(operation: () => T): T {
  return activeQueueKeys.run(new Set(), () =>
    frameworkTransactions.run(new Set(), () => commitFrames.run([], operation)),
  );
}

/**
 * Whether the caller's async context holds the write queue for `db` — it is
 * running inside a framework write transaction or another queue hold on that
 * database. Work that must wait for the queue (a detached feed read) and is
 * awaited from here can never complete.
 */
export function holdsWriteQueue(db: DatabaseInterface): boolean {
  const active = activeQueueKeys.getStore();
  if (!active || active.size === 0) return false;
  return (
    active.has(queueKey(db)) ||
    active.has(queueKey(resolveFrameworkTransactionRoot(db)))
  );
}

/** Whether this exact handle belongs to a currently active framework transaction. */
export function isFrameworkTransactionHandle(db: DatabaseInterface): boolean {
  return frameworkTransactions.getStore()?.has(db) === true;
}

const callerTransactions = new WeakMap<DatabaseInterface, number>();

/**
 * Pass the exact bound handle of a transaction the caller already opened.
 * Never pass a root executor. Embedded guarded writes can reuse this scope.
 * The caller owns commit and rollback.
 */
export async function withCallerOwnedDatabaseTransaction<T>(
  db: DatabaseInterface,
  operation: () => Promise<T>,
): Promise<T> {
  // The exact handle is bound to the caller's transaction, independent of
  // which promise uses it. Count overlapping scopes and release on rejection.
  callerTransactions.set(db, (callerTransactions.get(db) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (callerTransactions.get(db) ?? 1) - 1;
    if (remaining) callerTransactions.set(db, remaining);
    else callerTransactions.delete(db);
  }
}

export function isKnownDatabaseTransaction(db: DatabaseInterface): boolean {
  return isFrameworkTransactionHandle(db) || callerTransactions.has(db);
}

interface QueueableDatabase {
  url?: string;
  client?: unknown;
}

/**
 * Whether `db` is an embedded engine (SQLite/DuckDB/JSON/PGlite — anything that is
 * not PostgreSQL). Handles without a URL are treated as embedded: serializing
 * them is at worst a throughput cost, while not serializing an embedded
 * handle reintroduces the livelock.
 */
export function isEmbeddedDatabase(db: QueueableDatabase): boolean {
  return !isPostgresDatabase(db);
}

/** Whether `db` connects to a PostgreSQL server. */
export function isPostgresDatabase(db: QueueableDatabase): boolean {
  return /^postgres(?:ql)?:/iu.test(db?.url ?? '');
}

/**
 * Whether raw SQL should use PostgreSQL syntax. The SDK's PGlite root
 * exposes the PGlite client, while its bound handles expose a wrapper with
 * same `query` and `exec` pair, which the SQLite, DuckDB and JSON adapters
 * do not expose together. The URL is just a data directory on both
 * PGlite handles. PGlite remains embedded for concurrency and revision
 * fallback decisions.
 */
export function usesPostgresDialect(db: QueueableDatabase): boolean {
  if (isPostgresDatabase(db)) return true;
  const client = db?.client as { query?: unknown; exec?: unknown } | undefined;
  return (
    typeof client?.query === 'function' && typeof client.exec === 'function'
  );
}

/**
 * Whether revision compare-and-swap needs the process-local read/upsert path.
 *
 * DuckDB/JSON cannot express the timestamp predicate through the generic
 * update API, and local SQLite has only the process's writers in supported
 * deployments. Remote LibSQL/Turso is different: other processes may write
 * the same database, so it must use one conditional UPDATE at the server.
 */
export function usesEmbeddedRevisionFallback(db: QueueableDatabase): boolean {
  const url = db?.url ?? '';
  return (
    isEmbeddedDatabase(db) &&
    !remoteLibSqlHandles.has(db) &&
    !/^(?:https?|libsql):\/\//iu.test(url)
  );
}

export { isPerConnectionMemoryUrl };

function queueKey(db: QueueableDatabase): string | object {
  if (typeof db?.url !== 'string' || db.url.length === 0) return db;
  return isPerConnectionMemoryUrl(db.url) ? db : db.url;
}

/**
 * Run `operation` after every previously queued write on the same database
 * has settled. When `serialize` is false the operation runs immediately.
 */
export async function withEmbeddedWriteQueue<T>(
  db: QueueableDatabase,
  serialize: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  // Re-entry into a held queue is recognized through async-local state. A host
  // without it (a browser) cannot tell a nested write from an independent one,
  // and queueing the nested write behind its own parent would deadlock, so it
  // runs unqueued there; its only database is PGlite, which serializes
  // statements itself.
  if (!serialize || !activeQueueKeys.propagatesAcrossAwait) return operation();

  const key = queueKey(db);
  const active = activeQueueKeys.getStore();
  if (active?.has(key)) return operation();
  const previous =
    (typeof key === 'string' ? urlQueues.get(key) : handleQueues.get(key)) ??
    Promise.resolve();
  const run = () =>
    activeQueueKeys.run(new Set([...(active ?? []), key]), operation);
  const next = previous.then(run, run);
  // The stored tail must never reject, or one failed write would poison the
  // queue for every later writer.
  const tail = next.catch(() => undefined);
  if (typeof key === 'string') {
    urlQueues.set(key, tail);
    void tail.finally(() => {
      if (urlQueues.get(key) === tail) urlQueues.delete(key);
    });
  } else {
    handleQueues.set(key, tail);
  }
  return next;
}

/**
 * Serialize a complete embedded root transaction with ordinary model writes.
 * The transaction handle is registered as a reentrant alias so saves and
 * change-feed appends inside the callback do not queue behind their own root
 * transaction.
 */
export async function withEmbeddedWriteTransaction<T>(
  db: DatabaseInterface,
  serialize: boolean,
  operation: (transaction: DatabaseInterface) => Promise<T>,
  reuseUnsupportedNested = false,
): Promise<T> {
  const transaction = db.transaction?.bind(db);
  if (!transaction) {
    throw new Error('Database transaction support is required');
  }
  // The transaction handle carries no adapter markers: identify the root.
  noteNativeDuckDbHandle(db);
  // Frames of the framework transactions enclosing this call. When `db` is
  // one of their handles, this transaction is nested inside it and commits
  // only with it.
  const outerFrames = commitFrames.getStore() ?? [];
  let enclosing: CommitFrame | undefined;
  for (const candidate of outerFrames) {
    if (candidate.handle === db) enclosing = candidate;
  }
  return withEmbeddedWriteQueue(db, serialize, async () => {
    let entered = false;
    let frame: CommitFrame | null = null;
    try {
      const result = await transaction((bound) => {
        entered = true;
        inheritDatabaseSyncDeviceId(db, bound);
        if (isEmbeddedDatabase(db) && !usesEmbeddedRevisionFallback(db)) {
          remoteLibSqlHandles.add(bound);
        }
        frame = { handle: bound, root: enclosing?.root ?? db, callbacks: [] };
        const frames = [...outerFrames, frame];
        return commitFrames.run(frames, () =>
          frameworkTransactions.run(
            new Set([...(frameworkTransactions.getStore() ?? []), bound]),
            () => {
              if (!serialize) return operation(bound);
              const active = activeQueueKeys.getStore();
              return activeQueueKeys.run(
                new Set([...(active ?? []), queueKey(bound)]),
                () => operation(bound),
              );
            },
          ),
        );
      });
      const committed = (frame as CommitFrame | null)?.callbacks ?? [];
      if (committed.length > 0) {
        if (enclosing) enclosing.callbacks.push(...committed);
        else runCommitCallbacks(committed, db);
      }
      return result;
    } catch (error) {
      // The SDK explicitly refuses no-savepoint nesting before invoking the
      // callback or touching the enclosing transaction. A helper that needs
      // the caller's atomic scope can use that existing handle directly. Never
      // replay work when the callback ran, even if it threw the same error.
      if (
        reuseUnsupportedNested &&
        !entered &&
        error instanceof NestedTransactionError
      ) {
        return operation(db);
      }
      throw error;
    }
  });
}
