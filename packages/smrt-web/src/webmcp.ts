/**
 * WebMCP browser tool registration (#1812, tracer).
 *
 * Registers each collection's generated {@link WebToolDescriptor}s with the
 * browser's WebMCP registry (`document.modelContext.registerTool`) so an
 * in-page AI agent can discover and invoke them — see
 * https://developer.chrome.com/docs/ai/webmcp. Each tool's `execute` runs
 * through the collection's REST fetchers AS THE PAGE'S AUTHENTICATED USER, so
 * the generated REST guards (auth, tenant gate #1554, writable + sensitive-field
 * policy #1540) are the security boundary — nothing is re-implemented here.
 *
 * Framework-agnostic and engine-free: this module imports no UI framework and no
 * client-data engine. `document.modelContext` is a browser global, not a
 * dependency. Reads/writes go through {@link createDefinitionFetchers} (plain
 * fetch), so registering tools never drags the TanStack engine onto a page.
 *
 * TRACER SCOPE: CRUD actions (list/get/create/update/delete) are fully wired;
 * custom actions return a clear "not wired" payload. The full slice can route
 * `execute` through the shared-client collection instead of raw fetchers so
 * agent mutations reflect in on-page live collections (cache coherence).
 */

import {
  createDefinitionFetchers,
  type SmrtCrudFetchers,
  type SmrtWebCollectionDefinition,
  unwrapItemResult,
  unwrapListResult,
} from './index.js';

/** The subset of Chrome's WebMCP `registerTool` input this tracer emits. */
interface WebMcpToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (args: Record<string, unknown>) => Promise<string> | string;
}

/** What `registerTool` returns — a handle we can later `unregister()`. */
interface RegisteredToolHandle {
  unregister?: () => void;
}

/** The slice of `document.modelContext` this module depends on. */
interface ModelContextLike {
  registerTool: (
    tool: WebMcpToolRegistration,
  ) => RegisteredToolHandle | undefined;
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
  const disposers: Array<() => void> = [];

  for (const definition of definitions) {
    const descriptors = definition.toolDescriptors;
    if (!descriptors || descriptors.length === 0) continue;

    const fetchers = options.resolveFetchers
      ? options.resolveFetchers(definition)
      : createDefinitionFetchers(definition, basePath, options.fetchFn);

    for (const descriptor of descriptors) {
      if (options.filter && !options.filter(definition, descriptor)) continue;

      const handle = ctx.registerTool({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: { readOnlyHint: descriptor.readOnly },
        execute: (args) =>
          dispatch(fetchers, definition, descriptor.action, args ?? {}),
      });

      if (handle && typeof handle.unregister === 'function') {
        const unregister = handle.unregister.bind(handle);
        disposers.push(unregister);
      }
    }
  }

  return () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      dispose?.();
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
  definition: SmrtWebCollectionDefinition,
  action: string,
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
        await fetchers.get(requireId(args, 'get')),
        `get(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'create': {
      const row = unwrapItemResult(
        await fetchers.create(args),
        `create(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'update': {
      if (!fetchers.update) {
        throw new Error(`${definition.name} has no update action`);
      }
      const { id: _id, ...body } = args;
      const row = unwrapItemResult(
        await fetchers.update(requireId(args, 'update'), body),
        `update(${definition.name})`,
      );
      return JSON.stringify(row);
    }

    case 'delete': {
      if (!fetchers.delete) {
        throw new Error(`${definition.name} has no delete action`);
      }
      await fetchers.delete(requireId(args, 'delete'));
      return JSON.stringify({ success: true });
    }

    default:
      // Custom actions (e.g. invoice_record_payment) hit bespoke REST routes not
      // covered by the CRUD fetchers. Wired in the full slice (#1812).
      return JSON.stringify({
        error: `WebMCP custom action '${action}' is not wired in the tracer`,
        action,
        collection: definition.name,
      });
  }
}
