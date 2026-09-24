/**
 * @happyvertical/smrt-web — the durable persistence capability (#1764).
 *
 * The read-side twin of the offline outbox (#1762): an opted-in collection
 * WARM-STARTS from a durable browser snapshot on load — rendering stale rows
 * instantly — then the engine revalidates in the background via its normal SWR.
 * A reload therefore paints last-known data with zero network round-trip before
 * the fresh fetch lands. This is the read-cache rehydrate the outbox explicitly
 * left to #1764 (see offline.ts "Known gap").
 *
 * This is a {@link SmrtWebCapability} plug-in, so it lives in its OWN module and
 * an app opts a collection in by passing `persistCollection(config)` in that
 * collection's `capabilities` array. A collection WITHOUT it is byte-for-byte
 * the collection of today (the seam's no-op guarantee) — nothing persists
 * implicitly, which is exactly the "persistence is opt-in per model" acceptance
 * criterion. Sensitive models simply omit the capability and never touch disk.
 *
 * ## How it plugs into the seam
 *
 * - `warmStart(ctx)` — reads the persisted snapshot for
 *   `(durableStoreNamespace(namespace), collection)` and returns its rows to
 *   seed the cache (the factory's rehydrate path; `preload()` awaits the async
 *   return so it suppresses the first `list()`). If the namespace's
 *   `manifestHash` changed, the key differs → NO snapshot is found → an empty
 *   return → a fresh fetch with NO stale-schema hydration. So "a manifest-hash
 *   change drops persisted caches" is AUTOMATIC via the namespace including the
 *   hash — no explicit invalidation.
 * - `onAttach(ctx)` — subscribes to the collection's changes (via the seam's
 *   engine-free `ctx.subscribe`) and persists the current row snapshot
 *   (`ctx.snapshot`) DEBOUNCED (trailing) to avoid thrashing IndexedDB on a
 *   burst of writes. Also registers the shared store as a durable resource so a
 *   logout `wipeDurableStore` clears it.
 * - `teardown(ctx)` — unsubscribes, unregisters the durable resource BEFORE
 *   closing IndexedDB (the #1762 discipline: a later `wipeDurableStore` is then a
 *   no-op, never a double-clear), and the LAST detach closes the shared db. The
 *   durable SNAPSHOT survives for the next load.
 *
 * ## Namespace segregation + logout wipe (shared with the outbox)
 *
 * The durable namespace folds api base / tenant / identity / manifest hash, so
 * switching users on one device lands on a DIFFERENT IndexedDB database — one
 * user can never read another's persisted rows. The SAME namespace is shared
 * with the outbox (#1762), so registering this store under it means a single
 * {@link wipeDurableStore} on logout clears BOTH the persisted collections AND
 * the outbox queue in one call (the "logout wipe clears persisted data AND
 * outbox state" AC).
 *
 * ## Degrade, don't crash
 *
 * If IndexedDB is unavailable (a probe `open()` throws — private mode, sandboxed
 * iframe), the capability `console.warn`s ONCE and behaves as non-persistent:
 * `warmStart` returns nothing (normal fetch), write-back is a no-op. It never
 * throws — matching the outbox's `probeIndexedDb()` posture.
 *
 * Engine-free public surface: no `@tanstack/*` type appears — inside the
 * engine-absorption boundary (#1761), verified by
 * scripts/check-smrt-web-engine-boundary.mjs.
 */

import type { SmrtWebCapability } from './capability.js';
import type { SmrtWebDataSurfaceIdentity } from './data-surface-actions.js';
import {
  type DurableStoreKey,
  durableStoreNamespace,
  registerDurableResource,
} from './durable-store.js';
import {
  openSnapshotStore,
  probeIndexedDb,
  type SnapshotStore,
} from './persistence/snapshot-store.js';

/** Default trailing-debounce window (ms) for the write-back. */
export const DEFAULT_PERSIST_DEBOUNCE_MS = 250;

/**
 * Configuration for {@link persistCollection}. Generic in the collection's row
 * type `TData` so the capability matches the collection it plugs into.
 */
