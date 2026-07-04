/**
 * @happyvertical/smrt-web — the durable IndexedDB outbox queue (#1762).
 *
 * A raw IndexedDB FIFO queue: the persistence half of the offline outbox. One
 * database per durable-store namespace ({@link durableStoreNamespace}), one
 * object store (`outbox`) keyed by an AUTO-INCREMENTING `seq` — so insertion
 * order IS replay order for free — plus a `state` index so the replay loop can
 * scan only rows that still need work.
 *
 * ## Why raw IndexedDB, not `@tanstack/offline-transactions`
 *
 * The decisive finding (#1762): the TanStack offline layer's public API is
 * engine-typed (`Collection<…>`, `mutationFns`), so importing it emits a
 * `@tanstack/` specifier into `dist/offline.d.ts`, which
 * `scripts/check-smrt-web-engine-boundary.mjs` scans for unconditionally — the
 * build would fail. It also pins `@tanstack/db` exactly and competes with
 * smrt-web's OWN mutation lifecycle. So the outbox is hand-rolled over browser
 * globals (`indexedDB`, `navigator.locks`) with ZERO new runtime dependency.
 *
 * This module is engine-free (no `@tanstack/*` import): it stays inside the
 * engine-absorption boundary (#1761) and speaks only the sync-apply contract's
 * op shape (`packages/core/src/sync/apply.ts`).
 *
 * Row payloads are stored as structured-clone-safe plain objects; IndexedDB
 * clones on write, so callers may keep mutating the source object after enqueue.
 */

import type { SyncApplyOp } from './types.js';

/** IndexedDB object-store name inside every outbox database. */
export const OUTBOX_STORE = 'outbox';
/** Index over {@link OutboxRow.state} — the replay scan reads it. */
export const OUTBOX_STATE_INDEX = 'state';
/** IndexedDB schema version. Bump only on a store/index migration. */
export const OUTBOX_DB_VERSION = 1;

/**
 * Durable lifecycle state of one queued mutation. Deliberately a SUPERSET of
 * the app-observable sync state: `pending` rows are due for (re)send, while
 * `synced`/`failed` are terminal tombstones removed after each drain. The
 * app-facing {@link OutboxSyncState} (`pending`/`uploading`/`synced`/`failed`)
 * is derived by the engine — `uploading` is a transient in-flight marker the
 * engine emits, never persisted; this enum is the on-disk truth.
 */
export type OutboxRowState = 'pending' | 'synced' | 'failed';

/**
 * One durable outbox row — a single client-authored mutation awaiting replay
 * through `POST {basePath}/sync/apply`. Fields mirror the sync-apply item so a
 * row maps to a batch item with no translation, plus the durable bookkeeping the
 * replay loop needs (`state`, `attempts`, `nextAttemptAt`, `lastError`).
 */
export interface OutboxRow {
  /** Auto-incrementing primary key — monotonic, so `seq` order IS FIFO. */
  seq?: number;
  /**
   * The sync-apply `itemId`: the client's idempotency/correlation handle. A
   * fresh UUID minted at enqueue time, distinct from {@link id} (the row UUID),
   * so it survives coalescing and is echoed back verbatim by the endpoint.
   */
  itemId: string;
  /** The collection route segment (e.g. `products`) — sync-apply `object`. */
  object: string;
  /** Which mutation kind — sync-apply `op`. */
  op: SyncApplyOp;
  /** The client-generated row UUID — sync-apply `id`. */
  id: string;
  /** Field data for create/update; omitted for delete. */
  payload?: Record<string, unknown>;
  /** The server `updated_at` the client last saw — the conflict guard base. */
  baseUpdatedAt?: string;
  /** On-disk lifecycle state. */
  state: OutboxRowState;
  /** How many replay attempts this row has made (drives backoff). */
  attempts: number;
  /** Epoch ms before which this row must not be retried (backoff gate). */
  nextAttemptAt: number;
  /** Last replay error message, for diagnostics/`snapshot()`. */
  lastError?: string;
  /** Epoch ms the row was first enqueued — stable ordering tiebreak + age. */
  enqueuedAt: number;
}

/** The fields a caller supplies to {@link DurableOutboxQueue.enqueue}. */
export interface EnqueueInput {
  itemId: string;
  object: string;
  op: SyncApplyOp;
  id: string;
  payload?: Record<string, unknown>;
  baseUpdatedAt?: string;
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
 * this — a queue that reported success before the txn committed could lose a
 * write on a crash in the commit window, defeating the whole point.
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
 * the engine can degrade to a no-op instead of crashing the host.
 */
export async function probeIndexedDb(): Promise<boolean> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return false;
  const probeName = '__smrt_web_outbox_probe__';
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(probeName, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('probe failed'));
      request.onblocked = () => reject(new Error('probe blocked'));
    });
    db.close();
    // Best-effort cleanup; ignore failure.
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
 * The durable FIFO outbox queue over one IndexedDB database. Constructed via
 * {@link openDurableOutboxQueue} (async open + schema upgrade), then used
 * through the async methods below (each resolves once its txn commits).
 *
 * NOT concurrency-controlled across tabs on its own — the OutboxEngine layers
 * Web Locks leader election on top so exactly one tab drains it. Within one tab,
 * IndexedDB's own transaction serialization is sufficient.
 */
