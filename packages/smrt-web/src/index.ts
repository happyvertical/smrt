/**
 * @happyvertical/smrt-web — browser client data runtime (#1761).
 *
 * A typed collection factory that materializes the manifest-generated web
 * collection definitions (`@happyvertical/smrt-virt-web`) as cached, reactive
 * collections over the generated SMRT REST surface.
 *
 * This package is the **engine-absorption boundary**: the client-data engine
 * (currently TanStack DB) is an implementation detail held entirely inside
 * this module. Its types never appear on the public API — collections are
 * handed back as the SMRT-owned {@link SmrtWebCollection}, and the shared cache
 * as the opaque {@link SmrtWebClient} — so the engine stays swappable without a
 * consumer-visible break. Consumers never import `@tanstack/*` directly.
 *
 * Framework-agnostic by construction: this entry imports no UI framework.
 * Svelte live-query bindings ship separately (see PRD #1755) so this core never
 * pulls the Svelte-only `@tanstack/svelte-db` export condition.
 *
 * Scope of this slice:
 * - stale-while-revalidate reads (a `staleTimeMs` window, background revalidation)
 * - concurrent-read dedup (one network request per in-flight collection load)
 * - optimistic create that persists through the generated REST surface and
 *   rolls back automatically when the server errors
 * - relationship-derived invalidation (#1761): a settled mutation invalidates
 *   the caches of the collections related to the mutated one, with the edges
 *   derived from the manifest (`definition.relationships`) — no hand-wired
 *   cache keys. Cross-collection reach requires a shared client from
 *   {@link createSmrtWebClient}; with a private client only the mutated
 *   collection refetches.
 * - hydration seeding (#1761): rows fetched server-side (a SvelteKit
 *   `+page.server.ts` load) seed the shared cache via
 *   {@link CreateSmrtCollectionOptions.initialData}, so the first client read
 *   serves them WITHOUT a duplicate first-render fetch.
 *
 * Deliberately NOT here yet (see PRD #1755): offline outbox, SSE invalidation,
 * persistence, version awareness.
 */

import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { queryCollectionOptions } from '@tanstack/query-db-collection';

import type {
  SmrtWebCapability,
  SmrtWebCapabilityContext,
  SmrtWebMutationEnvelope,
} from './capability.js';
import { runWrapMutation } from './capability.js';

// Re-export the capability seam (#1755) and the shared durable-store foundation
// through this single entry — the package ships one export subpath, so both are
// reachable as `@happyvertical/smrt-web`. Kept in their own modules so each is
// reviewable and testable on its own; surfaced here for consumers-to-be (the
// offline outbox #1762, persistence #1764, and live SSE invalidation
// #1763-client slices).
export type {
  MutationSettleOutcome,
  SmrtWebCapability,
  SmrtWebCapabilityContext,
  SmrtWebMutationEnvelope,
  WrapMutationOutcome,
} from './capability.js';
export { runWrapMutation } from './capability.js';
export type { DurableResource, DurableStoreKey } from './durable-store.js';
export {
  durableStoreNamespace,
  registerDurableResource,
  wipeDurableStore,
} from './durable-store.js';
// The durable offline outbox capability (#1762) — the first concrete capability
// over the seam above. A hand-rolled IndexedDB queue + Web Locks leader election
// (NOT @tanstack/offline-transactions, which would leak an engine type into the
// .d.ts and fail the boundary check). Surfaced here as the root barrel; no
// subpath. The public surface is engine-free by construction.
export type {
  OfflineOutboxConfig,
  OutboxBackoff,
  OutboxConflict,
  OutboxHandle,
  OutboxSnapshotItem,
  OutboxSyncState,
  SyncStateEvent,
} from './offline.js';
export { getOutboxHandle, offlineOutbox } from './offline.js';
// Durable persistence capability (#1764): an opted-in collection warm-starts
// from a durable IndexedDB snapshot on load, then revalidates in the background;
// namespace-keyed (api/tenant/identity/manifest hash) so a contract-changing
// deploy drops old caches and no user reads another's rows. Its own module for
// the same reason as the seam — reviewable/testable on its own (real
// fake-indexeddb + real engine). Engine-free public surface.
export type { PersistCollectionConfig } from './persistence.js';
export {
  DEFAULT_PERSIST_DEBOUNCE_MS,
  persistCollection,
} from './persistence.js';
// Live-updates subscriber (#1763-client): the ONE app-wide SSE `_events`
// subscriber (with `_changes` polling fallback) and the thin per-collection
// `liveInvalidation` capability that wires a collection's `ctx.invalidate()` to
// it. Its own module for the same reason as the seam above — reviewable and
// testable on its own (mock only EventSource + fetch).
export type {
  LiveInvalidationConfig,
  SmrtWebEventSource,
  SmrtWebEventSourceFactory,
  SmrtWebEventSubscriber,
  SmrtWebEventSubscriberConfig,
  SmrtWebSubscriberTransport,
} from './sse-client.js';
export {
  createSmrtWebEventSubscriber,
  liveInvalidation,
} from './sse-client.js';
// Version awareness (#1764): the framework-free `updateAvailable` primitive with
// two independent signals — `bundle` (fed by the smrt-svelte binding from
// SvelteKit's `updated` store) and `contract` (build-time-inject manifest-hash
// compare across loads). The reactive Svelte adapter ships in smrt-svelte.
export type {
  UpdateAvailableState,
  UpdateState,
  UpdateStateConfig,
} from './update-state.js';
export { createUpdateState } from './update-state.js';

