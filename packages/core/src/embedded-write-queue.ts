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
 *
 * Each hold contains database calls only — never an interceptor or hook — so
 * the queue cannot deadlock on nested model saves. PostgreSQL is never
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
  return !/^postgres(?:ql)?:/iu.test(db?.url ?? '');
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

function queueKey(db: QueueableDatabase): string | object {
  return typeof db?.url === 'string' && db.url.length > 0 ? db.url : db;
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
  const previous =
    (typeof key === 'string' ? urlQueues.get(key) : handleQueues.get(key)) ??
    Promise.resolve();
  const next = previous.then(operation, operation);
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