export interface PersistCollectionConfig<TData extends object = object> {
  /**
   * The REST collection name this snapshot is keyed by — MUST be the SAME
   * `definition.name` passed to {@link createSmrtCollection} (it is the store
   * key under the namespace). Provided explicitly (not read off the ctx) so the
   * config is self-describing and testable.
   */
  collection: string;
  /**
   * The durable-store identity this snapshot is namespaced under — folds api
   * base / tenant / identity / manifest hash, so a logout, tenant switch, or a
   * contract-changing deploy lands on a different IndexedDB database (never
   * cross-identity reuse, and a shape change drops old snapshots). Shared with
   * the outbox (#1762) via the same {@link durableStoreNamespace}, so one
   * {@link wipeDurableStore} clears both.
   *
   * The canonical `manifestHash` source is the build-time inject — the
   * `manifestHash` constant the generated `@happyvertical/smrt-virt-web` module
   * exports (#1764). Thread it here at the call site.
   */
  namespace: DurableStoreKey;
  /**
   * Trailing-debounce window (ms) for the write-back snapshot. A burst of
   * mutations within the window collapses to ONE IndexedDB write of the final
   * row set. Default {@link DEFAULT_PERSIST_DEBOUNCE_MS}. Set 0 to write on
   * every change (tests).
   */
  debounceMs?: number;
}

/**
 * A shared, ref-counted snapshot store for one namespace: N opted-in
 * collections of a given identity share ONE IndexedDB database (like the
 * outbox's shared queue). Opened lazily on first attach, closed on last detach.
 */
interface SharedSnapshotEngine {
  /** The open store, once its async open resolves. */
  store: SnapshotStore | undefined;
  /** Resolves to the store (or undefined if IndexedDB is unavailable). */
  ready: Promise<SnapshotStore | undefined>;
  /** How many attached collections reference this engine. */
  refCount: number;
  /** Unregister the durable resource registered on first attach. */
  unregister: (() => void) | undefined;
  /**
   * Bumped synchronously when a `wipeDurableStore` clears this namespace, so a
   * data-surface save captured before the wipe can tell it is stale and must
   * not write the wiped rows back (#3021).
   */
  wipeEpoch: number;
}

/** Registry mapping a namespace string to its shared snapshot engine. */
const enginesByNamespace = new Map<string, SharedSnapshotEngine>();

/** One-time IndexedDB-unavailable warning, module-wide. */
let warnedNoIndexedDb = false;
function warnNoIndexedDbOnce(): void {
  if (warnedNoIndexedDb) return;
  warnedNoIndexedDb = true;
  // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); a degraded-to-non-persistent notice surfaces via console.warn by design (#1764)
  console.warn(
    '[smrt-web] IndexedDB is unavailable; persistence is disabled (collections behave as non-persistent).',
  );
}

/**
 * Acquire (or create) the shared snapshot engine for `namespace`, bumping its
 * ref count. On first acquire it probes IndexedDB, opens the store, and
 * registers ONE durable resource so {@link wipeDurableStore} clears every
 * persisted collection under the namespace. A probe failure resolves the engine
 * with `store: undefined` (non-persistent) and warns once.
 */
function acquireSnapshotEngine(namespace: string): SharedSnapshotEngine {
  const existing = enginesByNamespace.get(namespace);
  if (existing) {
    existing.refCount += 1;
    return existing;
  }

  // Build the engine, then attach `ready` — the async open assigns back onto
  // `engine`, so it must exist first (avoids a use-before-assigned self-ref).
  const engine: SharedSnapshotEngine = {
    store: undefined,
    refCount: 1,
    unregister: undefined,
    ready: Promise.resolve(undefined),
    wipeEpoch: 0,
  };
  engine.ready = (async () => {
    const usable = await probeIndexedDb();
    if (!usable) {
      warnNoIndexedDbOnce();
      return undefined;
    }
    try {
      const store = await openSnapshotStore(namespace);
      engine.store = store;
      // Register the shared store as a durable resource so a logout wipe clears
      // every persisted collection under this namespace at once — alongside the
      // outbox's own registered resource.
      engine.unregister = registerDurableResource(namespace, {
        kind: 'persisted-collection',
        clear: () => {
          engine.wipeEpoch += 1;
          return store.clear();
        },
      });
      return store;
    } catch {
      warnNoIndexedDbOnce();
      return undefined;
    }
  })();
  enginesByNamespace.set(namespace, engine);
  return engine;
}

