/**
 * @happyvertical/smrt-web — the shared, namespace-keyed outbox engine (#1762).
 *
 * The engine owns the durable queue, the leader lock, and the replay loop for
 * ONE durable-store namespace, and is REF-COUNTED so that N collections sharing
 * a namespace share exactly ONE engine — one IndexedDB database, one leader
 * lock, one FIFO queue. This sharing is REQUIRED for correctness, not an
 * optimization: if each collection held its OWN leader lock, two tabs could each
 * win a different collection's lock and both replay the (shared) queue,
 * double-POSTing. One lock per namespace ⇒ one replayer per namespace across all
 * tabs.
 *
 * Replay maps sync-apply results onto durable transitions per the contract's
 * "Web outbox (#1762)" consumer notes
 * (docs/content/architecture/sync-apply-contract.md):
 *
 * | apply result                        | queue transition                       |
 * |-------------------------------------|----------------------------------------|
 * | `applied`                           | remove → `synced`                      |
 * | `conflict` (stale_write/create_conflict) | remove + fire onConflict → `synced` (a RESOLVED outcome) |
 * | `rejected` `write_failed`           | keep, attempts++, backoff → `pending`  |
 * | `rejected` `auth_required`/`forbidden` | PAUSE the loop, keep queued → `pending` |
 * | `rejected` other (`invalid_*`/`unknown_object`/`not_found`/`op_not_allowed`/`id_conflict`) | remove → `failed` (terminal) |
 * | network reject / non-200 / lost response | whole batch stays `pending`, drain stops behind it (blind replay is safe by construction — idempotency) |
 *
 * Because items carry client-generated UUIDs and the endpoint is idempotent
 * (`_insertOnly` create + no-op re-apply), a batch that was sent but whose
 * response was lost can be blindly re-sent with no duplicate rows — which is
 * why the network-failure path simply leaves the batch `pending`.
 *
 * Engine-free public surface: no `@tanstack/*` import — inside the boundary
 * (#1761). The one engine-adjacent value it receives is the SMRT-owned
 * durable-store namespace + registration hooks passed in `config`.
 */

import {
  type DurableOutboxQueue,
  type OutboxRow,
  openDurableOutboxQueue,
  probeIndexedDb,
} from './durable-queue.js';
import { acquireLeadership, type LeadershipHandle } from './leader.js';
import {
  computeBackoffDelay,
  MAX_SYNC_APPLY_BATCH_SIZE,
  type OutboxConflict,
  type ResolvedBackoff,
  SYNC_APPLY_ROUTE_SEGMENTS,
  type SyncApplyBatchResponse,
  type SyncApplyItem,
  type SyncApplyItemResult,
  type SyncApplyOp,
  type SyncStateEvent,
} from './types.js';

/** Maps a capability-seam envelope kind to a sync-apply op. */
export function envelopeKindToOp(
  kind: 'insert' | 'update' | 'delete',
): SyncApplyOp {
  return kind === 'insert' ? 'create' : kind;
}

/**
 * The bookkeeping a namespace's durable-store registration needs, supplied by
 * the public surface so the engine can key its queue and register for
 * {@link wipeDurableStore} WITHOUT importing `durable-store.ts` itself (keeping
 * this module's dependency surface minimal and the namespacing single-sourced in
 * the caller). `namespace` is the {@link durableStoreNamespace} string.
 */
export interface OutboxEngineConfig {
  /** The durable-store namespace string — the IDB dbName + lock-name root. */
  namespace: string;
  /** Absolute base path the sync-apply endpoint lives under (e.g. `/api/v1`). */
  syncApplyBasePath: string;
  /** Fetch implementation (injectable for tests/SSR). */
  fetchFn: typeof fetch;
  /** Resolved backoff parameters. */
  backoff: ResolvedBackoff;
  /**
   * Register this engine's queue as a durable resource so `wipeDurableStore`
   * can clear it; returns the unregister fn. Wraps `registerDurableResource`
   * from the caller so the engine stays decoupled from that module.
   */
  registerResource: (clear: () => Promise<void>) => () => void;
  /** Injectable RNG for deterministic backoff jitter in tests. */
  random?: () => number;
}

