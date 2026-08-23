/**
 * WebMCP browser tool registration (#1812).
 *
 * Registers each collection's generated {@link WebToolDescriptor}s with the
 * browser's WebMCP registry (`document.modelContext.registerTool`) so an
 * in-page AI agent can discover and invoke them — see
 * https://developer.chrome.com/docs/ai/webmcp. Each tool's `execute` runs
 * through the shared smrt-web collection AS THE PAGE'S AUTHENTICATED USER, so
 * the generated REST guards (auth, tenant gate #1554, writable + sensitive-field
 * policy #1540) are the security boundary — nothing is re-implemented here.
 *
 * Framework-agnostic: this module imports no UI framework. `document.modelContext`
 * is a browser global, not a dependency. Mutation actions use the same
 * optimistic/invalidation path as page code through `createSmrtCollection`.
 */

import {
  createDefinitionFetchers,
  createSmrtCollection,
  newLocalId,
  type SmrtCrudFetchers,
  type SmrtWebClient,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  type SmrtWebTransaction,
  unwrapItemResult,
  unwrapListResult,
  type WebToolDescriptor,
} from './index.js';

/** The subset of Chrome's WebMCP `registerTool` input this tracer emits. */
interface WebMcpToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/** The slice of `document.modelContext` this module depends on. */
interface ModelContextLike {
  // WebMCP removes a tool via an AbortSignal passed as the second arg, NOT via a
  // returned handle — see https://developer.chrome.com/docs/ai/webmcp/imperative-api.
  registerTool: (
    tool: WebMcpToolRegistration,
    options?: { signal?: AbortSignal },
  ) => void;
}

/**
 * Feature-detect `document.modelContext`. Returns undefined off-WebMCP (SSR,
 * non-Chrome, or Chrome without the origin trial) so every entry point no-ops.
 */
function getModelContext(): ModelContextLike | undefined {
  const doc = (globalThis as { document?: { modelContext?: unknown } })
    .document;
  const mc = doc?.modelContext;
  if (mc && typeof (mc as ModelContextLike).registerTool === 'function') {
    return mc as ModelContextLike;
  }
  return undefined;
}

export interface RegisterWebMcpToolsOptions {
  /** REST base path for the fetchers (default `/api/v1`). */
  basePath?: string;
  /** Injectable fetch (tests / SSR-safe wrappers). */
  fetchFn?: typeof fetch;
  /** Shared smrt-web cache handle used by page collections. */
  client?: SmrtWebClient;
  /** Optional cache scope matching the page collection's scope. */
  scope?: string;
  /**
   * Override how a definition's CRUD fetchers are built. Defaults to
   * {@link createDefinitionFetchers}; the primary seam for testing `execute`
   * without a live server.
   */
  resolveFetchers?: (
    definition: SmrtWebCollectionDefinition,
  ) => SmrtCrudFetchers;
  /** Predicate to include/exclude individual tools (e.g. reads-only surfaces). */
  filter?: (
    definition: SmrtWebCollectionDefinition,
    descriptor: NonNullable<
      SmrtWebCollectionDefinition['toolDescriptors']
    >[number],
  ) => boolean;
}

/**
 * Register every collection's generated tool descriptors with WebMCP.
 *
 * @returns a disposer that deregisters all tools this call registered. On a
 * browser without WebMCP the call is a no-op and the disposer is inert.
 */
export function registerWebMcpTools(
  definitions: SmrtWebCollectionDefinition[],
  options: RegisterWebMcpToolsOptions = {},
): () => void {
  const ctx = getModelContext();
  if (!ctx) return () => {};

  const basePath = options.basePath ?? '/api/v1';
  // ONE controller deregisters every tool this call registers: WebMCP removes a
  // tool when the signal it was registered with aborts, so the returned disposer
  // simply aborts. Idempotent — a second call is a harmless no-op.
  const controller = new AbortController();
  const collections = new Map<
    SmrtWebCollectionDefinition,
    SmrtWebCollection<Record<string, unknown>>
  >();

  for (const definition of definitions) {
    const descriptors = definition.toolDescriptors;
    if (!descriptors || descriptors.length === 0) continue;

    const fetchers = options.resolveFetchers
      ? options.resolveFetchers(definition)
      : createDefinitionFetchers(definition, basePath, options.fetchFn);
    const collection = createSmrtCollection(definition, {
      fetchers,
      basePath,
      fetchFn: options.fetchFn,
      ...(options.client ? { client: options.client } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
    }) as SmrtWebCollection<Record<string, unknown>>;
    collections.set(definition, collection);

    for (const descriptor of descriptors) {
      if (options.filter && !options.filter(definition, descriptor)) continue;

      ctx.registerTool(
        {
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: descriptor.inputSchema,
          annotations: { readOnlyHint: descriptor.readOnly },
          execute: (args) =>
            dispatch(
              fetchers,
              collection,
              definition,
              descriptor.action,
              descriptor.route,
              args ?? {},
            ),
        },
        { signal: controller.signal },
      );
    }
  }

  return () => {
    controller.abort();
    for (const collection of collections.values()) {
      void collection.cleanup();
    }
  };
}

/** Require and return a string `id` from tool args, or throw a clear error. */
function requireId(args: Record<string, unknown>, action: string): string {
  const id = args.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`WebMCP ${action} requires a string 'id' argument`);
  }
  return id;
}