/**
 * Release one reference to the shared engine. The LAST release unregisters the
 * durable resource (so a later wipe is a no-op) and closes the database. Awaits
 * `ready` first so a release that races the async open still tears down cleanly.
 */
async function releaseSnapshotEngine(namespace: string): Promise<void> {
  const engine = enginesByNamespace.get(namespace);
  if (!engine) return;
  engine.refCount -= 1;
  if (engine.refCount > 0) return;
  enginesByNamespace.delete(namespace);
  // Ensure the open settled before we unregister/close (a teardown right after
  // construction can outrun the async open).
  await engine.ready;
  // Unregister BEFORE closing so a concurrent wipeDurableStore neither
  // double-clears nor touches a closed db (the #1762 discipline).
  engine.unregister?.();
  engine.unregister = undefined;
  engine.store?.close();
  engine.store = undefined;
}

/**
 * Build a durable persistence capability for a collection. Add the returned
 * capability to the collection's `capabilities` array; a collection without it
 * is unaffected (the seam's no-op guarantee — the "opt-in per model" AC).
 *
 * The same `namespace` across multiple collections shares ONE snapshot database
 * (one open, one durable resource, one wipe), and each collection is keyed by
 * its own `collection` name within it.
 */
export function persistCollection<TData extends object = object>(
  config: PersistCollectionConfig<TData>,
): SmrtWebCapability<TData> {
  const namespace = durableStoreNamespace(config.namespace);
  const collectionName = config.collection;
  const debounceMs = config.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;

  // Per-collection instance state (set in onAttach, torn down in teardown).
  let engine: SharedSnapshotEngine | undefined;
  let subscription: { unsubscribe(): void } | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // The latest snapshot getter, captured from ctx at attach; used by the flush
  // so it always writes the CURRENT rows.
  let readSnapshot: (() => ReadonlyArray<Record<string, unknown>>) | undefined;
  let detached = false;
  // Single-flight write-back: `flushing` is the in-progress write; `dirty` marks
  // that a change arrived while a write was running, so the flusher re-reads the
  // (possibly newer) snapshot and writes again. This makes the LAST state always
  // win regardless of how the async store-open / save promises interleave — the
  // race that a naive "fire a flush per change" loses.
  let flushing: Promise<void> | undefined;
  let dirty = false;

  const doFlush = async (): Promise<void> => {
    while (dirty && !detached) {
      dirty = false;
      if (!engine || !readSnapshot) return;
      const store = await engine.ready;
      if (detached || !store) return;
      // Clone to a plain array so the persisted snapshot is a stable copy of the
      // rows at this instant (IndexedDB clones on write, but decouple the ref set
      // now for determinism).
      const rows = readSnapshot().map((row) => ({ ...row }));
      try {
        await store.save(collectionName, rows);
      } catch {
        // Best-effort: a failed write must not break the collection. The next
        // change re-attempts; a quota error simply means the reload won't warm.
      }
    }
  };

  /** Kick the single-flight flusher, coalescing concurrent requests. */
  const runFlush = (): void => {
    dirty = true;
    if (flushing) return;
    flushing = doFlush().finally(() => {
      flushing = undefined;
      // A change that arrived during the final await re-armed `dirty`; run again.
      if (dirty && !detached) runFlush();
    });
  };

  const scheduleFlush = (): void => {
    if (detached) return;
    // ALWAYS via a timer (even at 0ms), so a pending write is CANCELABLE. This
    // is load-bearing at teardown: the engine's own cleanup() fires a
    // "rows removed" change BEFORE this capability's teardown unsubscribes, and
    // a synchronous flush there would persist an empty snapshot over the good
    // one. Because teardown runs right after `await collection.cleanup()` and a
    // setTimeout(0) is a macrotask, teardown's clearTimeout cancels that
    // cleanup-triggered flush before it can run. Mid-life writes fire normally.
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(
      () => {
        debounceTimer = undefined;
        runFlush();
      },
      Math.max(0, debounceMs),
    );
    // Don't keep the event loop alive solely for a pending write (Node/test
    // parity, matching the outbox's poll-timer unref).
    (debounceTimer as { unref?: () => void }).unref?.();
  };

  return {
    name: 'persistence',

    async warmStart(ctx) {
      // Rehydrate from disk. A different namespace (tenant/identity/manifest
      // change) means this collection's snapshot is in a different database and
      // simply isn't found here → undefined → the engine fetches fresh with no
      // stale-schema hydration. `ctx.definition.name` must match config.collection;
      // we key on the explicit config value (the store key) for determinism.
      const acquired = acquireSnapshotEngine(namespace);
      engine = acquired;
      // Enable write-back ONLY when the seam actually exposes a row snapshot.
      // `ctx.snapshot` is optional (a hand-built test ctx may omit it); without
      // it, `() => [] ` would persist an EMPTY snapshot over a prior good one, so
      // treat write-back as a no-op instead (readSnapshot stays undefined).
      readSnapshot = ctx.snapshot ? () => ctx.snapshot?.() ?? [] : undefined;
      const store = await acquired.ready;
      if (!store) return undefined; // non-persistent (no IndexedDB)
      const rows = await store.load(collectionName);
      if (!rows || rows.length === 0) return undefined;
      // The persisted rows are plain DTOs already carrying `id`; hand them back
      // as the seed. (SmrtWebRow<TData> = TData & { id: string }.)
      return rows as Array<TData & { id: string }>;
    },

    onAttach(ctx) {
      // If warmStart didn't run (shouldn't happen — it runs before construction
      // when initialData is absent; but initialData WINS and skips warmStart),
      // acquire here so write-back still persists.
      if (!engine) {
        engine = acquireSnapshotEngine(namespace);
      }
      if (!readSnapshot && ctx.snapshot) {
        readSnapshot = () => ctx.snapshot?.() ?? [];
      }
      // Write-back requires BOTH a row snapshot to read and a change stream to
      // trigger on. If the seam omits either (both are optional hooks), leave
      // persistence write-back a NO-OP — never schedule a flush that would
      // persist an empty snapshot over a prior good one (honors the optional-hook
      // contract; the real factory always populates both, so no prod impact).
      if (!ctx.snapshot || !ctx.subscribe || !readSnapshot) return;
      // Subscribe to changes and persist (debounced) on each. The seam's
      // `ctx.subscribe` mirrors the public handle's subscribeChanges (plain-DTO
      // payloads); we only need the SIGNAL, then re-read via ctx.snapshot.
      subscription = ctx.subscribe(() => scheduleFlush());
      // Persist once on attach too, so a collection seeded by initialData (which
      // skipped warmStart) still writes an initial snapshot for the next load.
      scheduleFlush();
    },

    async teardown() {
      // teardown runs AFTER the engine collection's own cleanup(), which fires a
      // "rows removed" change. Two guards keep that from persisting an empty
      // snapshot over the good one: (1) `detached = true` FIRST makes any
      // subsequent scheduleFlush a no-op; (2) clearing the debounce timer cancels
      // a flush the cleanup change scheduled just before this ran (it's a pending
      // macrotask, so clearing it here wins). The per-change write-back already
      // persisted the latest rows DURING the collection's life, so nothing is
      // lost. We then drain any in-flight write so it commits before closing.
      detached = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      subscription?.unsubscribe();
      subscription = undefined;
      readSnapshot = undefined;
      // Wait out any write already in flight so it durably commits.
      if (flushing) await flushing;
      const current = engine;
      engine = undefined;
      if (current) {
        await releaseSnapshotEngine(namespace);
      }
    },
  };
}