/**
 * A pending optimistic write to enqueue, in capability-seam terms. Callbacks are
 * NOT carried here — they are registered per-`object` at
 * {@link OutboxEngine.registerCollection} so that reloaded rows (which this
 * session never enqueued) still route their events to the collection.
 */
export interface OutboxEnqueueRequest {
  kind: 'insert' | 'update' | 'delete';
  /** The collection route segment (definition.name). */
  object: string;
  /** The client-generated row UUID (the optimistic row's id). */
  rowId: string;
  /** Full row (insert) / changed fields (update) / ignored (delete). */
  data: Record<string, unknown>;
  /** The server updated_at last seen for this row, for the conflict guard. */
  baseUpdatedAt?: string;
}

/** A read-only view of one queued item, for {@link OutboxEngine.snapshot}. */
export interface OutboxSnapshotItem {
  itemId: string;
  object: string;
  op: SyncApplyOp;
  rowId: string;
  state: 'pending' | 'synced' | 'failed';
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

/** Generate a fresh UUID itemId, falling back when crypto.randomUUID is absent. */
function newItemId(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Is `navigator.onLine` telling us we're definitely offline? */
function isDefinitelyOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine === false;
}

/**
 * The shared per-namespace outbox engine. Create/lookup via
 * {@link getOrCreateOutboxEngine}; never construct directly (the module keeps
 * the ref-counted registry).
 */
export class OutboxEngine {
  private readonly config: OutboxEngineConfig;
  /**
   * Per-collection callback sets, keyed by the collection route segment
   * (`object`). Keyed by `object` — NOT by the queue row's `itemId` — precisely
   * so replayed rows that were REHYDRATED from IndexedDB after a reload (whose
   * itemIds this session never enqueued) still route their state/conflict events
   * to the reloaded collection's callbacks. A `Set` per object so N collections
   * sharing one engine+object each get every event (the common case is one
   * collection per object, but the shared-engine model does not forbid more).
   */
  private readonly listenersByObject = new Map<
    string,
    Set<{
      onSyncStateChange?: (event: SyncStateEvent) => void;
      onConflict?: (conflict: OutboxConflict) => void;
    }>
  >();

  /** Ref count: number of collections currently attached to this engine. */
  private refCount = 0;
  /** The durable queue, once opened. undefined while opening / if IDB absent. */
  private queue: DurableOutboxQueue | undefined;
  /** Resolves once the async open settles (success or degraded). */
  private readonly ready: Promise<void>;
  /** True when IndexedDB was unavailable and the engine is a durable no-op. */
  private degraded = false;
  /** Leadership handle; set once we've requested the leader lock. */
  private leadership: LeadershipHandle | undefined;
  /** True while this tab holds leadership. */
  private isLeader = false;
  /** Unregister fn from the durable-store registry. */
  private unregisterResource: (() => void) | undefined;
  /** True once dispose() ran — guards late async continuations. */
  private disposed = false;
  /**
   * Paused by an auth_required/forbidden result: the loop stops draining until
   * a later enqueue (the app re-authenticated and is writing again) or an
   * explicit retry wakes it. Items stay queued.
   */
  private paused = false;
  /** True while a drain pass is running, to coalesce concurrent triggers. */
  private draining = false;
  /** A drain requested while one was in flight — run one more pass after. */
  private drainQueued = false;
  /** Timer for the next backoff-scheduled drain, if any. */
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  /** The `online` event listener, so we can remove it on dispose. */
  private onlineListener: (() => void) | undefined;

  constructor(config: OutboxEngineConfig) {
    this.config = config;
    this.ready = this.open();
    this.wireOnlineListener();
    this.requestLeadership();
    // Kick a drain once the queue has finished opening. Leadership can be
    // granted (single-tab fallback: a microtask; Web Locks: whenever the lock
    // frees) BEFORE the async `open()` resolves — in which case that early
    // `drain()` returned at the `!this.queue` guard and nothing re-triggered it.
    // Draining after `ready` closes that race, so a freshly-constructed engine
    // that is already leader with a backlog on disk (the reload / leader-handoff
    // paths) replays without waiting for an external event.
    void this.ready.then(() => {
      if (!this.disposed) void this.drain();
    });
  }

