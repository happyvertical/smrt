/**
 * @happyvertical/smrt-web — the durable collection snapshot store (#1764).
 *
 * The read-side twin of the offline outbox's write queue: a raw IndexedDB store
 * that persists ONE blob per (namespace, collection) — the collection's last
 * known rows — so a reload can warm-start (render stale instantly) before the
 * engine revalidates in the background. One database per durable-store namespace
 * ({@link durableStoreNamespace}), one object store (`snapshots`) keyed by the
 * collection name, each record `{ collection, rows }`.
 *
 * ## Why raw IndexedDB, mirroring offline/durable-queue.ts
 *
 * Same decisive finding as #1762's outbox: the TanStack persistence layer's
 * public API is engine-typed, so importing it would emit a `@tanstack/`
 * specifier into a `.d.ts` and fail `scripts/check-smrt-web-engine-boundary.mjs`.
 * So persistence is hand-rolled over `indexedDB` with ZERO new runtime
 * dependency and stays inside the engine-absorption boundary (#1761) — this
 * module speaks only plain rows, never an engine type.
 *
 * Rows are stored as structured-clone-safe plain objects (the public DTOs the
 * factory already projects); IndexedDB clones on write, so callers may keep
 * mutating the source array after a save.
 *
 * The namespace already folds api base / tenant / identity / manifest hash (see
 * {@link durableStoreNamespace}), so a logout, tenant switch, or contract-
 * changing deploy lands on a DIFFERENT database — a stale-schema snapshot is
 * simply never found (the read returns nothing and the engine fetches fresh),
 * which is exactly the "manifest-hash change drops persisted caches" guarantee
 * without any explicit invalidation.
 */

/** IndexedDB object-store name inside every snapshot database. */
export const SNAPSHOT_STORE = 'snapshots';
/** IndexedDB schema version. Bump only on a store/index migration. */
export const SNAPSHOT_DB_VERSION = 1;
/**
 * Suffix appended to the durable-store namespace to form this store's OWN
 * IndexedDB database name. Distinct DBs per store are REQUIRED for correctness:
 * the merged outbox (#1762) already opens the BARE namespace as a v1 database
 * with only its `outbox` object store. If persistence opened the same bare
 * namespace at v1, whichever store opened SECOND would find the existing v1 DB,
 * `onupgradeneeded` would NOT fire, and `objectStore('snapshots')` would throw
 * `NotFoundError` — silently disabling persistence (or the outbox). A distinct
 * DB name sidesteps the collision entirely; `wipeDurableStore` still clears both
 * because it fans out via each registered resource's `clear()`, never by DB name.
 */
export const SNAPSHOT_DB_SUFFIX = '::snapshots';

/** One persisted collection snapshot record. */
export interface SnapshotRecord {
  /** The REST collection name — the store key. */
  collection: string;
  /** The rows last seen for this collection (plain public DTOs). */
  rows: Array<Record<string, unknown>>;
}

/**
 * Promisify a single IndexedDB request. Rejects with the request's error (or a
 * generic one) so callers get a real rejection, never a silent `undefined`.
 */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('[smrt-web] IndexedDB request failed'));
  });
}

/**
 * Promisify a transaction's completion. IndexedDB writes are only durable once
 * the TRANSACTION completes (not when the request succeeds), so mutations await
 * this — a save that reported success before the txn committed could lose the
 * snapshot on a crash in the commit window.
 */
function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction aborted'));
  });
}

/**
 * Feature-detect a usable IndexedDB. Some environments expose `indexedDB` but
 * throw on `open()` (private-mode Firefox historically, sandboxed iframes), so a
 * real probe opens a throwaway database. Returns `false` rather than throwing so
 * the persistence capability can degrade to non-persistent instead of crashing
 * the host — matching the outbox's `probeIndexedDb()` posture.
 */
