/**
 * Opt-in read-through cache for collection reads (issue #1498).
 *
 * SSR-rendered SMRT apps re-query read-heavy / write-rare collections on
 * every request, and the per-query round-trip dominates wall time when a
 * page needs many collections. This module memoizes `list()`/`get()` row
 * sets keyed by the final SQL + parameters, for an opt-in TTL.
 *
 * Correctness model:
 * - Caching is OFF by default. It is enabled per call
 *   (`list({ cache: { ttl } })`) or per model (`@smrt({ cache: { ttl } })`).
 * - SMRT owns every mutation path (`save()`/`delete()` back
 *   `collection.create()`, `getOrUpsert()`, junction attach/detach), so all
 *   writes invalidate the affected table's entries in-process automatically.
 * - Entries are scoped per database identity (`db.url`) and per table, so
 *   multi-DB processes and STI siblings (which share a table) stay coherent.
 * - Caches are per-process. With multiple replicas, a local invalidation
 *   leaves peers stale until TTL unless cross-process invalidation is opted
 *   into (`crossProcess: true`), which broadcasts over the database
 *   adapter's notification capability (e.g. Postgres LISTEN/NOTIFY) when
 *   the adapter provides one.
 *
 * Cached values are raw result rows, not hydrated instances — hydration and
 * read interceptors (tenancy, audit) run on every call, cached or not, and
 * each caller receives isolated row copies.
 *
 * Known limitations:
 * - Invalidation fires when a mutation's SQL executes, not when its
 *   surrounding transaction commits. A write inside an uncommitted
 *   transaction invalidates (and may broadcast) immediately; a concurrent
 *   reader could repopulate the cache from the pre-commit snapshot, and a
 *   rollback leaves the cache invalidated for a write that never landed.
 *   Caching targets read-heavy / write-rare data where this is rare; for
 *   models mutated inside multi-statement transactions, coherence is still
 *   bounded by TTL. Per-call `cache: false` forces a fresh read where it
 *   matters.
 * - Writes that bypass the framework's mutation paths (raw `db.query`
 *   issued outside `collection.query()`, external processes without
 *   `crossProcess`) are only bounded by TTL.
 *
 * @see https://github.com/happyvertical/smrt/issues/1498
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';

const logger = createLogger({ level: 'info' });

/**
 * Read-through cache configuration for collection reads.
 *
 * Used both per call (`collection.list({ cache: { ttl: 60_000 } })`) and per
 * model (`@smrt({ cache: { ttl: 60_000 } })`).
 */
export interface CollectionCacheConfig {
  /**
   * Time-to-live for cached query results, in milliseconds. Must be > 0.
   */
  ttl: number;

  /**
   * Broadcast invalidations to peer processes through the database
   * adapter's notification capability (`db.notifications`, e.g. Postgres
   * LISTEN/NOTIFY). Without this, peer replicas serve stale rows until TTL.
   *
   * Model-level config (`@smrt({ cache })`) is the reliable opt-in: every
   * process that writes the model knows to broadcast. As a per-call option,
   * writes broadcast only from processes that have already performed a
   * `crossProcess` cached read of the same table (typical for homogeneous
   * replicas running the same routes); a process that only writes never
   * learns about the per-call opt-in, so its peers fall back to TTL expiry.
   *
   * Ignored (with a one-time warning) when the adapter does not expose
   * notifications.
   */
  crossProcess?: boolean;
}

interface CacheEntry {
  expiresAt: number;
  rows: Record<string, unknown>[];
}

/**
 * Per-table entry cap. A table accumulating more distinct query shapes than
 * this within one TTL window evicts its oldest entries (insertion order).
 * Guards against unbounded growth from high-cardinality WHERE values.
 */
const MAX_ENTRIES_PER_TABLE = 500;

/**
 * Notification channel used for cross-process invalidation broadcasts.
 */
export const CACHE_INVALIDATION_CHANNEL = 'smrt_collection_cache';

/**
 * Identifies this process in broadcast payloads so a replica can skip
 * notifications it published itself (it already invalidated locally).
 *
 * Exported so sibling cross-replica buses (the #1763 change-signal bus) share
 * one per-process identity, keeping echo-avoidance consistent across channels.
 */