  /** Open the durable queue (or mark degraded if IndexedDB is unusable). */
  private async open(): Promise<void> {
    const usable = await probeIndexedDb();
    if (!usable) {
      this.degraded = true;
      // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep; a degraded (no-IndexedDB) outbox is surfaced via console.warn (#1762)
      console.warn(
        '[smrt-web] IndexedDB unavailable — the offline outbox is disabled; offline writes will not be durable.',
      );
      return;
    }
    try {
      this.queue = await openDurableOutboxQueue(this.config.namespace);
      // Register for wipeDurableStore now that the queue exists.
      this.unregisterResource = this.config.registerResource(async () => {
        // A wipe clears the durable rows; drop the in-flight schedule too.
        await this.queue?.clear();
      });
      if (this.disposed) {
        // Disposed while opening — tear the just-opened queue back down.
        this.queue.close();
        this.queue = undefined;
        this.unregisterResource?.();
        this.unregisterResource = undefined;
        return;
      }
    } catch (error) {
      this.degraded = true;
      // biome-ignore lint/suspicious/noConsole: surface an outbox open failure (#1762)
      console.warn('[smrt-web] failed to open the offline outbox', error);
    }
  }

  /** Wake the drain loop immediately when connectivity returns. */
  private wireOnlineListener(): void {
    const target = globalThis as {
      addEventListener?: (t: string, l: () => void) => void;
    };
    if (typeof target.addEventListener !== 'function') return;
    const listener = () => {
      // Reconnected: an auth pause is unrelated to connectivity, so leave
      // `paused` as-is, but a network-stalled backlog should retry now.
      void this.drain();
    };
    target.addEventListener('online', listener);
    this.onlineListener = listener;
  }

  /** Request cross-tab leadership; drain whenever we hold it. */
  private requestLeadership(): void {
    const lockName = `smrt-web-outbox-leader:${this.config.namespace}`;
    this.leadership = acquireLeadership(
      lockName,
      () => {
        this.isLeader = true;
        void this.drain();
      },
      () => {
        this.isLeader = false;
      },
    );
  }

  /**
   * Attach a collection: register its per-object callbacks and bump the ref
   * count. Returns the exact callback record registered so the caller can pass
   * it back to {@link unregisterCollection} for precise removal (two collections
   * on the same object must each detach only their own callbacks). Registering
   * by `object` is what lets rehydrated rows (reloaded from IDB) reach this
   * collection's callbacks even though this session never enqueued them.
   */
  registerCollection(binding: {
    object: string;
    onSyncStateChange?: (event: SyncStateEvent) => void;
    onConflict?: (conflict: OutboxConflict) => void;
  }): {
    onSyncStateChange?: (event: SyncStateEvent) => void;
    onConflict?: (conflict: OutboxConflict) => void;
  } {
    this.refCount += 1;
    const record = {
      onSyncStateChange: binding.onSyncStateChange,
      onConflict: binding.onConflict,
    };
    let set = this.listenersByObject.get(binding.object);
    if (!set) {
      set = new Set();
      this.listenersByObject.set(binding.object, set);
    }
    set.add(record);
    return record;
  }

  /**
   * Detach a collection: remove its callback record and decrement the ref count;
   * when it reaches zero, dispose the engine (release the lock, unregister from
   * the durable-store registry, close IndexedDB). The durable ROWS are NOT
   * cleared — they must survive to replay after a reload; only the in-memory
   * engine is torn down. Returns true if it disposed.
   */
  async unregisterCollection(object: string, record: object): Promise<boolean> {
    const set = this.listenersByObject.get(object);
    if (set) {
      set.delete(record as never);
      if (set.size === 0) this.listenersByObject.delete(object);
    }
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return false;
    await this.dispose();
    return true;
  }

  /** Current ref count (test/introspection aid). */
  get referenceCount(): number {
    return this.refCount;
  }