/** Configuration for {@link persistDataSurface}. */
export interface PersistDataSurfaceConfig {
  /**
   * The durable-store identity — the SAME key the app's collections and
   * outbox use. It folds the principal (`identityId`) and tenant, so a surface
   * whose rows the server scopes per principal lands on a per-principal
   * database: another user on the device never reads them, and one
   * `wipeDurableStore(namespace)` on logout clears them with everything else.
   */
  namespace: DurableStoreKey;
  /** The mounted surface's identity (`descriptor.identity`) — the store key. */
  identity: SmrtWebDataSurfaceIdentity;
  /** Trailing-debounce window for `save` (ms). Default {@link DEFAULT_PERSIST_DEBOUNCE_MS}. */
  debounceMs?: number;
}

/** A durable row snapshot for one mounted data surface (#3021). */
export interface PersistedDataSurface<TRow extends object = object> {
  /**
   * The rows last saved for this surface under this namespace, or `undefined`
   * when none exist (first load, a different principal/tenant/manifest, a
   * wipe, or no IndexedDB). Render them as stale, then revalidate.
   */
  load(): Promise<TRow[] | undefined>;
  /**
   * Replace the persisted rows (debounced, trailing; last call wins). Pass the
   * surface's CURRENT rows whenever the page refreshes them. Rows must be
   * structured-clone-safe plain objects.
   */
  save(rows: readonly TRow[]): void;
  /** Write any pending `save` now. */
  flush(): Promise<void>;
  /** Flush a pending `save`, then release the shared store. */
  dispose(): Promise<void>;
}

