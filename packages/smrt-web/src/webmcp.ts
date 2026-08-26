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
 * is a browser global, not a dependency. Legacy list-backed mutations use the
 * same optimistic path as page code through `createSmrtCollection`; canonical
 * tool-only definitions execute through REST fetchers and invalidate any
 * materialized sibling caches through the host's shared `SmrtWebClient`.
 */

import {
  createDefinitionFetchers,
  createSmrtCollection,
  invalidateSmrtWebCollections,
  newLocalId,
  type SmrtCrudFetchers,
  type SmrtWebClient,
  type SmrtWebCollection,
  type SmrtWebCollectionDefinition,
  SmrtWebRequestError,
  type SmrtWebTransaction,
  unwrapItemResult,
  unwrapListResult,
  type WebMcpToolDefinition,
  type WebToolDescriptor,
} from './index.js';
import {
  mutationTargetHydrators,
  persistedMutationResults,
} from './internal.js';

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
  /**
   * Override direct REST fetchers for a canonical tool-only definition.
   * Fetchers are optional because a get-only or custom-action-only model does
   * not have a list or create route.
   */
  resolveToolFetchers?: (
    definition: WebMcpToolDefinition,
  ) => Partial<SmrtCrudFetchers>;
  /** Predicate to include/exclude individual tools (e.g. reads-only surfaces). */
  filter?: (
    definition: SmrtWebCollectionDefinition,
    descriptor: NonNullable<
      SmrtWebCollectionDefinition['toolDescriptors']
    >[number],
  ) => boolean;
}

/** Accepted legacy collection definitions and canonical per-tool definitions. */
export type WebMcpRegistrationDefinition =
  | SmrtWebCollectionDefinition
  | WebMcpToolDefinition;

/**
 * Register every collection's generated tool descriptors with WebMCP.
 *
 * @returns a disposer that deregisters all tools this call registered. On a
 * browser without WebMCP the call is a no-op and the disposer is inert.
 */
