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
 *
 * Deliberately NOT here yet (see PRD #1755): relationship-derived invalidation,
 * SvelteKit hydration seeding, offline outbox, SSE invalidation, persistence,
 * version awareness.
 */

import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { queryCollectionOptions } from '@tanstack/query-db-collection';

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

export interface CreateSmrtCollectionOptions {
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
 */
export function createSmrtCollection<TData extends object>(
  definition: SmrtWebCollectionDefinition<TData>,
  options: CreateSmrtCollectionOptions,
): SmrtWebCollection<TData> {
  type Row = SmrtWebRow<TData>;

  const { staleTimeMs = 30_000, retry = false, scope } = options;
  const fetchers =
    options.fetchers ??
    createDefinitionFetchers(definition, options.basePath, options.fetchFn);
  const queryClient = resolveQueryClient(options.client);
  const idField = definition.idField || 'id';

  // Scope discriminates the cache key so a shared client can materialize the
  // same collection against different backends without cross-serving reads.
  const cacheId = scope
    ? `smrt:${scope}:${definition.name}`
    : `smrt:${definition.name}`;
  const queryKey = scope
    ? ['smrt', scope, definition.name]
    : ['smrt', definition.name];

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
        for (const mutation of transaction.mutations) {
          const modified = mutation.modified as Record<string, unknown>;
          // Strip the client-local id: the generated REST layer rejects or
          // ignores client-supplied ids on create (#1540); the follow-up
          // refetch swaps the optimistic row for the server-assigned one.
          const { [idField]: _localId, ...data } = modified;
          unwrapItemResult(
            await fetchers.create(data),
            `create(${definition.name})`,
          );
        }
      },
      onUpdate: fetchers.update
        ? async ({ transaction }) => {
            for (const mutation of transaction.mutations) {
              const key = String(mutation.key);
              const changes = mutation.changes as Record<string, unknown>;
              unwrapItemResult(
                // biome-ignore lint/style/noNonNullAssertion: guarded by the surrounding ternary
                await fetchers.update!(key, changes),
                `update(${definition.name})`,
              );
            }
          }
        : undefined,
      onDelete: fetchers.delete
        ? async ({ transaction }) => {
            for (const mutation of transaction.mutations) {
              // biome-ignore lint/style/noNonNullAssertion: guarded by the surrounding ternary
              await fetchers.delete!(String(mutation.key));
            }
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
      return collection.preload();
    },
    cleanup() {
      return collection.cleanup();
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
  return handle;
}