// ---------------------------------------------------------------------------
// Generated definition contract (mirrors @happyvertical/smrt-virt-web)
// ---------------------------------------------------------------------------

/**
 * Field metadata emitted per column by the `@happyvertical/smrt-virt-web`
 * virtual module (generated from the package manifest).
 */
export interface SmrtWebFieldDefinition {
  type: string;
  required?: boolean;
  default?: unknown;
}

/** The relationship kinds a generated web collection edge can describe. */
export type SmrtWebRelationshipKind =
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

/**
 * A manifest-derived edge from this collection to a sibling REST collection,
 * emitted by the `@happyvertical/smrt-virt-web` virtual module. When a mutation
 * on this collection settles, the caches of the collections named by these
 * edges are invalidated (relationship-derived invalidation, #1761), so a
 * dependent view refetches without any hand-wired cache key.
 *
 * SMRT-owned data — no client-engine (`@tanstack/*`) type appears here, so it
 * stays inside the engine-absorption boundary.
 */
export interface SmrtWebRelationship {
  /** The declaring field carrying the relationship (e.g. `groupId`, `items`). */
  field: string;
  /** The relationship kind, mirroring the manifest field type. */
  kind: SmrtWebRelationshipKind;
  /** REST collection name the edge resolves to (e.g. `ad_groups`). */
  relatedCollection: string;
}

/**
 * One generated collection definition: everything needed to construct a client
 * collection over the generated REST surface. The `_row` property is a phantom
 * type carrier threaded through codegen — it never exists at runtime, it only
 * lets factories infer the row type from a definition.
 */
export interface SmrtWebCollectionDefinition<TData extends object = object> {
  /** REST collection name (e.g. `products`). */
  name: string;
  /** Source class name (e.g. `Product`). */
  className: string;
  /** Path under the API base path (e.g. `/products`). */
  endpoint: string;
  /** Primary key field name (`id` for SmrtObject). */
  idField: string;
  /** CRUD + custom actions exposed by the api decorator config. */
  actions: string[];
  /** Persisted field metadata keyed by field name. */
  fields: Record<string, SmrtWebFieldDefinition>;
  /**
   * Manifest-derived relationship edges to sibling REST collections. Drives
   * relationship-derived cache invalidation: a settled mutation on this
   * collection invalidates the caches of the collections these edges name.
   * Optional so hand-built definitions (older codegen, tests) still satisfy the
   * type; a missing value means "no derived edges".
   */
  relationships?: SmrtWebRelationship[];
  /** Phantom row-type carrier — never present at runtime. */
  _row?: TData;
}

// ---------------------------------------------------------------------------
// Fetcher contract + payload normalization
// ---------------------------------------------------------------------------

/**
 * The per-collection CRUD surface of the generated REST client
 * (`createClient(basePath).<collection>` from `@happyvertical/smrt-virt-client`).
 *
 * Return types are `unknown` on purpose: generated fetchers resolve with
 * whatever the server sent, so this package normalizes and validates payloads
 * centrally — see {@link unwrapListResult} / {@link unwrapItemResult}.
 */
export interface SmrtCrudFetchers {
  list(params?: Record<string, unknown>): Promise<unknown>;
  get?(id: string): Promise<unknown>;
  create(data: Record<string, unknown>): Promise<unknown>;
  update?(id: string, data: Record<string, unknown>): Promise<unknown>;
  delete?(id: string): Promise<unknown>;
}

/**
 * Raised when a generated-client call resolved with an error payload
 * (`{ error: string }` from the generated REST routes) or an unexpected shape.
 * Thrown inside a mutation handler, this triggers the automatic rollback of
 * optimistic state.
 */
export class SmrtWebRequestError extends Error {
  readonly payload: unknown;

  constructor(message: string, payload?: unknown) {
    super(message);
    this.name = 'SmrtWebRequestError';
    this.payload = payload;
  }
}

/** A row as stored in the client collection: the DTO plus a required key. */
export type SmrtWebRow<TData extends object> = TData & { id: string };

/**
 * Normalize a generated-client list result to an array of rows.
 *
 * The generated REST routes return a bare JSON array; `{ error }` payloads are
 * surfaced as failures. The `{ data: [...] }` envelope is tolerated for
 * ApiResponse-shaped clients (e.g. a mock client).
 */
export function unwrapListResult(
  result: unknown,
  collectionName: string,
): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') {
      throw new SmrtWebRequestError(
        `[smrt-web] list(${collectionName}) failed: ${record.error}`,
        result,
      );
    }
    if (Array.isArray(record.data)) {
      return record.data as Array<Record<string, unknown>>;
    }
  }
  throw new SmrtWebRequestError(
    `[smrt-web] list(${collectionName}) returned an unexpected payload shape`,
    result,
  );
}

/**
 * Normalize a generated-client item result (create/update) to a row.
 * `{ error }` payloads become failures — inside mutation handlers this is what
 * makes optimistic state roll back.
 */
export function unwrapItemResult(
  result: unknown,
  context: string,
): Record<string, unknown> {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string') {
      throw new SmrtWebRequestError(
        `[smrt-web] ${context} failed: ${record.error}`,
        result,
      );
    }
    if (
      record.data &&
      typeof record.data === 'object' &&
      !Array.isArray(record.data)
    ) {
      return record.data as Record<string, unknown>;
    }
    return record;
  }
  throw new SmrtWebRequestError(
    `[smrt-web] ${context} returned an unexpected payload shape`,
    result,
  );
}