export const PROCESS_ID = crypto.randomUUID();

/**
 * dbKey → tableName → (queryKey → entry)
 */
const store = new Map<string, Map<string, Map<string, CacheEntry>>>();

/**
 * Reads currently populating a cache entry, scoped the same way as cached
 * rows. A shared promise prevents concurrent identical cache misses from
 * exhausting the connection pool with duplicate SELECTs.
 */
const inFlightReads = new Map<
  string,
  Map<string, Map<string, Map<number, Promise<Record<string, unknown>[]>>>>
>();

/**
 * Share an in-progress cache miss with callers for the same database, table,
 * and final query key. Rejected reads are removed too, so a later caller can
 * retry rather than inheriting a permanently failed promise.
 */
export function getOrCreateInFlightRead(
  dbKey: string,
  tableName: string,
  queryKey: string,
  generation: number,
  read: () => Promise<Record<string, unknown>[]>,
): Promise<Record<string, unknown>[]> {
  let tables = inFlightReads.get(dbKey);
  if (!tables) {
    tables = new Map();
    inFlightReads.set(dbKey, tables);
  }
  let entries = tables.get(tableName);
  if (!entries) {
    entries = new Map();
    tables.set(tableName, entries);
  }

  let generations = entries.get(queryKey);
  if (!generations) {
    generations = new Map();
    entries.set(queryKey, generations);
  }
  const existing = generations.get(generation);
  if (existing) return existing;

  let inFlight: Promise<Record<string, unknown>[]>;
  inFlight = read().finally(() => {
    if (generations.get(generation) === inFlight) {
      generations.delete(generation);
      if (generations.size === 0 && entries.get(queryKey) === generations) {
        entries.delete(queryKey);
        if (entries.size === 0 && tables.get(tableName) === entries) {
          tables.delete(tableName);
          if (tables.size === 0 && inFlightReads.get(dbKey) === tables) {
            inFlightReads.delete(dbKey);
          }
        }
      }
    }
  });
  generations.set(generation, inFlight);
  return inFlight;
}

/**
 * Monotonic invalidation generation per `dbKey\0tableName`, bumped on every
 * invalidation. A read captures the generation *before* its DB round-trip and
 * passes it to `setCachedRows`; if an invalidating write landed during the
 * round-trip, the generation no longer matches and the (now-stale) result is
 * dropped instead of cached. This closes the read-miss/concurrent-write race
 * where an in-flight SELECT would otherwise repopulate the cache with
 * pre-write rows for the full TTL.
 */
const generations = new Map<string, number>();

function generationKey(dbKey: string, tableName: string): string {
  return `${dbKey}\0${tableName}`;
}

/**
 * Current invalidation generation for a table (0 if never invalidated).
 * Capture this before a DB read and pass it to `setCachedRows`.
 */
export function getCacheGeneration(dbKey: string, tableName: string): number {
  return generations.get(generationKey(dbKey, tableName)) ?? 0;
}

/**
 * Fallback identities for database instances that expose no URL
 * (each such instance gets its own scope, never shared).
 */
const fallbackDbKeys = new WeakMap<object, string>();

/**
 * Resolve a stable cache scope for a database instance.
 *
 * Mirrors table-verifier's identity resolution (`db.url || config.url`).
 * `:memory:` databases share that URL string while being entirely separate
 * databases, so they (and URL-less instances) are scoped per instance —
 * serving one in-memory database's rows for another would be a correctness
 * bug, not just a stale read.
 */
export function resolveDbCacheKey(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & {
    config?: { url?: string };
  };
  const url = db.url || dbWithConfig.config?.url;
  if (url && url !== ':memory:') return url;

  let key = fallbackDbKeys.get(db);
  if (!key) {
    key = `smrt-db:${crypto.randomUUID()}`;
    fallbackDbKeys.set(db, key);
  }
  return key;
}

/**
 * Build the cache key for a query. The final SQL and bound parameters fully
 * normalize the query shape — they already include STI discriminator
 * filters, interceptor-injected tenant filters, ORDER BY, LIMIT and OFFSET.
 */
export function buildQueryCacheKey(sql: string, params: unknown[]): string {
  return `${sql}\0${JSON.stringify(params)}`;
}