  /**
   * Enqueue an optimistic write into the durable queue and fire the initial
   * `pending` state, then kick a drain. Resolves once the row is durably
   * committed (so the caller's `wrapMutation` only reports handled after
   * persistence). Replay events for this row (and for rows this session did not
   * enqueue — reloaded from disk) route to the registered per-`object`
   * callbacks, so a reload does not lose observability.
   *
   * In degraded (no-IndexedDB) mode the write is NOT durable, so this returns
   * `undefined` and the capability falls through to the real fetcher instead
   * of acknowledging an optimistic-only write.
   */
  async enqueue(request: OutboxEnqueueRequest): Promise<string | undefined> {
    await this.ready;
    if (!this.queue || this.degraded) return undefined;

    const itemId = newItemId();
    const op = envelopeKindToOp(request.kind);

    // A delete carries no payload; create/update carry the row/changed fields.
    const payload = op === 'delete' ? undefined : request.data;

    await this.queue.enqueue({
      itemId,
      object: request.object,
      op,
      id: request.rowId,
      payload,
      baseUpdatedAt: request.baseUpdatedAt,
    });

    this.emit({
      itemId,
      rowId: request.rowId,
      object: request.object,
      state: 'pending',
      attempts: 0,
    });

    // A fresh write means there's work; if an auth pause was in effect the app
    // is evidently active again, so clear it and try.
    this.paused = false;
    void this.drain();
    return itemId;
  }

  /**
   * Force a retry of a specific queued item now: clears its backoff gate and
   * wakes the loop. The bridge `OutboxHandle.retry(itemId)` calls this so an app
   * "retry" button can flush a backed-off or auth-paused item. A no-op for an
   * item that is not (or no longer) queued.
   */
  async retry(itemId: string): Promise<void> {
    await this.ready;
    if (!this.queue) return;
    const rows = await this.queue.all();
    const row = rows.find((r) => r.itemId === itemId && r.state === 'pending');
    if (!row || row.seq === undefined) return;
    await this.queue.markState(row.seq, { nextAttemptAt: 0 });
    this.paused = false;
    void this.drain();
  }

  /**
   * A read-only snapshot of the durable queue — the basis of
   * `OutboxHandle.snapshot()`. Because the READ cache is NOT rehydrated after a
   * reload in this slice (that's #1764's warmStart), the snapshot + the raw IDB
   * store are how a test/app proves durability, not `collection.toArray()`.
   */
  async snapshot(): Promise<OutboxSnapshotItem[]> {
    await this.ready;
    if (!this.queue) return [];
    const rows = await this.queue.all();
    return rows.map((row) => ({
      itemId: row.itemId,
      object: row.object,
      op: row.op,
      rowId: row.id,
      state: row.state,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      lastError: row.lastError,
    }));
  }