/**
 * Resolve a `get` identifier: `id`, or `slug` as a fallback. The generated REST
 * route and `collection.get()` both resolve either, and the get tool schema
 * advertises both, so a slug-only call must work.
 */
function requireIdentifier(args: Record<string, unknown>): string {
  const value = args.id ?? args.slug;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error("WebMCP get requires a string 'id' or 'slug' argument");
  }
  return value;
}

/** Narrow the list-tool args to the fetcher's query params. */
function listParams(args: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (args.limit !== undefined) params.limit = args.limit;
  if (args.offset !== undefined) params.offset = args.offset;
  if (args.orderBy !== undefined) params.orderBy = args.orderBy;
  if (args.where !== undefined) params.where = args.where;
  return params;
}

/**
 * Route a tool call to the collection's REST fetchers and return a STRING —
 * WebMCP's `execute` contract. Reuses the package's existing payload
 * normalization ({@link unwrapListResult} / {@link unwrapItemResult}), so
 * `{ error }` bodies surface as thrown `SmrtWebRequestError`s the agent sees.
 */
async function dispatch(
  fetchers: SmrtCrudFetchers,
  collection: SmrtWebCollection<Record<string, unknown>>,
  definition: SmrtWebCollectionDefinition,
  action: string,
  route: WebToolDescriptor['route'],
  args: Record<string, unknown>,
): Promise<string> {
  switch (action) {
    case 'list': {
      const rows = unwrapListResult(
        await fetchers.list(listParams(args)),
        definition.name,
      );
      return JSON.stringify(rows);
    }

    case 'get': {
      if (!fetchers.get)
        throw new Error(`${definition.name} has no get action`);
      const row = unwrapItemResult(
        await fetchers.get(requireIdentifier(args)),
        `get(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'create': {
      const localId = newLocalId();
      const transaction = collection.insert({ ...args, id: localId });
      const row = unwrapItemResult(
        await settleTransaction(transaction, collection, localId, args),
        `create(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'update': {
      if (!fetchers.update) {
        throw new Error(`${definition.name} has no update action`);
      }
      const { id: _id, ...body } = args;
      // The browser agent may target a row that is not currently materialized
      // in this collection instance. Hydrate the shared cache before asking the
      // collection engine to apply its optimistic update.
      await collection.preload();
      const row = unwrapItemResult(
        await settleTransaction(
          collection.update(requireId(args, 'update'), body),
          collection,
          requireId(args, 'update'),
          body,
        ),
        `update(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'delete': {
      if (!fetchers.delete) {
        throw new Error(`${definition.name} has no delete action`);
      }
      const id = requireId(args, 'delete');
      // Delete requires the engine to know the current row so its optimistic
      // transaction can roll back if the REST request fails.
      await collection.preload();
      await settleTransaction(collection.delete(id), collection, id, {});
      return JSON.stringify({ success: true, id });
    }

    default:
      if (!fetchers.custom) {
        throw new Error(`${definition.name} has no custom action fetcher`);
      }
      return JSON.stringify(await collection.action(action, args, route));
  }
}

/** Await the shared collection mutation lifecycle and return its server value. */
async function settleTransaction(
  transaction: SmrtWebTransaction,
  collection: SmrtWebCollection<Record<string, unknown>>,
  key: string,
  fallback: Record<string, unknown>,
): Promise<unknown> {
  const result = await transaction.isPersisted.promise;
  if (result !== undefined && result !== null) {
    // TanStack's transaction promise resolves with its internal collection
    // object, which is intentionally opaque and circular. Never leak that
    // engine value into WebMCP's JSON string contract.
    try {
      JSON.stringify(result);
      return result;
    } catch {
      // Fall through to the plain row/fallback below.
    }
  }
  return collection.get(key) ?? { ...fallback, id: key };
}