export async function probeIndexedDb(): Promise<boolean> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return false;
  const probeName = '__smrt_web_snapshot_probe__';
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(probeName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('probe failed'));
      request.onblocked = () => reject(new Error('probe blocked'));
    });
    db.close();
    try {
      idb.deleteDatabase(probeName);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The durable snapshot store over one IndexedDB database. Constructed via
 * {@link openSnapshotStore} (async open + schema upgrade), then used through the
 * async methods below (each resolves once its txn commits).
 *
 * One store backs EVERY opted-in collection under a namespace, each keyed by its
 * collection name — so N persisted collections of one identity share one
 * database (like the outbox's shared queue), and the durable-store `clear()`
 * wipes them all at once.
 */
export class SnapshotStore {
  private readonly db: IDBDatabase;
  /** The IndexedDB database name (== the durable-store namespace). */
  readonly dbName: string;

  constructor(db: IDBDatabase, dbName: string) {
    this.db = db;
    this.dbName = dbName;
  }

  /**
   * Read the persisted rows for `collection`, or `undefined` if none were ever
   * saved (or the record is malformed). `undefined` is the warm-start "nothing
   * on disk" signal — the engine then fetches fresh.
   */
  async load(
    collection: string,
  ): Promise<Array<Record<string, unknown>> | undefined> {
    const tx = this.db.transaction(SNAPSHOT_STORE, 'readonly');
    const record = await promisifyRequest(
      tx.objectStore(SNAPSHOT_STORE).get(collection) as IDBRequest<
        SnapshotRecord | undefined
      >,
    );
    await awaitTransaction(tx);
    if (!record || !Array.isArray(record.rows)) return undefined;
    return record.rows;
  }

  /**
   * Write (replacing) the snapshot for `collection`. Resolves once the write is
   * durably committed. A single blob per collection — the whole current row set,
   * not a delta — so a restore is one read with no reconciliation.
   */
  async save(
    collection: string,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
    const store = tx.objectStore(SNAPSHOT_STORE);
    const record: SnapshotRecord = { collection, rows };
    await promisifyRequest(store.put(record));
    await awaitTransaction(tx);
  }

  /**
   * Drop the snapshot for a single `collection` (its capability's own teardown
   * does NOT clear — the persisted rows must survive for the next load; this is
   * only for an explicit targeted purge). Kept for completeness / tests.
   */
  async remove(collection: string): Promise<void> {
    const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(SNAPSHOT_STORE).delete(collection));
    await awaitTransaction(tx);
  }

  /**
   * Drop EVERY snapshot — the durable-store `clear()` for `wipeDurableStore`.
   * Empties the store but keeps the database so a subsequent save still works.
   */
  async clear(): Promise<void> {
    const tx = this.db.transaction(SNAPSHOT_STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(SNAPSHOT_STORE).clear());
    await awaitTransaction(tx);
  }

  /** Close the underlying database handle (called on the last detach). */
  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating/upgrading as needed) the snapshot database for `namespace` and
 * wrap it in a {@link SnapshotStore}. `namespace` MUST be a
 * {@link durableStoreNamespace} string — already `encodeURIComponent`-safe and
 * carrying the api/tenant/identity/manifest isolation boundary, so two
 * identities never share one snapshot database.
 *
 * The actual IndexedDB database name is `${namespace}${SNAPSHOT_DB_SUFFIX}` — a
 * DISTINCT database from the merged outbox's bare-namespace one, so persistence +
 * outbox under a shared namespace never collide on a single-store v1 DB (see
 * {@link SNAPSHOT_DB_SUFFIX}).
 *
 * The `onupgradeneeded` handler creates the `snapshots` store keyed by
 * `collection`. Idempotent: re-opening an existing database at the same version
 * skips the upgrade — the reload path (a new tab re-opens the same durable
 * backing and sees prior snapshots).
 */
export function openSnapshotStore(namespace: string): Promise<SnapshotStore> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(
      new Error('[smrt-web] IndexedDB is unavailable in this environment'),
    );
  }
  const dbName = `${namespace}${SNAPSHOT_DB_SUFFIX}`;
  return new Promise<SnapshotStore>((resolve, reject) => {
    const request = idb.open(dbName, SNAPSHOT_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE, { keyPath: 'collection' });
      }
    };
    request.onsuccess = () =>
      resolve(new SnapshotStore(request.result, dbName));
    request.onerror = () =>
      reject(
        request.error ??
          new Error(`[smrt-web] failed to open snapshot database "${dbName}"`),
      );
    request.onblocked = () =>
      reject(
        new Error(
          `[smrt-web] opening snapshot database "${dbName}" was blocked`,
        ),
      );
  });
}
