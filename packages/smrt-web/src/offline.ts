/**
 * @happyvertical/smrt-web — the durable offline outbox capability (#1762).
 *
 * The web twin of the KMP mobile write queue: mutations against opted-in
 * collections are captured in a durable browser-side outbox (IndexedDB) that
 * survives reloads and crashes, then replayed FIFO against the idempotent
 * sync-apply batch contract when connectivity returns, with exponential-backoff
 * retries. Because items carry client-generated UUIDs and the endpoint is
 * idempotent (`_insertOnly` create + no-op re-apply), blind retries after an
 * ambiguous failure (request sent, response lost) can never duplicate rows — see
 * the "Idempotency" section of docs/content/architecture/sync-apply-contract.md.
 *
 * This is a {@link SmrtWebCapability} plug-in, so it lives in its OWN module and
 * an app opts a collection in by passing `offlineOutbox(config)` in that
 * collection's `capabilities` array. A collection WITHOUT it is byte-for-byte
 * the collection of today (the seam's no-op guarantee), which is exactly the
 * "offline is opt-in per model" acceptance criterion.
 *
 * ## How it plugs into the seam
 *
 * - `wrapMutation(envelope, ctx)` — BEFORE the fetcher, it enqueues the write
 *   durably and returns `{ handled: true, result: envelope.data }`. The factory
 *   then SUPPRESSES the post-mutation refetch + `invalidateRelated()` (its
 *   `{ refetch: false }` path), so the optimistic row the app just inserted
 *   STANDS instead of being dropped by a refetch of a server list that has never
 *   seen the offline write. The write never touches `ctx.fetchers.create` — it
 *   replays ONLY through `sync/apply`, which is load-bearing: the normal REST
 *   create strips the client id (#1540) and would mint a NEW server id, orphaning
 *   the optimistic row; sync/apply's strict-insert path preserves the client
 *   UUID (#1540, #1540's mass-assignment guard on the sync path).
 * - `onAttach(ctx)` — attaches this collection to the shared, namespace-keyed
 *   {@link OutboxEngine} (ref-counted so N collections share ONE engine / IDB
 *   db / leader lock / FIFO queue).
 * - `teardown(ctx)` — detaches; the last detach disposes the engine (the durable
 *   ROWS survive for the next load).
 *
 * ## Observable state (push callbacks, not a store)
 *
 * Per-mutation sync state — `pending → uploading → synced` (and `→ failed` /
 * conflict) — is delivered through {@link OfflineOutboxConfig.onSyncStateChange}
 * and {@link OfflineOutboxConfig.onConflict}, PUSH callbacks matching the KMP
 * foundation's `pending/uploading/synced/failed` state machine. This is
 * deliberately not a subscribable store: smrt-svelte wraps it into a reactive
 * binding in a later slice. Programmatic access to the durable queue is via
 * {@link getOutboxHandle} (a bridge like `getEngineCollection`).
 *
 * ## Known gap (this slice's scope)
 *
 * The outbox does NOT rehydrate the READ cache after a reload — a reloaded tab's
 * `collection.toArray()` will NOT show captured-offline rows until a fetch runs;
 * that read-side rehydrate is #1764's `warmStart`. So the outbox's durability is
 * proven via {@link OutboxHandle.snapshot} / the raw IndexedDB store, NOT via
 * `collection.toArray()`. The WRITE side (capture → durable → exactly-once
 * replay) is complete here.
 *
 * Engine-free public surface: no `@tanstack/*` type appears — inside the
 * engine-absorption boundary (#1761), verified by
 * scripts/check-smrt-web-engine-boundary.mjs.
 */

import type { SmrtWebCapability } from './capability.js';
import {
  type DurableStoreKey,
  durableStoreNamespace,
  registerDurableResource,
} from './durable-store.js';
import {
  acquireOutboxEngine,
  type OutboxEngine,
  releaseOutboxEngine,
} from './offline/engine.js';
import {
  DEFAULT_BACKOFF,
  type OutboxBackoff,
  type OutboxConflict,
  type ResolvedBackoff,
  type SyncStateEvent,
} from './offline/types.js';

export type {
  OutboxBackoff,
  OutboxConflict,
  OutboxSyncState,
  SyncStateEvent,
} from './offline/types.js';