  /**
   * Deliver a state event to every callback registered for the event's
   * collection `object` (best-effort). Routing by `object` — not `itemId` —
   * means a row REHYDRATED from IndexedDB after a reload still reaches the
   * reloaded collection's callback even though this session never enqueued it.
   */
  private emit(event: SyncStateEvent): void {
    const set = this.listenersByObject.get(event.object);
    if (!set) return;
    for (const listener of set) {
      try {
        listener.onSyncStateChange?.(event);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: a throwing app callback must not break the loop (#1762)
        console.warn('[smrt-web] onSyncStateChange callback threw', error);
      }
    }
  }

  /** Deliver a conflict to every callback registered for its collection. */
  private emitConflict(conflict: OutboxConflict): void {
    const set = this.listenersByObject.get(conflict.object);
    if (!set) return;
    for (const listener of set) {
      try {
        listener.onConflict?.(conflict);
      } catch (error) {
        // biome-ignore lint/suspicious/noConsole: a throwing app callback must not break the loop (#1762)
        console.warn('[smrt-web] onConflict callback threw', error);
      }
    }
  }

  /**
   * The replay loop. Gated on: (a) holding leadership, (b) not paused by an
   * auth failure, (c) `navigator.onLine !== false`, (d) IndexedDB usable. Drains
   * all rows due now (`nextAttemptAt <= now`), oldest-first, chunked into
   * batches of ≤1000 per POST, one POST at a time to preserve FIFO across
   * chunks. Concurrency-coalesced: a drain requested while one runs sets a flag
   * to run exactly one more pass, so overlapping triggers never interleave.
   */
  private async drain(): Promise<void> {
    if (this.draining) {
      this.drainQueued = true;
      return;
    }
    this.draining = true;
    try {
      // Loop so a queued re-request (or a freshly-eligible backoff row) runs
      // without re-entrancy.
      for (;;) {
        this.drainQueued = false;
        await this.drainOnce();
        if (!this.drainQueued) break;
      }
    } finally {
      this.draining = false;
    }
  }

  /** One drain pass: send every currently-due batch, then schedule backoff. */
  private async drainOnce(): Promise<void> {
    if (this.disposed) return;
    if (!this.isLeader) return;
    if (this.paused) return;
    if (this.degraded || !this.queue) return;
    if (isDefinitelyOffline()) return;

    const pending = (await this.queue.all()).filter(
      (row) => row.state === 'pending',
    );
    if (pending.length === 0) return;

    const now = Date.now();
    const firstBlocked = pending.findIndex((row) => row.nextAttemptAt > now);
    const due = firstBlocked === -1 ? pending : pending.slice(0, firstBlocked);
    if (due.length === 0) {
      // The oldest pending row is backed off; FIFO forbids draining newer rows.
      await this.scheduleNextBackoff();
      return;
    }

    // Chunk oldest-first into ≤1000-item batches; send one at a time so FIFO
    // holds across chunks.
    for (let i = 0; i < due.length; i += MAX_SYNC_APPLY_BATCH_SIZE) {
      if (this.disposed || this.paused || !this.isLeader) break;
      const chunk = due.slice(i, i + MAX_SYNC_APPLY_BATCH_SIZE);
      const drained = await this.sendBatch(chunk);
      if (!drained) break;
    }

    // After processing, some rows may have been re-queued with a backoff gate;
    // schedule the next wake.
    await this.scheduleNextBackoff();
  }

  /**
   * Send one chunk through `POST {basePath}/sync/apply` and map results back
   * onto durable transitions. On a network reject / non-200 / lost/mismatched
   * response the WHOLE chunk stays `pending` (blind replay is safe) — every row
   * goes back to `pending` with an incremented attempt + backoff so the loop
   * doesn't hot-spin. Returns false when a retryable row remains pending, which
   * stops this drain pass so newer FIFO chunks do not overtake it.
   */
  private async sendBatch(chunk: OutboxRow[]): Promise<boolean> {
    // Mark the chunk uploading (observable), build the request items in order.
    for (const row of chunk) {
      this.emit({
        itemId: row.itemId,
        rowId: row.id,
        object: row.object,
        state: 'uploading',
        attempts: row.attempts,
      });
    }
    const items: SyncApplyItem[] = chunk.map((row) => ({
      itemId: row.itemId,
      object: row.object,
      op: row.op,
      id: row.id,
      payload: row.payload,
      baseUpdatedAt: row.baseUpdatedAt,
    }));

    let results: SyncApplyItemResult[] | undefined;
    try {
      results = await this.postBatch(items);
    } catch {
      // Network reject / non-200 / lost response: keep the whole batch pending.
      await this.requeueBatch(chunk, 'network error during sync');
      return false;
    }
    if (!results) {
      await this.requeueBatch(chunk, 'unexpected sync response shape');
      return false;
    }

    // Results are positional (results[i] ↔ items[i] ↔ chunk[i]). Map each.
    let drained = true;
    for (let i = 0; i < chunk.length; i += 1) {
      const row = chunk[i];
      const result = results[i];
      // A missing/short result array for this position → treat as retryable
      // (leave pending); safer than dropping the item.
      if (!result) {
        await this.requeueRow(row, 'missing result for item');
        drained = false;
        continue;
      }
      const applied = await this.applyResult(row, result);
      drained = drained && applied;
    }
    return drained;
  }

  /**
   * POST a batch to `{basePath}/sync/apply`. Throws on a non-2xx or a network
   * error (the caller treats a throw as "response lost → keep pending"). Returns
   * the positional `results` array, or `undefined` on a malformed 200 body.
   */
  private async postBatch(
    items: SyncApplyItem[],
  ): Promise<SyncApplyItemResult[] | undefined> {
    const url = `${this.config.syncApplyBasePath}/${SYNC_APPLY_ROUTE_SEGMENTS.join('/')}`;
    const response = await this.config.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!response.ok) {
      // HTTP 400 (bad batch) and any other non-2xx: throw so the batch stays
      // pending. A 400 on a well-formed client batch is unexpected; blind
      // replay stays safe by construction, so retrying is acceptable.
      throw new Error(`[smrt-web] sync/apply returned HTTP ${response.status}`);
    }
    const body = (await response
      .json()
      .catch(() => null)) as SyncApplyBatchResponse | null;
    if (!body || !Array.isArray(body.results)) return undefined;
    return body.results;
  }