/**
 * Read cached rows for a query, or undefined on miss/expiry.
 *
 * Returns a structured clone so callers can never mutate the cached copy
 * (hydration writes into row objects).
 */
export function getCachedRows(
  dbKey: string,
  tableName: string,
  queryKey: string,
): Record<string, unknown>[] | undefined {
  const entry = store.get(dbKey)?.get(tableName)?.get(queryKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.get(dbKey)?.get(tableName)?.delete(queryKey);
    return undefined;
  }
  return structuredClone(entry.rows);
}

/**
 * Store rows for a query under the table's cache scope.
 *
 * `expectedGeneration` is the value {@link getCacheGeneration} returned before
 * the DB read. If an invalidation bumped the table's generation while the read
 * was in flight, the result is stale and is dropped rather than cached.
 */
export function setCachedRows(
  dbKey: string,
  tableName: string,
  queryKey: string,
  rows: Record<string, unknown>[],
  ttl: number,
  expectedGeneration?: number,
): void {
  if (!(ttl > 0)) return;

  // Drop a result that a concurrent write invalidated mid-flight.
  if (
    expectedGeneration !== undefined &&
    getCacheGeneration(dbKey, tableName) !== expectedGeneration
  ) {
    return;
  }

  let tables = store.get(dbKey);
  if (!tables) {
    tables = new Map();
    store.set(dbKey, tables);
  }
  let entries = tables.get(tableName);
  if (!entries) {
    entries = new Map();
    tables.set(tableName, entries);
  }

  // Evict oldest entries (Map preserves insertion order) at the cap. Skip when
  // refreshing an existing key — `set` updates it in place without growing the
  // map, so evicting first would drop a live entry and shrink the effective cap.
  if (!entries.has(queryKey)) {
    while (entries.size >= MAX_ENTRIES_PER_TABLE) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  entries.set(queryKey, {
    expiresAt: Date.now() + ttl,
    rows: structuredClone(rows),
  });
}

/**
 * Drop every cached entry for a table. Called by the framework after any
 * successful mutation against that table — this is the write-invalidation
 * guarantee an app-side cache can't make.
 */
export function invalidateCollectionCache(
  dbKey: string,
  tableName: string,
): void {
  store.get(dbKey)?.delete(tableName);
  // Bump the generation so any read whose DB round-trip is still in flight
  // discards its (now-stale) result instead of repopulating the table.
  const gkey = generationKey(dbKey, tableName);
  generations.set(gkey, (generations.get(gkey) ?? 0) + 1);
}

/**
 * Clear all cached collection reads and stop cross-process listeners.
 * Call in test setup to ensure isolation between test files.
 */
export function resetCollectionCache(): void {
  store.clear();
  inFlightReads.clear();
  generations.clear();
  crossProcessInterest.clear();
  stopCacheInvalidationListeners();
}

// ============================================================================
// Per-call crossProcess interest (write-side broadcast decision)
// ============================================================================

/**
 * dbKey → tables this process has cached with a per-call `crossProcess`
 * opt-in. Writes consult this so per-call usage broadcasts too — model-level
 * config can't be the only trigger when the opt-in lives at the call site.
 */
const crossProcessInterest = new Map<string, Set<string>>();

/**
 * Record that a per-call `crossProcess` cached read happened for a table.
 */
export function registerCrossProcessCacheInterest(
  dbKey: string,
  tableName: string,
): void {
  let tables = crossProcessInterest.get(dbKey);
  if (!tables) {
    tables = new Set();
    crossProcessInterest.set(dbKey, tables);
  }
  tables.add(tableName);
}

/**
 * Whether any per-call `crossProcess` cached read has touched this table.
 */
export function hasCrossProcessCacheInterest(
  dbKey: string,
  tableName: string,
): boolean {
  return crossProcessInterest.get(dbKey)?.has(tableName) ?? false;
}

// ============================================================================
// Cross-process invalidation (opt-in, via db.notifications)
// ============================================================================

interface ListenerHandle {
  iterator: AsyncIterator<unknown> | null;
  stopped: boolean;
}

const listeners = new Map<string, ListenerHandle>();
const warnedNoNotifications = new Set<string>();

/**
 * The database adapter's optional notification capability (e.g. Postgres
 * LISTEN/NOTIFY), or `undefined` when the adapter exposes none. Duck-typed so
 * core never depends on a concrete adapter shape. Exported so sibling
 * cross-replica buses (the #1763 change-signal bus) resolve it identically.
 */
export function getNotifications(db: DatabaseInterface) {
  return (db as DatabaseInterface & { notifications?: unknown })
    .notifications as
    | {
        notify(channel: string, payload: unknown): Promise<number>;
        listen(
          channel: string,
          options?: Record<string, unknown>,
        ): AsyncIterable<{ channel: string; payload: unknown }>;
      }
    | undefined;
}

function warnOnceNoNotifications(dbKey: string, context: string): void {
  if (warnedNoNotifications.has(dbKey)) return;
  warnedNoNotifications.add(dbKey);
  logger.warn(
    `Collection cache: crossProcess invalidation requested but the database ` +
      `adapter exposes no notification capability (${context}). Peer ` +
      `replicas will serve stale rows until TTL.`,
  );
}

/**
 * Broadcast a table invalidation to peer processes.
 *
 * Fire-and-forget from mutation paths: a broadcast failure must never fail
 * the write that triggered it.
 */
export async function broadcastCacheInvalidation(
  db: DatabaseInterface,
  tableName: string,
): Promise<void> {
  const notifications = getNotifications(db);
  const dbKey = resolveDbCacheKey(db);
  if (!notifications) {
    warnOnceNoNotifications(dbKey, 'broadcast');
    return;
  }
  try {
    await notifications.notify(CACHE_INVALIDATION_CHANNEL, {
      table: tableName,
      source: PROCESS_ID,
    });
  } catch (error) {
    logger.warn(
      `Collection cache: failed to broadcast invalidation for ${tableName}`,
      { error: error instanceof Error ? error.message : error },
    );
  }
}

/**
 * Ensure a background listener consumes invalidation broadcasts for this
 * database and drops matching local cache entries.
 *
 * Started lazily by the first cached read that opted into `crossProcess`.
 * Notifications published by this process are skipped — the local
 * invalidation already happened synchronously on the write path.
 */
export function ensureCacheInvalidationListener(db: DatabaseInterface): void {
  const dbKey = resolveDbCacheKey(db);
  if (listeners.has(dbKey)) return;

  const notifications = getNotifications(db);
  if (!notifications) {
    warnOnceNoNotifications(dbKey, 'listen');
    return;
  }

  const handle: ListenerHandle = { iterator: null, stopped: false };
  listeners.set(dbKey, handle);

  void (async () => {
    try {
      const iterable = notifications.listen(CACHE_INVALIDATION_CHANNEL);
      const iterator = iterable[Symbol.asyncIterator]();
      handle.iterator = iterator;

      while (!handle.stopped) {
        const { value, done } = await iterator.next();
        if (done || handle.stopped) break;

        const notification = value as { payload?: unknown };
        const payload: unknown =
          typeof notification?.payload === 'string'
            ? safeParse(notification.payload)
            : notification?.payload;

        if (!payload || typeof payload !== 'object') continue;
        const record = payload as { table?: unknown; source?: unknown };
        if (typeof record.table !== 'string') continue;
        if (record.source === PROCESS_ID) continue;

        invalidateCollectionCache(dbKey, record.table);
      }
    } catch (error) {
      if (!handle.stopped) {
        logger.warn(
          'Collection cache: invalidation listener terminated unexpectedly; ' +
            'cross-process invalidation is inactive for this database ' +
            '(local TTL still bounds staleness)',
          { error: error instanceof Error ? error.message : error },
        );
      }
    } finally {
      // Only retract our own handle. A concurrent stop+restart for the same
      // dbKey may have already installed a replacement; deleting unconditionally
      // would orphan it and leak/duplicate the live listener.
      if (listeners.get(dbKey) === handle) {
        listeners.delete(dbKey);
      }
    }
  })();
}

/**
 * Stop all cross-process invalidation listeners. Used by tests and during
 * shutdown; safe to call when none are active.
 */
export function stopCacheInvalidationListeners(): void {
  for (const handle of listeners.values()) {
    handle.stopped = true;
    void handle.iterator?.return?.(undefined);
  }
  listeners.clear();
  warnedNoNotifications.clear();
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