/**
 * Configuration for {@link offlineOutbox}. Generic in the collection's row type
 * `TData` so the capability matches the collection it plugs into.
 */
export interface OfflineOutboxConfig<TData extends object = object> {
  /**
   * The generated collection definition this outbox serves — its `name` is the
   * sync-apply `object` route segment, so it MUST be the SAME definition passed
   * to {@link createSmrtCollection}. (Named `object` to mirror the capability
   * context; carries the collection's REST route segment.)
   */
  object: { name: string; _row?: TData };
  /**
   * The durable-store identity this outbox's queue is namespaced under — folds
   * api base / tenant / identity / manifest hash, so a logout or tenant switch
   * lands on a different IndexedDB database (never cross-identity reuse). Shared
   * with #1764's persistence slice via the same {@link durableStoreNamespace}.
   * `manifestHash` is opaque caller-supplied config for #1762; its canonical
   * source is #1764's call (a schema-shape digest) — comment your call site.
   */
  namespace: DurableStoreKey;
  /**
   * API base path the sync-apply endpoint lives under (`POST
   * {syncApplyBasePath}/sync/apply`). Defaults to `/api/v1`, matching the REST
   * generator's default. Set to the SvelteKit route base (`/api`) when replaying
   * against the generated SvelteKit `sync/apply/+server.ts`.
   */
  syncApplyBasePath?: string;
  /** Fetch implementation override (tests, SSR). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Exponential-backoff tuning for retryable replay failures. */
  backoff?: OutboxBackoff;
  /**
   * Called on every observable sync-state transition of a captured mutation
   * (`pending → uploading → synced`, `→ failed`, and the `pending` re-arm after
   * a retryable failure). A push callback; smrt-svelte turns it into a reactive
   * binding later.
   */
  onSyncStateChange?: (event: SyncStateEvent) => void;
  /**
   * Called when a replayed mutation comes back `conflict` — a RESOLVED outcome
   * (server state won; the item leaves the queue with terminal state `synced`).
   * Persist `serverUpdatedAt` as the new `baseUpdatedAt`, refetch the row, and
   * surface the conflict to the user as appropriate.
   */
  onConflict?: (conflict: OutboxConflict) => void;
  /** Test-only: inject a deterministic RNG for backoff jitter. */
  random?: () => number;
}

/**
 * A programmatic handle to one namespace's outbox — the bridge pattern (like
 * `getEngineCollection`) for trusted callers (an app's outbox panel, a
 * smrt-svelte binding, tests). Fetched via {@link getOutboxHandle}.
 */
export interface OutboxHandle {
  /**
   * A read-only snapshot of the durable queue (every state). The way to prove
   * durability after a reload, since this slice does not rehydrate the read
   * cache (that's #1764).
   */
  snapshot(): Promise<OutboxSnapshotItem[]>;
  /**
   * Force a retry of a specific queued item now (clears its backoff gate, wakes
   * the loop, and clears an auth pause). A no-op for an item no longer queued.
   */
  retry(itemId: string): Promise<void>;
}

/** One item in an {@link OutboxHandle.snapshot} result. */
export interface OutboxSnapshotItem {
  /** The queue row's idempotency handle. */
  itemId: string;
  /** The collection route segment. */
  object: string;
  /** The mutation kind, in sync-apply terms. */
  op: 'create' | 'update' | 'delete';
  /** The client-generated row UUID. */
  rowId: string;
  /** The on-disk lifecycle state. */
  state: 'pending' | 'synced' | 'failed';
  /** Replay attempts so far. */
  attempts: number;
  /** Epoch ms before which this row won't be retried (backoff). */
  nextAttemptAt: number;
  /** Last replay error, if any. */
  lastError?: string;
}

/** Fill backoff defaults. */
function resolveBackoff(backoff?: OutboxBackoff): ResolvedBackoff {
  return {
    initialDelayMs: backoff?.initialDelayMs ?? DEFAULT_BACKOFF.initialDelayMs,
    multiplier: backoff?.multiplier ?? DEFAULT_BACKOFF.multiplier,
    maxDelayMs: backoff?.maxDelayMs ?? DEFAULT_BACKOFF.maxDelayMs,
  };
}

/**
 * Registry mapping a namespace string to its live engine + bridge handle, so
 * {@link getOutboxHandle} can reach an engine attached by a running collection.
 * A weak-ish bookkeeping map: entries are added on `onAttach` and removed on the
 * final `teardown`.
 */
