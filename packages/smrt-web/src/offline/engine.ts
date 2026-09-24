/**
 * @happyvertical/smrt-web — the shared, namespace-keyed outbox engine (#1762).
 *
 * The engine owns the durable queue, the leader lock, and the replay loop for
 * ONE durable-store namespace, and is REF-COUNTED so that N collections sharing
 * a namespace share exactly ONE engine — one IndexedDB database, one leader
 * lock, one FIFO queue. This sharing is REQUIRED for correctness, not an
 * optimization: if each collection held its OWN leader lock, two tabs could each
 * win a different collection's lock and both replay the (shared) queue,
 * double-POSTing. One lock per namespace route ⇒ one replayer per route across
 * all tabs. Since #3021 a route is `sync-apply` (every sync-apply collection;
 * keeps the pre-#3021 lock name) or one consumer-declared transport, and a tab
 * leads only routes it has a binding for, so FIFO and backoff are per route.
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
  type OutboxCommandResult,
  type OutboxCommandTransport,
  type OutboxConflict,
  type ResolvedBackoff,
  SYNC_APPLY_ROUTE_SEGMENTS,
  type SyncApplyBatchResponse,
  type SyncApplyItem,
  type SyncApplyItemResult,
  type SyncApplyOp,
  type SyncApplyReason,
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
  /**
   * The client-generated row UUID (the optimistic row's id). Empty ⇒ the
   * minted item id stands in (a transport command with no target row).
   */
  rowId: string;
  /** Full row (insert) / changed fields (update) / ignored (delete). */
  data: Record<string, unknown>;
  /** The server updated_at last seen for this row, for the conflict guard. */
  baseUpdatedAt?: string;
  /**
   * Replay through the transport registered under this name instead of
   * `sync/apply` (#3021). Absent ⇒ sync-apply.
   */
  transport?: string;
}

/**
 * Where a namespace's sync-apply rows are POSTed. Supplied by the binding that
 * replays through sync-apply (an `offlineOutbox` without a `transport`), not by
 * the engine's creator: a command-only queue may create the shared engine
 * first, and must not pin a sync-apply base path it never declared.
 */
export interface OutboxSyncApplyTarget {
  /** Absolute base path the sync-apply endpoint lives under (e.g. `/api/v1`). */
  basePath: string;
  /** Fetch implementation (injectable for tests/SSR). */
  fetchFn: typeof fetch;
}

/** The exact record {@link OutboxEngine.registerCollection} registered. */
interface OutboxBindingRecord {
  onSyncStateChange?: (event: SyncStateEvent) => void;
  onConflict?: (conflict: OutboxConflict) => void;
  transport?: OutboxCommandTransport;
  /** The replay route this binding serves, if any (see {@link routeOf}). */
  route?: string;
}

/** The route every sync-apply row replays through. */
const SYNC_APPLY_ROUTE = 'sync-apply';

/**
 * The replay route a row belongs to: `sync-apply`, or `transport:<name>`.
 * Leadership, FIFO, and backoff gating are all per route (#3021): a tab leads
 * only routes it can actually serve, so a leader lacking a route never strands
 * another tab's rows for it.
 */
function routeOf(row: { transport?: string }): string {
  return row.transport === undefined
    ? SYNC_APPLY_ROUTE
    : `transport:${row.transport}`;
}

/** Cross-tab leadership for one route in this tab. */
interface RouteLeadership {
  release: LeadershipHandle;
  isLeader: boolean;
  refs: number;
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
  /** The replay transport name, when the item replays through one (#3021). */
  transport?: string;
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
    Set<OutboxBindingRecord>
  >();
  /**
   * The sync-apply endpoint, adopted from the first binding that declares one.
   * A tab without one never leads the sync-apply route, so its rows wait for a
   * tab that does (never dropped) — see `drainOnce`.
   */
  private syncApply: OutboxSyncApplyTarget | undefined;

  /** Ref count: number of collections currently attached to this engine. */
  private refCount = 0;
  /** The durable queue, once opened. undefined while opening / if IDB absent. */
  private queue: DurableOutboxQueue | undefined;
  /** Resolves once the async open settles (success or degraded). */
  private readonly ready: Promise<void>;
  /** True when IndexedDB was unavailable and the engine is a durable no-op. */
  private degraded = false;
  /**
   * Per-route leadership, requested when the first binding serving a route
   * attaches and released when the last one detaches. Exactly one tab replays a
   * given route; a tab never leads a route it has no binding for.
   */
  private readonly leaders = new Map<string, RouteLeadership>();
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
  /** The running drain, while `draining`. */
  private activeDrain: Promise<void> | undefined;
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
      this.registerForWipe();
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

