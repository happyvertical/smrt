/**
 * @happyvertical/smrt-web — browser client data runtime (spike #1756).
 *
 * A typed collection factory that wraps TanStack DB query collections over
 * the generated SMRT REST client. Consumers never import TanStack directly:
 * the beta surface (TanStack DB 0.6) is absorbed inside this package so a
 * fallback (the same generated fetchers over plain TanStack Query) stays a
 * one-package swap.
 *
 * Scope of the spike:
 * - stale-while-revalidate reads (staleTime window, background revalidation)
 * - optimistic create that persists through the generated client and rolls
 *   back automatically when the server errors
 *
 * Deliberately NOT here yet (see PRD #1755): offline outbox, SSE
 * invalidation, persistence, version awareness.
 */

import { createCollection } from '@tanstack/db';
import type { Collection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import {
  type QueryCollectionUtils,
  queryCollectionOptions,
} from '@tanstack/query-db-collection';

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
 * One generated collection definition: everything needed to construct a
 * client collection over the generated REST surface. The `_row` property is
 * a phantom type carrier threaded through codegen — it never exists at
 * runtime, it only lets factories infer the row type from a definition.
 */
export interface SmrtCollectionDefinition<TData extends object = object> {
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

/**
 * The per-collection CRUD surface of the generated REST client
 * (`createClient(basePath).<collection>` from `@happyvertical/smrt-virt-client`).
 *
 * Return types are `unknown` on purpose: the generated fetchers resolve with
 * whatever the server sent (they never reject on HTTP error status), so this
 * package normalizes and validates payloads centrally — see
 * {@link SmrtWebRequestError}.
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
 * (`{ error: string }` from the generated REST routes) or an unexpected
 * shape. Thrown inside TanStack DB mutation handlers this triggers the
 * automatic rollback of optimistic state.
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

export interface CreateSmrtCollectionOptions {
  /**
   * Generated REST client surface for this collection, e.g.
   * `createClient('/api/v1').products` from the virt-client module. When
   * omitted, fetchers are derived from the definition's endpoint and
   * `basePath` with the same URL scheme and payload shapes the generated
   * client uses.
   *
   * (Spike note #1756: in builds that run both smrtPlugin and smrtConsumer
   * — products standalone/federation — importing the virt-client module
   * currently loads the consumer plugin's fallback instead, whose generated
   * code is invalid for qualified manifest keys. Definition-derived
   * fetchers avoid depending on that resolution path.)
   */
  fetchers?: SmrtCrudFetchers;
  /** API base path for definition-derived fetchers (default `/api/v1`). */
  basePath?: string;
  /** Fetch implementation override (tests, SSR). Defaults to global fetch. */
  fetchFn?: typeof fetch;
  /**
   * Shared TanStack Query client. Pass one app-wide instance so collections
   * share a cache and deduplicate requests; a private instance is created
   * when omitted.
   */
  queryClient?: QueryClient;
  /**
   * Stale-while-revalidate window in milliseconds (default 30s): reads
   * within the window are served from the local collection without a
   * network request; the first read after it revalidates in the background.
   */
  staleTimeMs?: number;
  /** Retry failed loads (default false: fail fast, surface errors). */
  retry?: boolean;
}

/**
 * Build CRUD fetchers from a generated collection definition — the same URL
 * scheme and payload handling as the generated REST client
 * (`basePath + endpoint`), with one improvement: HTTP error statuses reject
 * with the server's `{ error }` body instead of resolving with it.
 */
export function createDefinitionFetchers(
  definition: SmrtCollectionDefinition<object>,
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
 * The collection type returned by {@link createSmrtCollection}: a TanStack
 * DB collection carrying the typed rows plus query utils (refetch etc.).
 */
export type SmrtWebCollection<TData extends object> = Collection<
  SmrtWebRow<TData>,
  string,
  QueryCollectionUtils<SmrtWebRow<TData>, string, SmrtWebRow<TData>>
>;

/**
 * Normalize a generated-client list result to an array of rows.
 *
 * The generated REST routes return a bare JSON array; `{ error }` payloads
 * are surfaced as failures because the generated fetchers resolve (never
 * reject) on HTTP error statuses. The `{ data: [...] }` envelope is
 * tolerated for ApiResponse-shaped clients (e.g. the products template's
 * mock client).
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
 * `{ error }` payloads become failures — inside mutation handlers this is
 * what makes optimistic state roll back.
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
 * Generate a client-local id for optimistic inserts. The generated REST
 * layer strips client-supplied ids on create (mass-assignment guard #1540),
 * so this id only identifies the optimistic row until the post-persist
 * refetch swaps in the server-assigned row.
 */
export function newLocalId(): string {
  const cryptoRef = globalThis.crypto as Crypto | undefined;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Create a typed TanStack DB query collection over a generated SMRT
 * collection definition and the matching generated REST client fetchers.
 *
 * Reads: stale-while-revalidate. The first subscriber triggers a fetch;
 * re-subscribing within `staleTimeMs` serves local data with no request.
 *
 * Writes: `collection.insert({ ...data, id: newLocalId() })` applies
 * instantly, persists through `fetchers.create()` (the temp id is stripped
 * — the server assigns the real one), then refetches to reconcile. A failed
 * create rejects the transaction and TanStack DB rolls the optimistic row
 * back automatically.
 */
export function createSmrtCollection<TData extends object>(
  definition: SmrtCollectionDefinition<TData>,
  options: CreateSmrtCollectionOptions,
): SmrtWebCollection<TData> {
  type Row = SmrtWebRow<TData>;

  const { staleTimeMs = 30_000, retry = false } = options;
  const fetchers =
    options.fetchers ??
    createDefinitionFetchers(definition, options.basePath, options.fetchFn);
  const queryClient = options.queryClient ?? new QueryClient();
  const idField = definition.idField || 'id';

  return createCollection(
    queryCollectionOptions<Row>({
      id: `smrt:${definition.name}`,
      queryKey: ['smrt', definition.name],
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
  ) as SmrtWebCollection<TData>;
}