  /**
   * Map one positional apply result onto a durable transition + observable
   * state, per the contract's consumer notes. See the class doc's mapping table.
   */
  private async applyResult(
    row: OutboxRow,
    result: SyncApplyItemResult,
  ): Promise<boolean> {
    if (row.seq === undefined) return true;

    if (result.status === 'applied') {
      await this.finishSynced(row);
      return true;
    }

    if (result.status === 'conflict') {
      // A conflict is a RESOLVED outcome: the server state won, the item leaves
      // the queue, its terminal observable state is `synced`, and the app is
      // notified so it can rebase from the returned updatedAt.
      const reason =
        result.reason === 'create_conflict' ? 'create_conflict' : 'stale_write';
      this.emitConflict({
        itemId: row.itemId,
        object: row.object,
        rowId: row.id,
        reason,
        serverUpdatedAt: result.updatedAt,
      });
      await this.finishSynced(row);
      return true;
    }

    // status === 'rejected'
    const reason = result.reason;
    if (reason === 'auth_required' || reason === 'forbidden') {
      // Pause the WHOLE loop until re-auth; keep the item queued as `pending`.
      this.paused = true;
      await this.queue?.markState(row.seq, {
        state: 'pending',
        lastError: `sync ${reason}`,
      });
      this.emit({
        itemId: row.itemId,
        rowId: row.id,
        object: row.object,
        state: 'pending',
        attempts: row.attempts,
        error: `sync ${reason}`,
      });
      return false;
    }

    if (reason === 'write_failed') {
      // Retryable: keep, count an attempt, back off.
      await this.requeueRow(row, 'sync write_failed');
      return false;
    }

    // Any other rejection (invalid_item/invalid_id/invalid_payload/
    // unknown_object/not_found/op_not_allowed/id_conflict) is terminal — a
    // retry cannot succeed. Remove and surface `failed`.
    await this.queue?.remove(row.seq);
    this.emit({
      itemId: row.itemId,
      rowId: row.id,
      object: row.object,
      state: 'failed',
      attempts: row.attempts,
      error: reason ? `sync ${reason}` : 'sync rejected',
    });
    return true;
  }

  /** Remove a successfully-applied (or conflict-resolved) row → `synced`. */
  private async finishSynced(row: OutboxRow): Promise<void> {
    if (row.seq !== undefined) await this.queue?.remove(row.seq);
    this.emit({
      itemId: row.itemId,
      rowId: row.id,
      object: row.object,
      state: 'synced',
      attempts: row.attempts,
    });
  }

  /** Re-queue every row of a failed batch (network path) with backoff. */
  private async requeueBatch(chunk: OutboxRow[], error: string): Promise<void> {
    for (const row of chunk) {
      await this.requeueRow(row, error);
    }
  }

  /** Re-queue one row: attempts++, backoff gate, `pending` event. */
  private async requeueRow(row: OutboxRow, error: string): Promise<void> {
    if (row.seq === undefined) return;
    const attempts = row.attempts + 1;
    const delay = computeBackoffDelay(
      attempts,
      this.config.backoff,
      this.config.random,
    );
    const nextAttemptAt = Date.now() + delay;
    await this.queue?.markState(row.seq, {
      state: 'pending',
      attempts,
      nextAttemptAt,
      lastError: error,
    });
    this.emit({
      itemId: row.itemId,
      rowId: row.id,
      object: row.object,
      state: 'pending',
      attempts,
      error,
    });
  }

