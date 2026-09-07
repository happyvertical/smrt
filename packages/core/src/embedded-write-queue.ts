import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseInterface } from '@happyvertical/sql';

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
const activeQueueKeys = new AsyncLocalStorage<ReadonlySet<string | object>>();

interface QueueableDatabase {
  url?: string;
}

/**
 * Whether `db` is an embedded engine (SQLite/DuckDB/JSON — anything that is
 * not PostgreSQL). Handles without a URL are treated as embedded: serializing
 * them is at worst a throughput cost, while not serializing an embedded
 * handle reintroduces the livelock.
 */
export function isEmbeddedDatabase(db: QueueableDatabase): boolean {
  return !isPostgresDatabase(db);
}

/**
 * Whether `db` is a PostgreSQL handle.
 *
 * The revision compare-and-swap predicate is dialect-specific (#2620): only
 * PostgreSQL needs the millisecond-truncating, timezone-tolerant guard, and
 * only PostgreSQL can evaluate `date_trunc`.
 */
export function isPostgresDatabase(db: QueueableDatabase): boolean {
  return /^postgres(?:ql)?:/iu.test(db?.url ?? '');
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
  return isEmbeddedDatabase(db) && !/^(?:https?|libsql):\/\//iu.test(url);
}

/**
 * Whether `url` identifies a SQLite/DuckDB in-memory database that is
 * private to its own connection, as opposed to shared state.
 *
 * Bare `:memory:` and `file::memory:` (no query string) each mint a fresh,
 * connection-private database -- `resolveDuckDBUrl(':memory:')` returns it
 * unchanged, with no per-instance suffix -- so two independent handles that
 * both happen to carry this literal string are NOT the same database and
 * must not share a write-queue identity (#2707). A `cache=shared` query
 * parameter (e.g. `file::memory:?cache=shared`) is the opposite case: it is
 * SQLite's own mechanism for making an in-memory database genuinely shared
 * across connections in the process, so a URL carrying it must keep the
 * ordinary string-keyed (shared) behavior.
 */
function isPerConnectionMemoryUrl(url: string): boolean {
  if (url.includes('cache=shared')) return false;
  return url === ':memory:' || url === 'file::memory:';
}

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
  if (!serialize) return operation();

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
): Promise<T> {
  const transaction = db.transaction?.bind(db);
  if (!transaction) {
    throw new Error('Database transaction support is required');
  }
  return withEmbeddedWriteQueue(db, serialize, () =>
    transaction((bound) => {
      if (!serialize) return operation(bound);
      const active = activeQueueKeys.getStore();
      return activeQueueKeys.run(
        new Set([...(active ?? []), queueKey(bound)]),
        () => operation(bound),
      );
    }),
  );
}