/** Store key for a surface identity — cannot collide with a collection name. */
function dataSurfaceSnapshotKey(identity: SmrtWebDataSurfaceIdentity): string {
  if (
    !identity ||
    typeof identity.surfaceId !== 'string' ||
    identity.surfaceId.length === 0 ||
    typeof identity.kind !== 'string'
  ) {
    throw new TypeError(
      'persistDataSurface requires an identity with a surfaceId and kind',
    );
  }
  return `data-surface:${JSON.stringify([
    identity.kind,
    identity.surfaceId,
    identity.subject?.type ?? null,
    identity.subject?.id ?? null,
  ])}`;
}

/**
 * Persist and rehydrate a mounted data surface's rows (#3021) — the
 * `persistCollection` twin for a surface (e.g. one registered with
 * `mountListDataSurface`) whose rows come from a server-scoped data-surface
 * query rather than a generated `list` route. The page owns its rows, so it
 * owns the calls: `load()` before the first fetch to paint stale rows, then
 * `save(rows)` whenever it refreshes them.
 *
 * Shares the namespace's snapshot database, durable-resource registration,
 * and IndexedDB-unavailable degrade with {@link persistCollection}: a
 * manifest-hash, tenant, or identity change lands on a different database, and
 * `wipeDurableStore(namespace)` clears the surface's rows with the rest.
 */
export function persistDataSurface<TRow extends object = object>(
  config: PersistDataSurfaceConfig,
): PersistedDataSurface<TRow> {
  const namespace = durableStoreNamespace(config.namespace);
  const key = dataSurfaceSnapshotKey(config.identity);
  const debounceMs = config.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  let engine: SharedSnapshotEngine | undefined =
    acquireSnapshotEngine(namespace);
  let pending:
    | { rows: Array<Record<string, unknown>>; wipeEpoch: number }
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Serialize writes so a slower earlier save can never land after a later one.
  let writing: Promise<void> = Promise.resolve();

  const writePending = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const next = pending;
    pending = undefined;
    const current = engine;
    if (!next || !current) return writing;
    writing = writing.then(async () => {
      const store = await current.ready;
      // A wipe since this save was captured (logout, tenant switch) means these
      // rows belong to a cleared scope: drop them rather than resurrect them.
      // No await between this check and `save` opening its transaction, and
      // IndexedDB runs readwrite transactions on one store in creation order,
      // so a later wipe's clear always lands after this write.
      if (!store || current.wipeEpoch !== next.wipeEpoch) return;
      try {
        await store.save(key, next.rows);
      } catch {
        // Best-effort, like persistCollection: a failed write only means the
        // next load does not warm.
      }
    });
    return writing;
  };

  return {
    async load() {
      const current = engine;
      if (!current) return undefined;
      const store = await current.ready;
      if (!store) return undefined;
      const rows = await store.load(key);
      if (!rows || rows.length === 0) return undefined;
      return rows as TRow[];
    },
    save(rows) {
      if (!engine) return;
      if (!Array.isArray(rows)) {
        throw new TypeError(
          'persistDataSurface.save requires an array of rows',
        );
      }
      pending = {
        rows: rows.map((row) => ({ ...(row as Record<string, unknown>) })),
        wipeEpoch: engine.wipeEpoch,
      };
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = undefined;
          void writePending();
        },
        Math.max(0, debounceMs),
      );
      (timer as { unref?: () => void }).unref?.();
    },
    flush: () => writePending(),
    async dispose() {
      if (!engine) return;
      await writePending();
      engine = undefined;
      await releaseSnapshotEngine(namespace);
    },
  };
}