  /**
   * Schedule the next drain for the soonest backed-off row's `nextAttemptAt`.
   * Only one timer is ever pending; a sooner schedule replaces a later one.
   */
  private async scheduleNextBackoff(): Promise<void> {
    if (this.disposed || this.paused || !this.queue) return;
    const rows = await this.queue.all();
    const firstPending = rows.find((r) => r.state === 'pending');
    if (!firstPending) return;
    const now = Date.now();
    // FIFO: the oldest pending row gates every newer row, even if a newer row
    // has no backoff delay.
    const delay = Math.max(0, firstPending.nextAttemptAt - now);
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    const timers = globalThis as {
      setTimeout?: typeof setTimeout;
    };
    if (typeof timers.setTimeout !== 'function') return;
    this.backoffTimer = timers.setTimeout(() => {
      this.backoffTimer = undefined;
      void this.drain();
    }, delay);
    // Node's timer keeps the process alive; unref so tests/SSR don't hang.
    (this.backoffTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Tear down the in-memory engine: release leadership, remove the online
   * listener, clear timers, unregister from the durable-store registry, and
   * close IndexedDB. Does NOT clear the durable rows — they must survive to
   * replay on the next load.
   */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
    const target = globalThis as {
      removeEventListener?: (t: string, l: () => void) => void;
    };
    if (
      this.onlineListener &&
      typeof target.removeEventListener === 'function'
    ) {
      target.removeEventListener('online', this.onlineListener);
      this.onlineListener = undefined;
    }
    this.leadership?.();
    this.leadership = undefined;
    this.unregisterResource?.();
    this.unregisterResource = undefined;
    // Wait for any in-flight open to settle before closing.
    await this.ready.catch(() => undefined);
    this.queue?.close();
    this.queue = undefined;
    this.listenersByObject.clear();
  }
}

/**
 * Module-scoped, ref-counted registry of engines by namespace string. This is
 * the mechanism that makes N collections sharing a namespace share ONE engine.
 * Keyed by the durable-store namespace, which already folds
 * api/tenant/identity/manifest — so a logout/tenant-switch lands on a different
 * key and a fresh engine.
 */
const engines = new Map<string, OutboxEngine>();

/**
 * Get the shared engine for `config.namespace`, creating it on first use and
 * ref-counting it. Every collection opting into the outbox under the same
 * namespace gets the SAME engine — one IndexedDB db, one leader lock, one FIFO
 * queue. The caller MUST pair each `getOrCreateOutboxEngine(...).registerCollection()`
 * with a later `unregisterCollection()` (via `teardown`) so the engine disposes
 * when its last collection detaches.
 */
export function getOrCreateOutboxEngine(
  config: OutboxEngineConfig,
): OutboxEngine {
  let engine = engines.get(config.namespace);
  if (!engine) {
    engine = new OutboxEngine(config);
    engines.set(config.namespace, engine);
    // Auto-evict from the shared registry once the engine disposes, so a later
    // collection under the same namespace gets a fresh engine rather than a
    // torn-down one. We detect disposal by wrapping unregisterCollection at the
    // call site (below in registerCollection/unregisterCollection helpers).
  }
  return engine;
}

/** The per-collection callback binding registered when a collection attaches. */
export interface OutboxCollectionBinding {
  object: string;
  onSyncStateChange?: (event: SyncStateEvent) => void;
  onConflict?: (conflict: OutboxConflict) => void;
}

/**
 * Attach a collection to the namespace's engine (creating it if needed),
 * register its per-`object` callbacks, and increment its ref count. Returns the
 * engine plus the exact callback `record` to hand back to
 * {@link releaseOutboxEngine} for precise removal. Pair with
 * {@link releaseOutboxEngine}.
 */
export function acquireOutboxEngine(
  config: OutboxEngineConfig,
  binding: OutboxCollectionBinding,
): { engine: OutboxEngine; record: object } {
  const engine = getOrCreateOutboxEngine(config);
  const record = engine.registerCollection(binding);
  return { engine, record };
}

/**
 * Detach a collection from an engine (removing its callback record) and, if it
 * was the last one, dispose it and evict it from the shared registry so the
 * namespace starts fresh next time.
 */
export async function releaseOutboxEngine(
  namespace: string,
  engine: OutboxEngine,
  object: string,
  record: object,
): Promise<void> {
  const disposed = await engine.unregisterCollection(object, record);
  if (disposed && engines.get(namespace) === engine) {
    engines.delete(namespace);
  }
}

/** Test-only: current engine count (for leak assertions). */
export function _outboxEngineCount(): number {
  return engines.size;
}
