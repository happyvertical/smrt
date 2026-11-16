import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Busy timeout, in milliseconds, for a SQLite connection that may wait without
 * hurting anyone: the local runtime's own connection (`tuneLocalSqlite` in
 * `@happyvertical/smrt-app-runtime`) and the jobs liveness thread's reopened
 * connection, which runs on its own thread. Neither SQLite engine waits for a
 * lock by default, and a reopened connection inherits no PRAGMAs.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Busy timeout for the other connections the framework opens on a SQLite file
 * for collections (#4978). They run on the main thread, where `node:sqlite`
 * waits synchronously: a long value would freeze the event loop. The lock
 * holder worth waiting for is the jobs liveness thread, which holds the write
 * lock for one single-row commit. Measured on a local SSD with
 * `synchronous = FULL` in WAL mode: a renewal-sized commit takes about 0.2 ms
 * (p50), 2 ms (p99) and 10 ms at worst, and a main thread writing every 2 ms
 * against a 5 ms ticker waited at most 10 ms (no errors in about 4,000
 * transactions). 250 ms is 25 times that worst case, which leaves room for a
 * slow disk, and still short enough that a main-thread transaction held across
 * an `await` fails after a quarter of a second instead of stalling the process
 * for seconds. Such a failure is the same one it produced before, immediately.
 */
export const SQLITE_COLLECTION_BUSY_TIMEOUT_MS = 250;

const settled = new WeakSet<object>();

function isFileSqlite(db: DatabaseInterface): boolean {
  if (db.engine !== 'node-sqlite' && db.engine !== 'libsql') return false;
  if (typeof db.reopenOptions !== 'function') return false;
  try {
    // Throws for `:memory:`, which has no second connection to wait for.
    const options = db.reopenOptions() as { url?: unknown };
    const url = typeof options.url === 'string' ? options.url : '';
    return !/^(libsql|https?|wss?):/i.test(url);
  } catch {
    return false;
  }
}

/**
 * Make a file-backed SQLite connection wait for a lock instead of failing at
 * once with `database is locked`.
 *
 * Applied once per cached connection, and only when nothing has set a timeout
 * yet, so a connection the runtime already tuned (`SQLITE_BUSY_TIMEOUT_MS`)
 * keeps its longer value. Other engines and in-memory databases are untouched.
 * Best-effort: a failing PRAGMA must never break opening a database.
 */
export async function applyCollectionLockWait(
  db: DatabaseInterface,
  timeoutMs: number = SQLITE_COLLECTION_BUSY_TIMEOUT_MS,
): Promise<void> {
  if (!db || typeof db !== 'object' || settled.has(db)) return;
  settled.add(db);
  if (!isFileSqlite(db)) return;
  try {
    const current = await db.query('PRAGMA busy_timeout');
    const value = Object.values((current.rows[0] ?? {}) as object)[0];
    if (Number(value) > 0) return;
    await db.query(`PRAGMA busy_timeout = ${timeoutMs}`);
  } catch {
    // Best-effort connection tuning.
  }
}
