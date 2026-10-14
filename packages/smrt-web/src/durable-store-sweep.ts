/**
 * @happyvertical/smrt-web — durable-store sweep for shared devices (#3234).
 *
 * The durable-store registry ({@link wipeDurableStore}) only reaches resources
 * registered in the CURRENT page load. On shared hardware a signed-in person B
 * also needs to age out what person A left queued under A's own namespace —
 * WITHOUT mounting A's queue, which would attach A's replay engine and
 * transport to B's session. This module does that against IndexedDB directly:
 *
 * - {@link listDurableNamespaces} enumerates namespaces by database NAME only;
 *   it never opens a database or reads a row.
 * - {@link pruneDurableNamespace} deletes a namespace's outbox rows by age. It
 *   never constructs an `OutboxEngine`, never registers a binding, never calls
 *   a transport or `fetch`, and never returns row contents — only counts.
 *
 * Exclusion: a route a live queue is replaying (in any tab) holds that route's
 * leader Web Lock for its whole lifetime, so a prune takes the same lock with
 * `ifAvailable` and SKIPS a held route rather than deleting rows from under an
 * in-flight replay or waiting forever on a leader that never releases.
 *
 * Engine-free: no `@tanstack/*` import — stays inside the boundary (#1761).
 */

import {
  hasDurableResource,
  registeredDurableNamespaces,
} from './durable-store.js';
import { OUTBOX_STORE, type OutboxRow } from './offline/durable-queue.js';
import { outboxLeaderLockName, routeOf } from './offline/engine.js';
import { SNAPSHOT_DB_SUFFIX } from './persistence/snapshot-store.js';
import { META_DB_SUFFIX } from './update-state/meta-store.js';

/** Options for {@link pruneDurableNamespace}. */
export interface PruneDurableNamespaceOptions {
  /**
   * The age cutoff: a `Date` or epoch milliseconds. Every queued item enqueued
   * strictly BEFORE it is removed. For "older than seven days", pass
   * `Date.now() - 7 * 24 * 60 * 60 * 1000`.
   */
  olderThan: Date | number;
}

/** Counts reported by {@link pruneDurableNamespace} — never row contents. */
export interface PruneDurableNamespaceResult {
  /** Queued items older than the cutoff that were removed. */
  removed: number;
  /**
   * Queued items older than the cutoff that were KEPT because a live queue (in
   * this or another tab) is replaying their route. Retry once it detaches.
   */
  skipped: number;
}

/**
 * The shape {@link durableStoreNamespace} produces:
 * `smrt-web:<apiBase>:<tenant>:<identity>:<manifestHash>`, where every segment
 * is `encodeURIComponent`-encoded (so it holds no `:`) and the optional
 * tenant/identity segments are empty or `_`-prefixed.
 */
const NAMESPACE_PATTERN = /^smrt-web:[^:]*:(?:_[^:]*)?:(?:_[^:]*)?:[^:]*$/;

/** Whether `value` is a well-formed durable-store namespace string. */
function isDurableStoreNamespace(value: unknown): value is string {
  return typeof value === 'string' && NAMESPACE_PATTERN.test(value);
}

/**
 * The namespace an IndexedDB database belongs to, or `undefined` for a database
 * smrt-web does not own. The outbox database is named by the bare namespace;
 * the snapshot and version-meta databases append their suffixes.
 */
function namespaceOfDatabase(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  for (const suffix of [SNAPSHOT_DB_SUFFIX, META_DB_SUFFIX]) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      return isDurableStoreNamespace(base) ? base : undefined;
    }
  }
  return isDurableStoreNamespace(name) ? name : undefined;
}

function getIndexedDb(): IDBFactory | undefined {
  return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
}

/**
 * List the durable-store namespaces this browser holds: every namespace with an
 * smrt-web IndexedDB database (outbox, persisted snapshots, version meta), plus
 * any registered in this page load. Names only, sorted — no database is opened
 * and no contents are read.
 *
 * A namespace stays listed after {@link pruneDurableNamespace} empties it: a
 * prune removes items, not the database. Where `indexedDB.databases()` is
 * unavailable, only this page's registered namespaces are returned; a rejection
 * from `databases()` propagates rather than reporting a silently partial list.
 */
export async function listDurableNamespaces(): Promise<string[]> {
  const names = new Set<string>(registeredDurableNamespaces());
  const idb = getIndexedDb();
  if (idb && typeof idb.databases === 'function') {
    for (const info of await idb.databases()) {
      const namespace = namespaceOfDatabase(info.name);
      if (namespace !== undefined) names.add(namespace);
    }
  }
  return [...names].sort();
}

function resolveCutoff(olderThan: unknown): number {
  const cutoff =
    olderThan instanceof Date
      ? olderThan.getTime()
      : typeof olderThan === 'number'
        ? olderThan
        : Number.NaN;
  if (!Number.isFinite(cutoff)) {
    throw new TypeError(
      'pruneDurableNamespace requires olderThan as a valid Date or epoch milliseconds',
    );
  }
  return cutoff;
}