export function registerWebMcpTools(
  definitions: readonly WebMcpRegistrationDefinition[],
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
  const registeredNames = new Set<string>();
  const directFetchers = new Map<string, Partial<SmrtCrudFetchers>>();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    for (const collection of collections.values()) {
      // Disposal is intentionally synchronous for WebMCP callers, but cleanup
      // is async because the underlying cache may close durable resources.
      // Consume a rejection so a failed engine teardown cannot become an
      // unhandled promise rejection in the host page.
      void collection.cleanup().catch(() => undefined);
    }
  };

  try {
    // Prefer legacy collection-backed definitions regardless of input order.
    // Their optimistic mutation and cache behavior is the established path;
    // canonical entries for the same tool name are duplicate transport data.
    for (const definition of definitions) {
      if (isCanonicalToolDefinition(definition)) continue;
      const descriptors = (definition.toolDescriptors ?? []).filter(
        (descriptor) =>
          !registeredNames.has(descriptor.name) &&
          (!options.filter || options.filter(definition, descriptor)),
      );
      if (descriptors.length === 0) continue;

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
        ctx.registerTool(
          {
            name: descriptor.name,
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,
            annotations: { readOnlyHint: descriptor.readOnly },
            execute: (args) =>
              dispatchCollection(
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
        registeredNames.add(descriptor.name);
      }
    }

    for (const definition of definitions) {
      if (!isCanonicalToolDefinition(definition)) continue;
      if (registeredNames.has(definition.name)) continue;
      const filterDefinition = collectionViewOfTool(definition);
      if (options.filter && !options.filter(filterDefinition, definition)) {
        continue;
      }
      let fetchers = directFetchers.get(definition.collection);
      if (!fetchers) {
        fetchers = options.resolveToolFetchers
          ? options.resolveToolFetchers(definition)
          : createDefinitionFetchers(
              { name: definition.collection, endpoint: definition.endpoint },
              basePath,
              options.fetchFn,
            );
        directFetchers.set(definition.collection, fetchers);
      }
      ctx.registerTool(
        {
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: { readOnlyHint: definition.readOnly },
          execute: (args) =>
            dispatchDirect(fetchers, definition, args ?? {}, options.client),
        },
        { signal: controller.signal },
      );
      registeredNames.add(definition.name);
    }
  } catch (error) {
    // Abort removes every tool registered with this call. Collection cleanup is
    // best-effort async but all handles are detached synchronously first.
    dispose();
    throw error;
  }

  return dispose;
}

function isCanonicalToolDefinition(
  definition: WebMcpRegistrationDefinition,
): definition is WebMcpToolDefinition {
  return 'collection' in definition && 'readOnly' in definition;
}

/** Preserve the legacy filter callback while canonical definitions are additive. */
function collectionViewOfTool(
  definition: WebMcpToolDefinition,
): SmrtWebCollectionDefinition {
  return {
    name: definition.collection,
    objectRef: definition.objectRef,
    className: definition.className,
    endpoint: definition.endpoint,
    idField: definition.idField,
    actions: [definition.action],
    toolDescriptors: [definition],
    fields: {},
    relationships: definition.relationships,
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
async function dispatchCollection(
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
      await hydrateMutationTarget(
        fetchers,
        collection,
        definition,
        requireId(args, 'update'),
      );
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
      await hydrateMutationTarget(fetchers, collection, definition, id);
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

/** Execute a canonical definition without constructing a client collection. */
async function dispatchDirect(
  fetchers: Partial<SmrtCrudFetchers>,
  definition: WebMcpToolDefinition,
  args: Record<string, unknown>,
  client?: SmrtWebClient,
): Promise<string> {
  let result: unknown;
  switch (definition.action) {
    case 'list':
      if (!fetchers.list) {
        throw new Error(`${definition.collection} has no list action`);
      }
      result = unwrapListResult(
        await fetchers.list(listParams(args)),
        definition.collection,
      );
      break;
    case 'get':
      if (!fetchers.get) {
        throw new Error(`${definition.collection} has no get action`);
      }
      result = unwrapItemResult(
        await fetchers.get(requireIdentifier(args)),
        `get(${definition.collection})`,
      );
      break;
    case 'create':
      if (!fetchers.create) {
        throw new Error(`${definition.collection} has no create action`);
      }
      result = unwrapItemResult(
        await fetchers.create(args),
        `create(${definition.collection})`,
      );
      break;
    case 'update': {
      if (!fetchers.update) {
        throw new Error(`${definition.collection} has no update action`);
      }
      const id = requireId(args, 'update');
      const { id: _id, ...body } = args;
      result = unwrapItemResult(
        await fetchers.update(id, body),
        `update(${definition.collection})`,
      );
      break;
    }
    case 'delete': {
      if (!fetchers.delete) {
        throw new Error(`${definition.collection} has no delete action`);
      }
      const id = requireId(args, 'delete');
      const deleteResult = await fetchers.delete(id);
      throwIfToolError(deleteResult, `delete(${definition.collection})`);
      result = { success: true, id };
      break;
    }
    default:
      if (!fetchers.custom) {
        throw new Error(
          `${definition.collection} has no custom action fetcher`,
        );
      }
      result = throwIfToolError(
        await fetchers.custom(definition.action, args, definition.route),
        `${definition.action}(${definition.collection})`,
      );
  }

  if (!definition.readOnly && client) {
    invalidateSmrtWebCollections(client, [
      definition.collection,
      ...definition.relationships.map(
        (relationship) => relationship.relatedCollection,
      ),
    ]);
  }
  return JSON.stringify(result);
}

/** Reject the `{ error: string }` envelope without rewriting successful data. */
function throwIfToolError(result: unknown, context: string): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const error = (result as Record<string, unknown>).error;
    if (typeof error === 'string') {
      throw new SmrtWebRequestError(
        `[smrt-web] ${context} failed: ${error}`,
        result,
      );
    }
  }
  return result;
}

/** Await the shared collection mutation lifecycle and return its server value. */
async function settleTransaction(
  transaction: SmrtWebTransaction,
  collection: SmrtWebCollection<Record<string, unknown>>,
  key: string,
  fallback: Record<string, unknown>,
): Promise<unknown> {
  await transaction.isPersisted.promise;
  const persisted = persistedMutationResults
    .get(collection as object)
    ?.get(key);
  if (persisted !== undefined) return persisted;
  return collection.get(key) ?? { ...fallback, id: key };
}

/**
 * Fetch and materialize a mutation target before asking TanStack DB to apply
 * its optimistic operation. `preload()` only covers the collection's bounded
 * first page; the keyed fetch is what makes arbitrary IDs reliable.
 */
async function hydrateMutationTarget(
  fetchers: SmrtCrudFetchers,
  collection: SmrtWebCollection<Record<string, unknown>>,
  definition: SmrtWebCollectionDefinition,
  id: string,
): Promise<void> {
  if (!fetchers.get) {
    throw new Error(
      `${definition.name} has no get action; cannot hydrate mutation target '${id}'`,
    );
  }
  const row = unwrapItemResult(
    await fetchers.get(id),
    `get(${definition.name})`,
  ) as Record<string, unknown>;
  const hydrate = mutationTargetHydrators.get(collection as object);
  if (!hydrate) {
    throw new Error(
      `${definition.name} cannot hydrate mutation target '${id}'`,
    );
  }
  await hydrate(row);
}