export class DurableOutboxQueue {
  private readonly db: IDBDatabase;
  /** The IndexedDB database name (== the durable-store namespace). */
  readonly dbName: string;

  constructor(db: IDBDatabase, dbName: string) {
    this.db = db;
    this.dbName = dbName;
  }

  /**
   * Append a mutation to the tail of the queue in state `pending`, due
   * immediately (`nextAttemptAt = 0`, `attempts = 0`). Resolves with the
   * assigned `seq` once the write is durably committed.
   */
  async enqueue(input: EnqueueInput): Promise<number> {
    const now = Date.now();
    const row: OutboxRow = {
      itemId: input.itemId,
      object: input.object,
      op: input.op,
      id: input.id,
      payload: input.payload,
      baseUpdatedAt: input.baseUpdatedAt,
      state: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      enqueuedAt: now,
    };
    const tx = this.db.transaction(OUTBOX_STORE, 'readwrite');
    const store = tx.objectStore(OUTBOX_STORE);
    const seq = await promisifyRequest(store.add(row));
    await awaitTransaction(tx);
    return seq as number;
  }

  /**
   * Persist a state transition (and any of attempts/backoff/error) for the row
   * at `seq`, reading-then-writing inside ONE transaction so a concurrent drain
   * in the same tab can't lose the update. A no-op if the row is already gone
   * (removed by a prior terminal transition).
   */
  async markState(
    seq: number,
    patch: Partial<
      Pick<OutboxRow, 'state' | 'attempts' | 'nextAttemptAt' | 'lastError'>
    >,
  ): Promise<void> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readwrite');
    const store = tx.objectStore(OUTBOX_STORE);
    const existing = await promisifyRequest(
      store.get(seq) as IDBRequest<OutboxRow | undefined>,
    );
    if (!existing) {
      // Nothing to update; let the txn commit as a no-op.
      await awaitTransaction(tx);
      return;
    }
    const next: OutboxRow = { ...existing, ...patch, seq };
    await promisifyRequest(store.put(next));
    await awaitTransaction(tx);
  }

  /**
   * All rows that are due to (re)send at `now`: state `pending` AND
   * `nextAttemptAt <= now`, in ascending `seq` (FIFO). Uses the `state` index to
   * avoid scanning terminal tombstones. Terminal rows (`synced`/`failed`) are
   * excluded — they await removal, not replay.
   */
  async listPending(now: number): Promise<OutboxRow[]> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readonly');
    const index = tx.objectStore(OUTBOX_STORE).index(OUTBOX_STATE_INDEX);
    const rows = await promisifyRequest(
      index.getAll(IDBKeyRange.only('pending')) as IDBRequest<OutboxRow[]>,
    );
    await awaitTransaction(tx);
    return rows
      .filter((row) => row.nextAttemptAt <= now)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  /** Remove the row at `seq` (a terminal transition drops it). */
  async remove(seq: number): Promise<void> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(OUTBOX_STORE).delete(seq));
    await awaitTransaction(tx);
  }

  /** Every row currently in the queue (any state), ascending `seq`. */
  async all(): Promise<OutboxRow[]> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readonly');
    const rows = await promisifyRequest(
      tx.objectStore(OUTBOX_STORE).getAll() as IDBRequest<OutboxRow[]>,
    );
    await awaitTransaction(tx);
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  /**
   * Drop every row — the durable-store `clear()` for `wipeDurableStore`. Empties
   * the store but keeps the database (and its `seq` autoincrement counter) so a
   * subsequent enqueue still gets fresh monotonic ids.
   */
  async clear(): Promise<void> {
    const tx = this.db.transaction(OUTBOX_STORE, 'readwrite');
    await promisifyRequest(tx.objectStore(OUTBOX_STORE).clear());
    await awaitTransaction(tx);
  }

  /** Close the underlying database handle (called on engine dispose). */
  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating/upgrading as needed) the outbox database for `dbName` and wrap
 * it in a {@link DurableOutboxQueue}. `dbName` MUST be a
 * {@link durableStoreNamespace} string — already `encodeURIComponent`-safe and
 * carrying the api/tenant/identity/manifest isolation boundary, so two
 * identities never share one queue database.
 *
 * The `onupgradeneeded` handler creates the `outbox` store keyed by
 * autoincrementing `seq` and the `state` index. Idempotent: re-opening an
 * existing database at the same version skips the upgrade — which is exactly the
 * "reload" path (a new tab re-opens the same durable backing and sees prior
 * rows).
 */
export function openDurableOutboxQueue(
  dbName: string,
): Promise<DurableOutboxQueue> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) {
    return Promise.reject(
      new Error('[smrt-web] IndexedDB is unavailable in this environment'),
    );
  }
  return new Promise<DurableOutboxQueue>((resolve, reject) => {
    const request = idb.open(dbName, OUTBOX_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, {
          keyPath: 'seq',
          autoIncrement: true,
        });
        store.createIndex(OUTBOX_STATE_INDEX, 'state', { unique: false });
      }
    };
    request.onsuccess = () =>
      resolve(new DurableOutboxQueue(request.result, dbName));
    request.onerror = () =>
      reject(
        request.error ??
          new Error(`[smrt-web] failed to open outbox database "${dbName}"`),
      );
    request.onblocked = () =>
      reject(
        new Error(`[smrt-web] opening outbox database "${dbName}" was blocked`),
      );
  });
}