  /**
   * Register the queue as a durable resource. A wipe drops the namespace's
   * registrations, so the clear callback forgets ours and the next enqueue
   * registers again — otherwise a second wipe would miss rows written after
   * the first.
   */
  private registerForWipe(): void {
    if (this.unregisterResource || !this.queue || this.disposed) return;
    this.unregisterResource = this.config.registerResource(async () => {
      this.unregisterResource = undefined;
      await this.queue?.clear();
    });
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

  /**
   * Request cross-tab leadership for `route` (ref-counted per tab). The
   * sync-apply route keeps the pre-#3021 lock name, so it stays mutually
   * exclusive with tabs running an older build; each transport route has its
   * own lock.
   */
  private acquireRoute(route: string): void {
    const existing = this.leaders.get(route);
    if (existing) {
      existing.refs += 1;
      return;
    }
    const root = `smrt-web-outbox-leader:${this.config.namespace}`;
    const lockName = route === SYNC_APPLY_ROUTE ? root : `${root}:${route}`;
    const entry: RouteLeadership = {
      release: () => {},
      isLeader: false,
      refs: 1,
    };
    this.leaders.set(route, entry);
    entry.release = acquireLeadership(
      lockName,
      () => {
        entry.isLeader = true;
        void this.drain();
      },
      () => {
        entry.isLeader = false;
      },
    );
  }

  /** Drop one reference to `route`; the last one releases its lock. */
  private releaseRoute(route: string): void {
    const entry = this.leaders.get(route);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    // Stop leading at once (`leads()` is false, so no new send starts), but
    // hold the lock until an in-flight send and its durable transition settle.
    this.leaders.delete(route);
    void this.settled().then(() => entry.release());
  }

  /** Does this tab currently lead `route`? */
  private leads(route: string): boolean {
    return this.leaders.get(route)?.isLeader === true;
  }

  /**
   * Attach a collection: register its per-object callbacks and bump the ref
   * count. Returns the exact callback record registered so the caller can pass
   * it back to {@link unregisterCollection} for precise removal (two collections
   * on the same object must each detach only their own callbacks). Registering
   * by `object` is what lets rehydrated rows (reloaded from IDB) reach this
   * collection's callbacks even though this session never enqueued them.
   */
  registerCollection(binding: OutboxCollectionBinding): object {
    this.refCount += 1;
    const route = binding.transport
      ? routeOf({ transport: binding.object })
      : binding.syncApply
        ? SYNC_APPLY_ROUTE
        : undefined;
    const record: OutboxBindingRecord = {
      onSyncStateChange: binding.onSyncStateChange,
      onConflict: binding.onConflict,
      transport: binding.transport,
      route,
    };
    let set = this.listenersByObject.get(binding.object);
    if (!set) {
      set = new Set();
      this.listenersByObject.set(binding.object, set);
    }
    set.add(record);
    if (binding.syncApply && !this.syncApply) {
      this.syncApply = binding.syncApply;
    }
    // Leading a newly served route drains its backlog (the grant callback
    // drains; the constructor's post-open drain covers an early grant).
    if (route && !this.disposed) this.acquireRoute(route);
    return record;
  }

  /** The first live transport registered under `name`, if any. */
  private transportFor(name: string): OutboxCommandTransport | undefined {
    const set = this.listenersByObject.get(name);
    if (!set) return undefined;
    for (const record of set) {
      if (record.transport) return record.transport;
    }
    return undefined;
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
    if (set?.delete(record as OutboxBindingRecord)) {
      if (set.size === 0) this.listenersByObject.delete(object);
      const route = (record as OutboxBindingRecord).route;
      if (route) this.releaseRoute(route);
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
    this.registerForWipe();

    const itemId = newItemId();
    const op = envelopeKindToOp(request.kind);
    // A command with no target row (#3021) is identified by its own item id.
    const rowId = request.rowId || itemId;

    // A sync-apply delete carries no payload; create/update carry the
    // row/changed fields. A transport row keeps its payload for every op: the
    // consumer's operation, not sync-apply, defines what a delete needs.
    const payload =
      op === 'delete' && request.transport === undefined
        ? undefined
        : request.data;

    await this.queue.enqueue({
      itemId,
      object: request.object,
      op,
      id: rowId,
      payload,
      baseUpdatedAt: request.baseUpdatedAt,
      transport: request.transport,
    });

    this.emit({
      itemId,
      rowId,
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
      ...(row.transport === undefined ? {} : { transport: row.transport }),
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
   * The replay loop. Gated on: (a) leading at least one route, (b) not paused by an
   * auth failure, (c) `navigator.onLine !== false`, (d) IndexedDB usable. Drains
   * every led route's rows due now (`nextAttemptAt <= now`), oldest-first per
   * route; sync-apply chunks into batches of ≤1000 per POST, one send at a time
   * to preserve each route's FIFO. Concurrency-coalesced: a drain requested while one runs sets a flag
   * to run exactly one more pass, so overlapping triggers never interleave.
   */
  private drain(): Promise<void> {
    if (this.draining) {
      this.drainQueued = true;
      return this.activeDrain ?? Promise.resolve();
    }
    this.draining = true;
    this.activeDrain = (async () => {
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
        this.activeDrain = undefined;
      }
    })();
    return this.activeDrain;
  }

  /**
   * Settles once the drain in flight (if any) has finished its request AND its
   * durable result transition. A route's lock is released only after this, so
   * another tab can never replay a row this tab is still settling.
   */
  private settled(): Promise<void> {
    return (this.activeDrain ?? Promise.resolve()).catch(() => undefined);
  }

  /** One drain pass: send every currently-due batch, then schedule backoff. */
  private async drainOnce(): Promise<void> {
    if (this.disposed) return;
    if (this.paused) return;
    if (this.degraded || !this.queue) return;
    if (isDefinitelyOffline()) return;

    // Group pending rows by route, oldest-first, keeping only routes this tab
    // leads. A row whose route no tab here serves is simply not ours: it waits
    // for the tab that leads its route (or for its queue/collection to attach
    // after a reload) and never blocks another route. A transport row is never
    // re-routed to `sync/apply` — that is exactly the path its consumer closed.
    const byRoute = new Map<string, OutboxRow[]>();
    for (const row of await this.queue.all()) {
      if (row.state !== 'pending') continue;
      const route = routeOf(row);
      if (!this.leads(route)) continue;
      const rows = byRoute.get(route);
      if (rows) rows.push(row);
      else byRoute.set(route, [row]);
    }

    const now = Date.now();
    for (const [route, rows] of byRoute) {
      // FIFO per route: the oldest backed-off row gates every newer one.
      const firstBlocked = rows.findIndex((row) => row.nextAttemptAt > now);
      const due = firstBlocked === -1 ? rows : rows.slice(0, firstBlocked);
      if (route === SYNC_APPLY_ROUTE) {
        const syncApply = this.syncApply;
        if (!syncApply) continue;
        // Chunk into ≤1000-item batches, one POST at a time.
        for (let i = 0; i < due.length; i += MAX_SYNC_APPLY_BATCH_SIZE) {
          if (this.disposed || this.paused || !this.leads(route)) break;
          const chunk = due.slice(i, i + MAX_SYNC_APPLY_BATCH_SIZE);
          if (!(await this.sendBatch(chunk, syncApply))) break;
        }
      } else {
        for (const row of due) {
          if (this.disposed || this.paused || !this.leads(route)) break;
          const transport = this.transportFor(row.transport ?? row.object);
          if (!transport) break;
          if (!(await this.sendCommand(row, transport))) break;
        }
      }
      if (this.disposed || this.paused) return;
    }

    // After processing, some rows may have been re-queued with a backoff gate;
    // schedule the next wake.
    await this.scheduleNextBackoff();
  }

  /**
   * Replay one transport row through its consumer-declared transport (#3021)
   * and map the outcome through the SAME transitions as a sync-apply result. A
   * throw is the ambiguous path (request may or may not have landed): the row
   * stays `pending` with backoff and is resent under the same idempotency key.
   * Returns false when the row remains pending, stopping this route's pass
   * (FIFO per route).
   */
  private async sendCommand(
    row: OutboxRow,
    transport: OutboxCommandTransport,
  ): Promise<boolean> {
    this.emit({
      itemId: row.itemId,
      rowId: row.id,
      object: row.object,
      state: 'uploading',
      attempts: row.attempts,
    });
    let outcome: OutboxCommandResult;
    try {
      outcome = await transport({
        idempotencyKey: row.itemId,
        name: row.transport ?? row.object,
        op: row.op,
        rowId: row.id,
        ...(row.payload === undefined ? {} : { payload: row.payload }),
        ...(row.baseUpdatedAt === undefined
          ? {}
          : { baseUpdatedAt: row.baseUpdatedAt }),
        attempt: row.attempts + 1,
      });
    } catch {
      await this.requeueRow(row, 'network error during command replay');
      return false;
    }
    const result = commandResultToApplyResult(row, outcome);
    if (!result) {
      await this.requeueRow(row, 'unexpected command result shape');
      return false;
    }
    return this.applyResult(row, result);
  }

  /**
   * Send one chunk through `POST {basePath}/sync/apply` and map results back
   * onto durable transitions. On a network reject / non-200 / lost/mismatched
   * response the WHOLE chunk stays `pending` (blind replay is safe) — every row
   * goes back to `pending` with an incremented attempt + backoff so the loop
   * doesn't hot-spin. Returns false when a retryable row remains pending, which
   * stops this drain pass so newer FIFO chunks do not overtake it.
   */
  private async sendBatch(
    chunk: OutboxRow[],
    syncApply: OutboxSyncApplyTarget,
  ): Promise<boolean> {
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
      results = await this.postBatch(items, syncApply);
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
    syncApply: OutboxSyncApplyTarget,
  ): Promise<SyncApplyItemResult[] | undefined> {
    const url = `${syncApply.basePath}/${SYNC_APPLY_ROUTE_SEGMENTS.join('/')}`;
    const response = await syncApply.fetchFn(url, {
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
    // FIFO per route: each led route's oldest pending row gates it, even if a
    // newer row has no backoff delay. Routes this tab does not lead are not
    // ours to wake for.
    let nextAt: number | undefined;
    const seen = new Set<string>();
    for (const row of await this.queue.all()) {
      if (row.state !== 'pending') continue;
      const route = routeOf(row);
      if (seen.has(route)) continue;
      seen.add(route);
      if (!this.leads(route)) continue;
      nextAt =
        nextAt === undefined
          ? row.nextAttemptAt
          : Math.min(nextAt, row.nextAttemptAt);
    }
    if (nextAt === undefined) return;
    const delay = Math.max(0, nextAt - Date.now());
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
    // `disposed` stops the drain loop before its next send; let an in-flight
    // send settle (request + durable transition) before giving up the locks
    // and closing the queue it writes to.
    const leaders = [...this.leaders.values()];
    this.leaders.clear();
    await this.settled();
    for (const entry of leaders) entry.release();
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

/**
 * The per-collection (or per-command-queue) binding registered on attach.
 * `object` is the event-routing key AND, for a `transport` binding, the name
 * transport rows are queued under.
 */
export interface OutboxCollectionBinding {
  object: string;
  onSyncStateChange?: (event: SyncStateEvent) => void;
  onConflict?: (conflict: OutboxConflict) => void;
  /** Replay rows queued under `object` through this transport (#3021). */
  transport?: OutboxCommandTransport;
  /** Declares the sync-apply endpoint (sync-apply bindings only). */
  syncApply?: OutboxSyncApplyTarget;
}

/**
 * Translate a transport's {@link OutboxCommandResult} into the positional
 * sync-apply result shape `applyResult` already maps, so both routes share one
 * state machine. `undefined` for a malformed outcome (treated as retryable,
 * like a malformed sync-apply body).
 */
function commandResultToApplyResult(
  row: OutboxRow,
  outcome: unknown,
): SyncApplyItemResult | undefined {
  if (!outcome || typeof outcome !== 'object') return undefined;
  const { status, reason, updatedAt } = outcome as {
    status?: unknown;
    reason?: unknown;
    updatedAt?: unknown;
  };
  const base = {
    itemId: row.itemId,
    id: row.id,
    ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
  };
  if (status === 'applied') return { ...base, status };
  if (status === 'conflict') {
    return {
      ...base,
      status,
      reason: reason === 'create_conflict' ? 'create_conflict' : 'stale_write',
    };
  }
  if (status === 'rejected' && typeof reason === 'string' && reason) {
    // Unknown reasons are carried verbatim; `applyResult` treats anything that
    // is not write_failed / auth_required / forbidden as terminal.
    return { ...base, status, reason: reason as SyncApplyReason };
  }
  return undefined;
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