const handlesByNamespace = new Map<string, OutboxEngine>();

/**
 * Build a durable offline-outbox capability for a collection. Add the returned
 * capability to the collection's `capabilities` array; a collection without it
 * is unaffected (the seam's no-op guarantee — the "opt-in per model" AC).
 *
 * The same `namespace` across multiple collections shares ONE engine (one IDB
 * db, one leader lock, one FIFO queue) — so cross-collection ordering and the
 * multi-tab single-replayer guarantee hold across every opted-in collection of a
 * given identity.
 */
export function offlineOutbox<TData extends object = object>(
  config: OfflineOutboxConfig<TData>,
): SmrtWebCapability<TData> {
  const namespace = durableStoreNamespace(config.namespace);
  const syncApplyBasePath = config.syncApplyBasePath ?? '/api/v1';
  const fetchFn =
    config.fetchFn ??
    ((...args) => globalThis.fetch(...(args as [RequestInfo])));
  const backoff = resolveBackoff(config.backoff);

  const object = config.object.name;
  // The engine this collection attaches to (set in onAttach, released in
  // teardown). Held here so wrapMutation can enqueue through it. `record` is the
  // exact callback binding registered, handed back on teardown for precise
  // removal (two collections on one object each detach only their own).
  let engine: OutboxEngine | undefined;
  let record: object | undefined;

  return {
    name: 'offline-outbox',

    onAttach() {
      const acquired = acquireOutboxEngine(
        {
          namespace,
          syncApplyBasePath,
          fetchFn,
          backoff,
          random: config.random,
          registerResource: (clear) =>
            registerDurableResource(namespace, { kind: 'outbox', clear }),
        },
        {
          object,
          onSyncStateChange: config.onSyncStateChange,
          onConflict: config.onConflict,
        },
      );
      engine = acquired.engine;
      record = acquired.record;
      handlesByNamespace.set(namespace, engine);
    },

    async wrapMutation(envelope) {
      // If onAttach hasn't run yet (shouldn't happen — wrapMutation fires only
      // after construction), fall through so the write isn't silently dropped.
      if (!engine) return { handled: false };
      await engine.enqueue({
        kind: envelope.kind,
        object,
        rowId: envelope.key,
        data: envelope.data,
        // The optimistic row may carry the server updated_at it was based on;
        // pass it through as the conflict guard base when present.
        baseUpdatedAt:
          typeof envelope.data.updatedAt === 'string'
            ? envelope.data.updatedAt
            : typeof envelope.data.updated_at === 'string'
              ? envelope.data.updated_at
              : undefined,
      });
      // The optimistic row (envelope.data) stands in for the fetcher result; the
      // factory suppresses the refetch so it isn't dropped. Exactly-once replay
      // then reconciles it server-side via sync/apply.
      return { handled: true, result: envelope.data };
    },

    async teardown() {
      if (!engine || !record) return;
      const current = engine;
      const currentRecord = record;
      engine = undefined;
      record = undefined;
      // Detach; the final detach disposes the engine. Only drop the handle map
      // entry if THIS release actually evicted the engine (ref count hit 0).
      const before = current.referenceCount;
      await releaseOutboxEngine(namespace, current, object, currentRecord);
      if (before <= 1 && handlesByNamespace.get(namespace) === current) {
        handlesByNamespace.delete(namespace);
      }
    },
  };
}

/**
 * Retrieve the programmatic {@link OutboxHandle} for a durable-store namespace,
 * or `undefined` if no opted-in collection is currently attached under it. The
 * bridge for trusted callers (outbox UI, smrt-svelte binding, tests) to read the
 * durable queue and force retries. Pass the SAME
 * `durableStoreNamespace(config.namespace)` string the capability used.
 *
 * Mirrors the `getEngineCollection` bridge convention: an escape hatch that
 * returns a narrow SMRT-owned surface rather than the engine itself.
 */
export function getOutboxHandle(namespace: string): OutboxHandle | undefined {
  const engine = handlesByNamespace.get(namespace);
  if (!engine) return undefined;
  return {
    snapshot: () => engine.snapshot(),
    retry: (itemId: string) => engine.retry(itemId),
  };
}
