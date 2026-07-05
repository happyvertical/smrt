/**
 * @happyvertical/smrt-web — the durable version-meta store (#1764).
 *
 * A tiny raw IndexedDB key/value store for version-awareness bookkeeping —
 * currently the single "last-seen manifestHash" per durable-store namespace,
 * which contract-change detection ({@link ../update-state}) compares the running
 * build against across loads. One database per namespace
 * ({@link durableStoreNamespace}), one object store (`meta`) keyed by a string
 * key, each record `{ key, value }`.
 *
 * Separate from the collection snapshot store (persistence/snapshot-store.ts):
 * that one holds per-collection row blobs; this holds scalar version state, and
 * update-awareness must work even for an app that persists no collection. Both
 * register under the SAME namespace so one {@link wipeDurableStore} clears
 * everything on logout.
 *
 * Raw IndexedDB, ZERO new runtime dependency — inside the engine-absorption
 * boundary (#1761), mirroring offline/durable-queue.ts.
 */

/** IndexedDB object-store name inside every version-meta database. */
export const META_STORE = 'meta';
/** IndexedDB schema version. Bump only on a store/index migration. */
export const META_DB_VERSION = 1;
/** The reserved key under which the last-seen manifest hash is stored. */
export const LAST_SEEN_MANIFEST_HASH_KEY = 'lastSeenManifestHash';

/** One key/value meta record. */
interface MetaRecord {
  key: string;
  value: string;
}

/** Promisify a single IndexedDB request. */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('[smrt-web] IndexedDB request failed'));
  });
}

/** Promisify a transaction's durable completion. */
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
 * The durable version-meta store over one IndexedDB database. Constructed via
 * {@link openVersionMetaStore}; used through the async methods below.
 */
export class VersionMetaStore {
  private readonly db: IDBDatabase;
  /** The IndexedDB database name (== the durable-store namespace). */
  readonly dbName: string;

  constructor(db: IDBDatabase, dbName: string) {
    this.db = db;
    this.dbName = dbName;
  }

  /** Read the value for `key`, or `undefined` if unset / malformed. */
  async get(key: string): Promise<string | undefined> {
    const tx = this.db.transaction(META_STORE, 'readonly');
    const record = await promisifyRequest(
      tx.objectStore(META_STORE).get(key) as IDBRequest<MetaRecord | undefined>,
    );
    await awaitTransaction(tx);
    return record && typeof record.value === 'string'
      ? record.value
      : undefined;
  }

  /** Write (replacing) the value for `key`; resolves once durably committed. */
  async set(key: string, value: string): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    const record: MetaRecord = { key, value };
    await promisifyRequest(tx.objectStore(META_STORE).put(record));
    await awaitTransaction(tx);
  }

  /**
   * Drop EVERY meta record — the durable-store `clear()` for
   * {@link wipeDurableStore}, so a logout also clears the last-seen manifest
   * hash (the AC "wipe clears the last-seen-hash record").
   */
  async clear(): Promise<void> {
    const tx = this.db.transaction(META_STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(META_STORE).clear());
    await awaitTransaction(tx);
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating/upgrading as needed) the version-meta database for `dbName` and
 * wrap it in a {@link VersionMetaStore}. `dbName` MUST be a
 * {@link durableStoreNamespace} string.
 */
export function openVersionMetaStore(
  dbName: string,
): Promise<VersionMetaStore> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(
      new Error('[smrt-web] IndexedDB is unavailable in this environment'),
    );
  }
  return new Promise<VersionMetaStore>((resolve, reject) => {
    const request = idb.open(dbName, META_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () =>
      resolve(new VersionMetaStore(request.result, dbName));
    request.onerror = () =>
      reject(
        request.error ??
          new Error(`[smrt-web] failed to open meta database "${dbName}"`),
      );
    request.onblocked = () =>
      reject(
        new Error(`[smrt-web] opening meta database "${dbName}" was blocked`),
      );
  });
}