/**
 * Open an EXISTING database without creating it. Opening with no version only
 * fires `upgradeneeded` when the database does not exist; aborting that upgrade
 * discards the just-created database, so a prune of an unknown namespace
 * leaves nothing behind.
 */
function openExistingDatabase(
  idb: IDBFactory,
  name: string,
): Promise<IDBDatabase | undefined> {
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    let created = false;
    const request = idb.open(name);
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      const db = request.result;
      if (created) {
        db.close();
        resolve(undefined);
        return;
      }
      // Never block a later schema upgrade or delete by the owning queue.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = (event) => {
      if (created) {
        event.preventDefault();
        resolve(undefined);
        return;
      }
      reject(
        request.error ??
          new Error(`[smrt-web] failed to open durable database "${name}"`),
      );
    };
    request.onblocked = () =>
      reject(
        new Error(`[smrt-web] opening durable database "${name}" was blocked`),
      );
  });
}

/** Whether a row is old enough to prune. Rows without an age are kept. */
function isStale(row: OutboxRow, cutoff: number): boolean {
  return typeof row.enqueuedAt === 'number' && row.enqueuedAt < cutoff;
}

/** Count the stale rows per replay route (read-only; no contents escape). */
function countStaleByRoute(
  db: IDBDatabase,
  cutoff: number,
): Promise<Map<string, number>> {
  return new Promise<Map<string, number>>((resolve, reject) => {
    const counts = new Map<string, number>();
    const tx = db.transaction(OUTBOX_STORE, 'readonly');
    const request = tx.objectStore(OUTBOX_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const row = cursor.value as OutboxRow;
      if (isStale(row, cutoff)) {
        const route = routeOf(row);
        counts.set(route, (counts.get(route) ?? 0) + 1);
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(counts);
    tx.onerror = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction aborted'));
  });
}

/**
 * Delete one route's stale rows in a single readwrite transaction, re-reading
 * under the route's lock so a row enqueued or settled since the count is judged
 * on its current state. Resolves with the number removed once committed.
 */
function deleteStaleRows(
  db: IDBDatabase,
  cutoff: number,
  route: string,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let removed = 0;
    const tx = db.transaction(OUTBOX_STORE, 'readwrite');
    const request = tx.objectStore(OUTBOX_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const row = cursor.value as OutboxRow;
      if (routeOf(row) === route && isStale(row, cutoff)) {
        cursor.delete();
        removed += 1;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('[smrt-web] IndexedDB transaction aborted'));
  });
}

/** Structural view of the Web Locks surface the sweep uses. */
interface SweepLockManager {
  request<T>(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

function getLockManager(): SweepLockManager | undefined {
  const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = nav?.locks as SweepLockManager | undefined;
  return locks && typeof locks.request === 'function' ? locks : undefined;
}

/**
 * Run `work` while holding the route's leader lock, or resolve `undefined`
 * without running it when a live replayer holds that lock. Without Web Locks
 * (the outbox's documented single-tab fallback), a queue mounted in THIS page
 * under the namespace counts as the live replayer; another fallback tab cannot
 * be detected.
 */
async function whileRouteIdle<T>(
  namespace: string,
  route: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const locks = getLockManager();
  if (!locks) {
    return hasDurableResource(namespace, 'outbox') ? undefined : work();
  }
  return locks.request(
    outboxLeaderLockName(namespace, route),
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => (lock === null ? undefined : work()),
  );
}

/**
 * Remove a durable namespace's queued items enqueued before `olderThan`, without
 * mounting its queue: no replay, no transport, no `fetch`, and no
 * `OutboxEngine`. Intended for sweeping another person's stale data on shared
 * hardware — pair with {@link listDurableNamespaces}.
 *
 * Only the offline outbox's items carry an age; persisted read snapshots and
 * version metadata are left untouched. Items on a route a live queue is
 * replaying are kept and counted in `skipped`. Resolves `{ removed: 0,
 * skipped: 0 }` for a namespace with no outbox (an unknown namespace is never
 * created). Rejects with a `TypeError` for a string that is not a
 * {@link durableStoreNamespace} result or an invalid `olderThan`.
 */
export async function pruneDurableNamespace(
  namespace: string,
  options: PruneDurableNamespaceOptions,
): Promise<PruneDurableNamespaceResult> {
  if (!isDurableStoreNamespace(namespace)) {
    throw new TypeError(
      'pruneDurableNamespace requires a durableStoreNamespace() string',
    );
  }
  const cutoff = resolveCutoff(options?.olderThan);
  const result: PruneDurableNamespaceResult = { removed: 0, skipped: 0 };
  const idb = getIndexedDb();
  if (!idb) return result;
  const db = await openExistingDatabase(idb, namespace);
  if (!db) return result;
  try {
    if (!db.objectStoreNames.contains(OUTBOX_STORE)) return result;
    const staleByRoute = await countStaleByRoute(db, cutoff);
    for (const [route, count] of staleByRoute) {
      const removed = await whileRouteIdle(namespace, route, () =>
        deleteStaleRows(db, cutoff, route),
      );
      if (removed === undefined) result.skipped += count;
      else result.removed += removed;
    }
    return result;
  } finally {
    db.close();
  }
}