/**
 * Build CRUD fetchers from a generated collection definition — the same URL
 * scheme and payload handling as the generated REST client
 * (`basePath + endpoint`), with one improvement: HTTP error statuses reject
 * with the server's `{ error }` body instead of resolving with it.
 */
export function createDefinitionFetchers(
  definition: SmrtWebCollectionDefinition<object>,
  basePath = '/api/v1',
  fetchFn: typeof fetch = (...args) => globalThis.fetch(...args),
): SmrtCrudFetchers {
  const collectionUrl = `${basePath}${definition.endpoint}`;
  const headers = { 'Content-Type': 'application/json' };

  const parse = async (response: Response): Promise<unknown> => {
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        typeof (payload as Record<string, unknown>).error === 'string'
          ? String((payload as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
      throw new SmrtWebRequestError(
        `[smrt-web] ${definition.name} request failed: ${message}`,
        payload,
      );
    }
    return payload;
  };

  return {
    list: async () => parse(await fetchFn(collectionUrl, { headers })),
    get: async (id) =>
      parse(await fetchFn(`${collectionUrl}/${id}`, { headers })),
    create: async (data) =>
      parse(
        await fetchFn(collectionUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(data),
        }),
      ),
    update: async (id, data) =>
      parse(
        await fetchFn(`${collectionUrl}/${id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(data),
        }),
      ),
    delete: async (id) => {
      const response = await fetchFn(`${collectionUrl}/${id}`, {
        method: 'DELETE',
        headers,
      });
      if (!response.ok) {
        throw new SmrtWebRequestError(
          `[smrt-web] delete(${definition.name}) failed: HTTP ${response.status}`,
        );
      }
      return true;
    },
  };
}

/**
 * Generate a client-local id for optimistic inserts. The generated REST layer
 * strips client-supplied ids on create (mass-assignment guard #1540), so this
 * id only identifies the optimistic row until the post-persist refetch swaps in
 * the server-assigned row.
 */
export function newLocalId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Engine-absorbing public surface (no @tanstack/* types leak past here)
// ---------------------------------------------------------------------------

/**
 * Opaque handle to the shared client cache / request-dedup layer. Create one
 * with {@link createSmrtWebClient} and pass the SAME instance to every
 * collection that should share a cache and deduplicate in-flight requests.
 *
 * The engine (currently a TanStack Query client) is intentionally hidden behind
 * this brand so it stays swappable — do not depend on its concrete shape.
 */
export interface SmrtWebClient {
  /** Phantom brand — this handle wraps the hidden client-cache engine. */
  readonly __smrtWebClient: 'SmrtWebClient';
}

/**
 * Engine-side shape of a {@link SmrtWebClient}. Never exported, so the engine
 * type never reaches the public surface. Extends the public brand so the value
 * created here carries the brand at runtime (enabling the validation below).
 */
interface SmrtWebClientEngine extends SmrtWebClient {
  readonly queryClient: QueryClient;
}

/**
 * Create a shared client-cache handle. Pass the returned handle as
 * {@link CreateSmrtCollectionOptions.client} to every collection that should
 * share a cache and deduplicate requests app-wide.
 */
export function createSmrtWebClient(): SmrtWebClient {
  const engine: SmrtWebClientEngine = {
    __smrtWebClient: 'SmrtWebClient',
    queryClient: new QueryClient(),
  };
  return engine;
}

function resolveQueryClient(client?: SmrtWebClient): QueryClient {
  if (!client) return new QueryClient();
  const engine = client as Partial<SmrtWebClientEngine>;
  if (engine.__smrtWebClient !== 'SmrtWebClient' || !engine.queryClient) {
    throw new SmrtWebRequestError(
      '[smrt-web] options.client must be a handle from createSmrtWebClient()',
    );
  }
  return engine.queryClient;
}

/**
 * Project an engine row to a plain public DTO. The client-data engine decorates
 * stored rows with enumerable virtual props (`$synced`/`$origin`/`$key`/
 * `$collectionId`) that would otherwise cross the SMRT boundary through spread
 * or JSON serialization. The `$` prefix is reserved for the engine; SMRT
 * columns never begin with it.
 */
function toPlainRow<TData extends object>(row: unknown): SmrtWebRow<TData> {
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.charCodeAt(0) !== 36 /* '$' */) plain[key] = value;
  }
  return plain as SmrtWebRow<TData>;
}

/** Project the row values carried by a change notification to plain DTOs. */
function projectChanges(changes: unknown): unknown {
  if (!Array.isArray(changes)) return changes;
  return changes.map((change) => {
    if (!change || typeof change !== 'object') return change;
    const record = change as Record<string, unknown>;
    const projected: Record<string, unknown> = { ...record };
    if (record.value && typeof record.value === 'object') {
      projected.value = toPlainRow(record.value);
    }
    if (record.previousValue && typeof record.previousValue === 'object') {
      projected.previousValue = toPlainRow(record.previousValue);
    }
    return projected;
  });
}

/**
 * A pending optimistic mutation. Await {@link isPersisted} to observe the
 * server outcome: it resolves once the write has been persisted through the
 * REST surface, and rejects (rolling the optimistic state back) on error.
 */
export interface SmrtWebTransaction {
  readonly isPersisted: { readonly promise: Promise<unknown> };
}

/** A change-subscription handle. Call {@link unsubscribe} to detach. */
export interface SmrtWebSubscription {
  unsubscribe(): void;
}

/**
 * A live, cached collection of plain-DTO rows — the SMRT-owned public contract
 * over the client-data engine. Exposes only the committed surface; the engine's
 * own type is never named here so it stays swappable.
 */
export interface SmrtWebCollection<TData extends object> {
  /** All rows currently in the collection (plain DTOs, insertion order). */
  readonly toArray: ReadonlyArray<SmrtWebRow<TData>>;
  /** Number of rows currently in the collection. */
  readonly size: number;
  /** True when a row with `key` is present. */
  has(key: string): boolean;
  /** The row with `key`, or `undefined`. */
  get(key: string): SmrtWebRow<TData> | undefined;
  /** Resolve once the first load has completed. */
  preload(): Promise<void>;
  /** Tear down subscriptions and cached state. */
  cleanup(): Promise<void>;
  /** Subscribe to change notifications; returns a detach handle. */
  subscribeChanges(callback: (changes: unknown) => void): SmrtWebSubscription;
  /**
   * Optimistically insert a row and persist it through the create fetcher. The
   * row is visible synchronously; the returned transaction settles on the
   * server outcome (see {@link SmrtWebTransaction}).
   */
  insert(row: SmrtWebRow<TData>): SmrtWebTransaction;
}

/** Extract a row's server revision timestamp for sync/apply conflict guards. */
function getBaseUpdatedAt(row: unknown): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  const value = record.updatedAt ?? record.updated_at;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return undefined;
}

/**
 * Options for {@link createSmrtCollection}. Generic in the collection's row
 * type `TData` so {@link initialData} is checked against the same DTO the
 * collection stores; every other option is row-type-agnostic, so the parameter
 * defaults to `object` and can be omitted at call sites that pass no seed.
 */
export interface CreateSmrtCollectionOptions<TData extends object = object> {
  /**
   * Generated REST client surface for this collection, e.g.
   * `createClient('/api/v1').products` from the virt-client module. When
   * omitted, fetchers are derived from the definition's endpoint and `basePath`
   * with the same URL scheme and payload shapes the generated client uses.
   */
  fetchers?: SmrtCrudFetchers;
  /** API base path for definition-derived fetchers (default `/api/v1`). */
  basePath?: string;
  /** Fetch implementation override (tests, SSR). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Shared cache handle from {@link createSmrtWebClient}. Pass one app-wide
   * instance so collections share a cache and deduplicate requests; a private
   * cache is created when omitted.
   */
  client?: SmrtWebClient;
  /**
   * Cache namespace for this collection's reads. Fold a backend / tenant /
   * preview discriminator in here when the SAME generated collection is
   * materialized against DIFFERENT backends while sharing one {@link client} —
   * without it those reads share a cache key and could serve one backend's rows
   * for the other for the whole `staleTimeMs` window. Omit for the common
   * single-backend case.
   */
  scope?: string;
  /**
   * Stale-while-revalidate window in milliseconds (default 30s): reads within
   * the window are served from the local collection without a network request;
   * the first read after it revalidates in the background.
   */
  staleTimeMs?: number;
  /** Retry failed loads (default false: fail fast, surface errors). */
  retry?: boolean;
  /**
   * Rows to seed this collection's cache with, before its first read — the
   * hydration path for server-rendered data (#1761). Fetch rows in a SvelteKit
   * `+page.server.ts` load, pass them here on the client, and the first read
   * serves them from cache WITHOUT a duplicate first-render network request
   * (SMRT-owned type, so no engine type appears on the option).
   *
   * The seed is written to the cache with a fresh timestamp, so it counts as
   * fresh for `staleTimeMs`: with the default window the first read does not
   * fetch, and the collection revalidates in the background only once the window
   * elapses (or immediately if `staleTimeMs` is 0). Seed the SAME rows the
   * server serialized so the pre- and post-hydration renders match.
   *
   * Seeds the SAME cache key the reads use — so with a shared {@link client},
   * fold the backend / tenant discriminator into {@link scope} to match, exactly
   * as reads do; otherwise one backend's seed would serve the other for the
   * `staleTimeMs` window.
   */
  initialData?: SmrtWebRow<TData>[];
  /**
   * Capability plug-ins hooking the collection lifecycle (#1755) — the seam
   * that lets the offline outbox (#1762), persistence (#1764), and live SSE
   * invalidation (#1763-client) slices each live in their own module instead of
   * contending on this factory. Capabilities run in array order at six fixed
   * points (see {@link SmrtWebCapability}). Additive and defaulting to none: an
   * undefined or empty array is byte-for-byte the collection of today (the
   * no-op guarantee), so this ships zero concrete capabilities by design.
   */
  capabilities?: SmrtWebCapability<TData>[];
}

/**
 * Registry mapping a public collection handle to its underlying engine
 * collection. Keyed weakly so a handle and its engine collection are collected
 * together. Read only through {@link getEngineCollection}.
 */
const engineCollections = new WeakMap<object, unknown>();

/**
 * Retrieve the underlying engine collection backing a handle — an advanced
 * bridge for trusted framework bindings (e.g. the smrt-svelte live-query
 * binding), which must feed the engine collection to the query builder. Returns
 * `unknown` so no engine type crosses the boundary; callers cast. Throws for a
 * handle not produced by {@link createSmrtCollection}. Not needed for normal
 * use.
 */
export function getEngineCollection<TData extends object>(
  handle: SmrtWebCollection<TData>,
): unknown {
  const engine = engineCollections.get(handle);
  if (engine === undefined) {
    throw new SmrtWebRequestError(
      '[smrt-web] getEngineCollection: not a smrt-web collection handle',
    );
  }
  return engine;
}

/**
 * Report a capability hook that threw or rejected, without letting it break the
 * collection (#1755). Capability hooks are third-party plug-ins; one misbehaving
 * hook must not reject a successful mutation, abort construction, or wedge
 * `cleanup()`. smrt-web has no logger dependency (TanStack-only), so this uses
 * `console.warn` — a swallowed diagnostic, matching the package's fail-loud-in-
 * the-console style.
 */
function warnCapability(
  capability: { name: string },
  hook: string,
  error: unknown,
): void {
  // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); a swallowed capability fault is surfaced via console.warn by design (#1755)
  console.warn(
    `[smrt-web] capability "${capability.name}" ${hook} threw; ignoring`,
    error,
  );
}

/**
 * Create a typed client collection over a generated SMRT collection definition
 * and the matching generated REST client fetchers.
 *
 * Reads: stale-while-revalidate. The first subscriber triggers a fetch;
 * re-subscribing within `staleTimeMs` serves local data with no request. N
 * concurrent identical reads coalesce into one network request.
 *
 * Writes: `collection.insert({ ...data, id: newLocalId() })` applies instantly,
 * persists through `fetchers.create()` (the temp id is stripped — the server
 * assigns the real one), then refetches to reconcile. A failed create rejects
 * the transaction and the optimistic row rolls back automatically.
 *
 * Relationship-derived invalidation: once a create/update/delete has persisted,
 * the query caches of this collection AND the collections named by
 * `definition.relationships` (manifest-derived edges) are invalidated, so
 * dependent views refetch. Reaching OTHER collections requires them to share
 * this collection's `client` (see {@link createSmrtWebClient}); with a private
 * client only this collection refetches.
 *
 * Hydration seeding: pass rows fetched server-side as
 * {@link CreateSmrtCollectionOptions.initialData} and the collection's first
 * read is served from them with NO network request (until `staleTimeMs`
 * elapses) — the SvelteKit `+page.server.ts` → hydrate path.
 */
export function createSmrtCollection<TData extends object>(
  definition: SmrtWebCollectionDefinition<TData>,
  options: CreateSmrtCollectionOptions<TData>,
): SmrtWebCollection<TData> {
  type Row = SmrtWebRow<TData>;

  const { staleTimeMs = 30_000, retry = false, scope, initialData } = options;
  const capabilities = options.capabilities ?? [];
  const fetchers =
    options.fetchers ??
    createDefinitionFetchers(definition, options.basePath, options.fetchFn);
  const queryClient = resolveQueryClient(options.client);
  const idField = definition.idField || 'id';

  // Scope discriminates the cache key so a shared client can materialize the
  // same collection against different backends without cross-serving reads.
  // `let` so capabilities can extend the scheme via `contributeCacheKey` below;
  // with no capabilities these stay exactly the base `smrt:(scope:)name` form.
  let cacheId = scope
    ? `smrt:${scope}:${definition.name}`
    : `smrt:${definition.name}`;
  let queryKey = scope
    ? ['smrt', scope, definition.name]
    : ['smrt', definition.name];

  // Relationship-derived invalidation target set (#1761): the collections
  // whose caches a settled mutation on THIS collection must invalidate. Always
  // includes this collection itself (so its own read revalidates) plus every
  // manifest-derived related collection. Built once; a settled write matches
  // any cached query whose collection-name segment (the LAST queryKey element,
  // mirroring the `['smrt', (scope,) name]` scheme above) is in this set.
  //
  // Over-invalidation is safe — a stale query merely refetches. Under-
  // invalidation is the bug (a dependent view showing stale rows), so the
  // predicate matches by collection name across ALL scopes rather than an exact
  // key: a mutation in one scope refreshes the related collection in every
  // scope sharing the client.
  const invalidationTargets = new Set<string>([definition.name]);
  for (const relationship of definition.relationships ?? []) {
    invalidationTargets.add(relationship.relatedCollection);
  }

  /**
   * Invalidate the query caches of this collection and its manifest-derived
   * related collections. Cross-collection reach requires those collections to
   * share this collection's `client` (from {@link createSmrtWebClient}); with a
   * private client only THIS collection's query lives here, so only it
   * refetches. Fire-and-forget: invalidation schedules a background refetch and
   * must not delay the mutation's own settle.
   */
  const invalidateRelated = (): void => {
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (!Array.isArray(key) || key.length === 0) return false;
        const collectionSegment = key[key.length - 1];
        return (
          typeof collectionSegment === 'string' &&
          invalidationTargets.has(collectionSegment)
        );
      },
    });
  };

  // The engine-free context every capability hook receives (#1755). `cacheKey`
  // / `cacheId` are getter-backed over the live `let` bindings, so a capability
  // observes the key AS IT STANDS when it reads: during `contributeCacheKey`
  // (below) that is the base key plus any EARLIER capability's segments (not its
  // own, not-yet-applied one); from `onAttach`/`warmStart` onward it is the
  // FINAL key. `invalidate` enters the same `invalidateRelated()` the factory
  // runs post-mutation, so a capability can refetch off an external trigger.
  const ctx: SmrtWebCapabilityContext<TData> = {
    definition,
    fetchers,
    get cacheKey() {
      return queryKey;
    },
    get cacheId() {
      return cacheId;
    },
    invalidate: () => invalidateRelated(),
    // Engine-free read + subscribe surface for capabilities (#1764 persistence
    // write-back). Both close over the engine `collection` created below and are
    // only ever called from `onAttach` onward (after it exists), so referencing
    // it here is safe. They mirror the public handle's `toArray` /
    // `subscribeChanges` exactly — projecting to plain DTOs so the engine's
    // virtual props never cross the seam.
    snapshot: () => collection.toArray.map((row) => toPlainRow<TData>(row)),
    subscribe: (callback) => {
      const subscription = collection.subscribeChanges((changes: unknown) =>
        callback(projectChanges(changes)),
      );
      return { unsubscribe: () => subscription.unsubscribe() };
    },
  };

  // contributeCacheKey (#1755): fold each capability's returned segments into
  // the cache key/id, extending the base scope-based scheme. Runs ONCE, before
  // construction. Isolated per capability: a throwing contributeCacheKey is
  // logged and skipped rather than aborting construction. With no capabilities
  // this loop is empty and the keys are untouched — the no-op path.
  //
  // CRITICAL — segments are spliced in JUST BEFORE the collection name, so the
  // name stays the LAST queryKey element. `invalidateRelated()`'s predicate
  // (and thus relationship-derived invalidation #1761, and a capability's own
  // `ctx.invalidate()`) identifies a collection by `key[key.length - 1]`;
  // appending segments after the name would hide it from that predicate and
  // silently break invalidation for any collection using contributeCacheKey
  // (exactly the #1764 persistence slice). `cacheId` is an opaque engine id the
  // predicate never reads, so it can keep appending.
  for (const capability of capabilities) {
    let extra: string[] | undefined;
    try {
      extra = capability.contributeCacheKey?.(ctx);
    } catch (error) {
      warnCapability(capability, 'contributeCacheKey', error);
    }
    if (extra && extra.length > 0) {
      // Rebuild as [prefix..., ...extra, name] — name remains last.
      const name = queryKey[queryKey.length - 1];
      const prefix = queryKey.slice(0, -1);
      queryKey = [...prefix, ...extra, name];
      cacheId = `${cacheId}:${extra.join(':')}`;
    }
  }

  // Seed the query cache BEFORE the collection's engine starts its sync, so the
  // first read populates from the seed instead of fetching (verified: zero
  // list() calls). `setQueryData` stamps a fresh `dataUpdatedAt`, so the seed
  // counts as fresh for `staleTime` — the first read serves it with no request,
  // and revalidation fires only once `staleTimeMs` elapses (or immediately when
  // it is 0). An explicit empty seed is honored too: it means "zero rows", a
  // valid fresh state that likewise suppresses the first fetch.
  //
  // Two seed sources with a fixed precedence:
  //   1. `initialData` — hydration seeding (#1761): rows a SvelteKit
  //      `+page.server.ts` load serialized, the fresher same-request SSR truth.
  //   2. a capability `warmStart` (#1755) — e.g. the persistence slice
  //      rehydrating from disk. Only the FIRST capability that returns rows
  //      contributes.
  // `initialData` WINS: it is resolved first, and `warmStart` is only consulted
  // when `initialData` is undefined. With no capabilities, step 2 never runs and
  // this is byte-identical to the #1761 seed — the no-op path.
  //
  // Seed via the ATOMIC updater form: a plain get-then-set would let two
  // collections sharing this key and materialized in the same tick both observe
  // `undefined` and have the later seed clobber the earlier one.
  // `(existing) => existing ?? seed` keeps the first seed (or any already-cached
  // rows, which may be newer than this late payload) in a single cache write.
  const seedCache = (rows: Row[]): void => {
    queryClient.setQueryData<Row[]>(queryKey, (existing) => existing ?? rows);
  };
  // Set by cleanup(); guards the async-warmStart continuations (#1755) so a
  // collection torn down while a rehydrate is still in flight neither seeds the
  // SHARED query cache after teardown (which could suppress the next collection's
  // real fetch on the same client/key) nor preloads the dead engine.
  let disposed = false;
  // Resolve a warmStart result to rows, isolating a sync throw / async reject
  // (logged, treated as "no rows") so a misbehaving provider can neither abort
  // construction nor leak an unhandled rejection.
  const warmRowsFrom = async (
    capability: SmrtWebCapability<TData>,
    warm: Promise<Row[] | undefined> | Row[] | undefined,
  ): Promise<Row[] | undefined> => {
    try {
      return await warm;
    } catch (error) {
      warnCapability(capability, 'warmStart', error);
      return undefined;
    }
  };

  // A pending async `warmStart` (persistence rehydrating from OPFS/IndexedDB).
  // Construction stays synchronous, but `preload()` (below) AWAITS this before
  // starting the engine's own load, so an async rehydrate reliably suppresses
  // the first `list()` on the preload path. A subscribe-driven read that races
  // an unresolved warmStart may still fetch once — bounded, and it self-heals
  // via the atomic seed updater. Undefined when there is no async warmStart.
  let warmStartPending: Promise<void> | undefined;
  if (initialData !== undefined) {
    seedCache(initialData);
  } else {
    // Honor "the FIRST capability that returns ROWS" across BOTH sync and async
    // warmStart. A sync provider that returns rows seeds inline immediately (so
    // it suppresses even a non-preload read). The FIRST provider that returns a
    // Promise hands off to an ORDERED async chain covering itself and every
    // LATER capability, in array order: it awaits each, skips a result that is
    // undefined or throws/rejects, and seeds the first that yields rows. So an
    // async miss or reject no longer blocks a later provider from seeding.
    for (let i = 0; i < capabilities.length; i += 1) {
      const capability = capabilities[i];
      let warm: Promise<Row[] | undefined> | Row[] | undefined;
      try {
        warm = capability.warmStart?.(ctx);
      } catch (error) {
        // A synchronous warmStart throw must not abort construction.
        warnCapability(capability, 'warmStart', error);
        continue;
      }
      if (warm === undefined) continue;
      if (warm instanceof Promise) {
        const firstPromise = warm;
        warmStartPending = (async () => {
          // This capability first (its promise is already in flight), then each
          // later capability in order until one yields rows.
          let rows = await warmRowsFrom(capability, firstPromise);
          for (
            let j = i + 1;
            rows === undefined && j < capabilities.length;
            j += 1
          ) {
            const later = capabilities[j];
            let laterWarm: Promise<Row[] | undefined> | Row[] | undefined;
            try {
              laterWarm = later.warmStart?.(ctx);
            } catch (error) {
              warnCapability(later, 'warmStart', error);
              continue;
            }
            if (laterWarm === undefined) continue;
            rows = await warmRowsFrom(later, laterWarm);
          }
          // Skip the seed if the collection was cleaned up while the rehydrate
          // was in flight — a late write to the shared cache could otherwise
          // suppress the NEXT collection's real fetch on the same client/key.
          if (rows !== undefined && !disposed) seedCache(rows);
        })();
        break;
      }
      seedCache(warm);
      break;
    }
  }

  // Notify every capability that a mutation settled (#1755) — on BOTH a
  // successful persist and a fetcher throw. Per-capability try/catch so this
  // genuinely NEVER throws: a throwing onSettled must not reject a SUCCESSFUL
  // mutation nor mask a fetcher error, and one bad capability must not stop the
  // others being notified. With no capabilities this loop is empty — the no-op
  // path.
  const notifySettled = (
    envelope: SmrtWebMutationEnvelope,
    outcome: { ok: true; result: unknown } | { ok: false; error: unknown },
  ): void => {
    for (const capability of capabilities) {
      try {
        capability.onSettled?.(envelope, outcome, ctx);
      } catch (error) {
        warnCapability(capability, 'onSettled', error);
      }
    }
  };

  /**
   * Persist one mutation through the capability seam then the real fetcher.
   * First offers the write to `wrapMutation` (array order, first-handled-wins):
   * a handling capability's result stands in for the fetcher (the offline
   * path), otherwise `runFetcher` performs the real write. On success notifies
   * `onSettled({ ok: true })`; on ANY throw notifies `onSettled({ ok: false })`
   * and RE-THROWS so the optimistic state still rolls back.
   *
   * Returns `handled` so the caller can suppress the engine's post-mutation
   * refetch for an offline write (#1762): a handled write never hit the server,
   * so refetching the server list would DROP the optimistic row the outbox must
   * keep until it replays. With no capabilities `runWrapMutation` returns
   * `{ handled: false }` and both notify loops are empty, so this reduces to
   * `await runFetcher()` with `handled: false` — behavior identical to before
   * the seam.
   */
  const persistMutation = async (
    envelope: SmrtWebMutationEnvelope,
    runFetcher: () => Promise<unknown>,
  ): Promise<{ handled: boolean; result: unknown }> => {
    try {
      const wrapped = await runWrapMutation(capabilities, envelope, ctx);
      const result = wrapped.handled ? wrapped.result : await runFetcher();
      notifySettled(envelope, { ok: true, result });
      return { handled: wrapped.handled, result };
    } catch (error) {
      notifySettled(envelope, { ok: false, error });
      throw error;
    }
  };

  const collection = createCollection(
    queryCollectionOptions<Row>({
      id: cacheId,
      queryKey,
      queryClient,
      staleTime: staleTimeMs,
      retry,
      queryFn: async () =>
        unwrapListResult(await fetchers.list(), definition.name) as Array<Row>,
      getKey: (row) => String((row as Record<string, unknown>)[idField]),
      onInsert: async ({ transaction }) => {
        let anyHandled = false;
        for (const mutation of transaction.mutations) {
          const modified = mutation.modified as Record<string, unknown>;
          // Offer the write to the capability seam first (#1755), then fall
          // through to the real create fetcher. The envelope carries the FULL
          // optimistic row; the fetcher closure strips the client-local id: the
          // generated REST layer rejects or ignores client-supplied ids on
          // create (#1540), and the follow-up refetch swaps the optimistic row
          // for the server-assigned one.
          const envelope: SmrtWebMutationEnvelope = {
            kind: 'insert',
            key: String(modified[idField]),
            data: modified,
          };
          const outcome = await persistMutation(envelope, async () => {
            const { [idField]: _localId, ...data } = modified;
            return unwrapItemResult(
              await fetchers.create(data),
              `create(${definition.name})`,
            );
          });
          anyHandled = anyHandled || outcome.handled;
        }
        // If a capability handled the write offline (#1762) it never reached the
        // server, so BOTH the engine's own post-mutation refetch (suppressed via
        // `{ refetch: false }`) and `invalidateRelated()` are skipped — else the
        // server list, which lacks the offline row, would drop the optimistic
        // row the outbox must keep until it replays. A mixed batch (some
        // handled, some not) is conservative: if ANY mutation was handled we
        // suppress, so an unsent row is never dropped; the common case is one
        // mutation per transaction. An UNHANDLED batch behaves exactly as
        // before: refetch runs and related caches invalidate.
        if (anyHandled) return { refetch: false };
        invalidateRelated();
      },
      onUpdate: fetchers.update
        ? async ({ transaction }) => {
            let anyHandled = false;
            for (const mutation of transaction.mutations) {
              const key = String(mutation.key);
              const changes = mutation.changes as Record<string, unknown>;
              const envelope: SmrtWebMutationEnvelope = {
                kind: 'update',
                key,
                data: changes,
                baseUpdatedAt: getBaseUpdatedAt(mutation.original),
              };
              const outcome = await persistMutation(envelope, async () =>
                unwrapItemResult(
                  // biome-ignore lint/style/noNonNullAssertion: guarded by the surrounding ternary
                  await fetchers.update!(key, changes),
                  `update(${definition.name})`,
                ),
              );
              anyHandled = anyHandled || outcome.handled;
            }
            if (anyHandled) return { refetch: false };
            invalidateRelated();
          }
        : undefined,
      onDelete: fetchers.delete
        ? async ({ transaction }) => {
            let anyHandled = false;
            for (const mutation of transaction.mutations) {
              const key = String(mutation.key);
              const envelope: SmrtWebMutationEnvelope = {
                kind: 'delete',
                key,
                data: {},
                baseUpdatedAt: getBaseUpdatedAt(mutation.original),
              };
              const outcome = await persistMutation(envelope, async () =>
                // biome-ignore lint/style/noNonNullAssertion: guarded by the surrounding ternary
                fetchers.delete!(key),
              );
              anyHandled = anyHandled || outcome.handled;
            }
            if (anyHandled) return { refetch: false };
            invalidateRelated();
          }
        : undefined,
    }),
  );

  // Wrap the engine collection in the SMRT-owned public surface. The wrapper
  // projects rows to plain DTOs at every read boundary (toArray/get and change
  // payloads) so the engine's virtual props never escape, and confines the
  // engine's own types to this module.
  const handle: SmrtWebCollection<TData> = {
    get toArray() {
      return collection.toArray.map((row) => toPlainRow<TData>(row));
    },
    get size() {
      return collection.size;
    },
    has(key) {
      return collection.has(key);
    },
    get(key) {
      const row = collection.get(key);
      return row === undefined ? undefined : toPlainRow<TData>(row);
    },
    preload() {
      // Gate the first read on a pending async warmStart (#1755) so an async
      // rehydrate (persistence over OPFS/IndexedDB) reliably seeds the cache
      // BEFORE the engine's own load runs — otherwise the fetch that persistence
      // was meant to suppress would race ahead. Resolved/rejected warmStart is
      // already handled (seeded or logged); we only need to await settlement.
      //
      // When there is NO pending warmStart (incl. the no-op path and the
      // `initialData` seed path) return the engine promise DIRECTLY — no extra
      // async wrapper — so the microtask timing is byte-identical to before the
      // seam (a wrapper tick would let a staleTime:0 revalidation land early).
      if (!warmStartPending) return collection.preload();
      // If cleanup() ran while the warmStart was still pending, don't preload the
      // torn-down engine — resolve to nothing.
      return warmStartPending.then(() => {
        if (disposed) return;
        return collection.preload();
      });
    },
    async cleanup() {
      // Mark disposed FIRST so any still-pending async warmStart continuation
      // sees it and skips seeding the shared cache / preloading the dead engine
      // (#1755, Fix G) — even though the continuation runs on a later tick.
      disposed = true;
      // Tear down the engine first, THEN each capability (#1755) — so a
      // capability's teardown runs against a stopped engine. Awaited so async
      // teardowns (closing an SSE stream, flushing a store) complete before
      // cleanup() resolves. Per-capability try/catch so one rejecting teardown
      // does not skip the others nor reject cleanup(). With no capabilities this
      // awaits nothing extra.
      await collection.cleanup();
      for (const capability of capabilities) {
        try {
          await capability.teardown?.(ctx);
        } catch (error) {
          warnCapability(capability, 'teardown', error);
        }
      }
    },
    subscribeChanges(callback) {
      const subscription = collection.subscribeChanges((changes: unknown) =>
        callback(projectChanges(changes)),
      );
      return { unsubscribe: () => subscription.unsubscribe() };
    },
    insert(row) {
      return collection.insert(row) as unknown as SmrtWebTransaction;
    },
  };

  engineCollections.set(handle, collection);

  // onAttach (#1755): now that the engine collection exists, let each capability
  // wire an external (non-mutation) trigger — an SSE subscription, a focus
  // listener — with a callable `ctx.invalidate()`. Runs ONCE, in array order.
  // Per-capability try/catch so a throwing onAttach cannot break construction
  // after the handle is already registered, nor skip later capabilities. With
  // no capabilities this loop is empty — the no-op path.
  for (const capability of capabilities) {
    try {
      capability.onAttach?.(ctx);
    } catch (error) {
      warnCapability(capability, 'onAttach', error);
    }
  }

  return handle;
}
