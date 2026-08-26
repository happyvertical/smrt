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
  type SmrtWebTransaction,
  throwIfSmrtWebError,
  unwrapItemResult,
  unwrapListResult,
  validateSmrtWebClient,
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
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    untrustedContentHint?: boolean;
  };
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

export type WebMcpToolEffect = 'read' | 'write' | 'destructive';

export interface WebMcpExposurePolicy {
  /** Allowed effects. Omitted means read-only exposure. */
  effects?: readonly WebMcpToolEffect[];
  /** Prefix every registered tool name with `<namespace>_`. */
  namespace?: string;
  /** Optional maximum tools registered by one call. */
  maxTools?: number;
}

export interface RegisterWebMcpToolsOptions extends WebMcpExposurePolicy {
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
  /** Predicate for canonical per-tool definitions. */
  filterTool?: (definition: WebMcpToolDefinition) => boolean;
}

/** Accepted legacy collection definitions and canonical per-tool definitions. */
export type WebMcpRegistrationDefinition =
  | SmrtWebCollectionDefinition
  | WebMcpToolDefinition;

interface ProspectiveLegacyTool {
  kind: 'legacy';
  definition: SmrtWebCollectionDefinition;
  descriptor: WebToolDescriptor;
  name: string;
  identity: string;
  effect: WebMcpToolEffect;
  idempotent: boolean;
  openWorld: boolean;
}

interface ProspectiveCanonicalTool {
  kind: 'canonical';
  definition: WebMcpToolDefinition;
  descriptor: WebMcpToolDefinition;
  name: string;
  identity: string;
  effect: WebMcpToolEffect;
  idempotent: boolean;
  openWorld: boolean;
}

type ProspectiveTool = ProspectiveLegacyTool | ProspectiveCanonicalTool;
type ToolSemantics = Pick<
  ProspectiveTool,
  'effect' | 'idempotent' | 'openWorld'
>;

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
  const client = options.client;
  // Selection, filtering, duplicate detection, and budget validation happen
  // before any browser registration or collection allocation. A bad policy or
  // definition set therefore has no partial capability exposure.
  const { tools, allowedEffects } = selectProspectiveTools(
    definitions,
    options,
  );
  if (
    client &&
    tools.some((tool) => tool.kind === 'canonical' && tool.effect !== 'read')
  ) {
    validateSmrtWebClient(client);
  }
  // ONE controller deregisters every tool this call registers: WebMCP removes a
  // tool when the signal it was registered with aborts, so the returned disposer
  // simply aborts. Idempotent — a second call is a harmless no-op.
  const controller = new AbortController();
  const collections = new Map<
    SmrtWebCollectionDefinition,
    SmrtWebCollection<Record<string, unknown>>
  >();
  const collectionFetchers = new Map<
    SmrtWebCollectionDefinition,
    SmrtCrudFetchers
  >();
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
    for (const tool of tools) {
      if (tool.kind === 'legacy') {
        const { definition, descriptor } = tool;
        let fetchers = collectionFetchers.get(definition);
        let collection = collections.get(definition);
        if (!fetchers || !collection) {
          fetchers = options.resolveFetchers
            ? options.resolveFetchers(snapshotLegacyDefinition(definition))
            : createDefinitionFetchers(definition, basePath, options.fetchFn);
          collection = createSmrtCollection(definition, {
            fetchers,
            basePath,
            fetchFn: options.fetchFn,
            ...(client ? { client } : {}),
            ...(options.scope ? { scope: options.scope } : {}),
          }) as SmrtWebCollection<Record<string, unknown>>;
          collectionFetchers.set(definition, fetchers);
          collections.set(definition, collection);
        }
        ctx.registerTool(
          {
            name: tool.name,
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,
            annotations: annotationsFor(tool),
            execute: guardedExecute(
              tool,
              allowedEffects,
              () => disposed,
              (args) =>
                dispatchCollection(
                  fetchers,
                  collection,
                  definition,
                  descriptor.action,
                  descriptor.route,
                  args,
                ),
            ),
          },
          { signal: controller.signal },
        );
        continue;
      }
      const { definition } = tool;
      const fetchers = options.resolveToolFetchers
        ? options.resolveToolFetchers(
            snapshotCanonicalDefinition(definition, tool),
          )
        : createDefinitionFetchers(
            { name: definition.collection, endpoint: definition.endpoint },
            basePath,
            options.fetchFn,
          );
      ctx.registerTool(
        {
          name: tool.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
          annotations: annotationsFor(tool),
          execute: guardedExecute(
            tool,
            allowedEffects,
            () => disposed,
            (args) => dispatchDirect(fetchers, definition, args, client),
          ),
        },
        { signal: controller.signal },
      );
    }
  } catch (error) {
    // Abort removes every tool registered with this call. Collection cleanup is
    // best-effort async but all handles are detached synchronously first.
    dispose();
    throw error;
  }

  return dispose;
}

const VALID_EFFECTS: readonly WebMcpToolEffect[] = [
  'read',
  'write',
  'destructive',
];
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function selectProspectiveTools(
  definitions: readonly WebMcpRegistrationDefinition[],
  options: RegisterWebMcpToolsOptions,
): {
  tools: ProspectiveTool[];
  allowedEffects: ReadonlySet<WebMcpToolEffect>;
} {
  const effects = options.effects ?? ['read'];
  for (const effect of effects) {
    if (!VALID_EFFECTS.includes(effect)) {
      throw new Error(`Invalid WebMCP effect: ${String(effect)}`);
    }
  }
  const allowedEffects = new Set(effects);
  const maxTools = options.maxTools;
  if (
    maxTools !== undefined &&
    (!Number.isSafeInteger(maxTools) || maxTools < 0)
  ) {
    throw new Error('WebMCP maxTools must be a non-negative safe integer');
  }
  const namespace = options.namespace;
  if (namespace !== undefined && !NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      'WebMCP namespace must start with an alphanumeric character and contain only letters, numbers, underscores, or hyphens',
    );
  }

  // Snapshot the complete input graph before invoking any host callback. A
  // filter for an earlier tool may close over and mutate a later caller-owned
  // definition; lazy per-definition snapshots would let that mutation cross
  // the policy boundary before the later tool is classified.
  const stableDefinitions = definitions.map((definition) =>
    snapshotValue(definition),
  );
  const tools: ProspectiveTool[] = [];
  for (const definition of stableDefinitions) {
    if (isCanonicalToolDefinition(definition)) {
      const semantics = actionSemantics(definition.action, definition);
      if (!allowedEffects.has(semantics.effect)) continue;
      if (options.filter && !options.filterTool) {
        throw new Error(
          '[smrt-web] canonical WebMCP definitions require filterTool when filter is configured',
        );
      }
      const stableDefinition = snapshotCanonicalDefinition(
        definition,
        semantics,
      );
      if (
        options.filterTool &&
        !options.filterTool(
          snapshotCanonicalDefinition(stableDefinition, semantics),
        )
      ) {
        continue;
      }
      tools.push({
        kind: 'canonical',
        definition: stableDefinition,
        descriptor: stableDefinition,
        name: qualifiedToolName(stableDefinition.name, namespace),
        identity: `${stableDefinition.collection}#${stableDefinition.action}`,
        ...semantics,
      });
      continue;
    }

    const stableDefinition = snapshotLegacyDefinition(definition);
    for (const descriptor of stableDefinition.toolDescriptors ?? []) {
      if (!stableDefinition.actions.includes(descriptor.action)) {
        throw new Error(
          `WebMCP tool ${descriptor.name} exposes action ${descriptor.action} outside ${stableDefinition.name}'s allowed actions`,
        );
      }
      const semantics = actionSemantics(descriptor.action, descriptor);
      if (!allowedEffects.has(semantics.effect)) continue;
      const stableDescriptor = snapshotLegacyDescriptor(descriptor, semantics);
      if (
        options.filter &&
        !options.filter(
          snapshotLegacyDefinition(stableDefinition),
          snapshotLegacyDescriptor(stableDescriptor, semantics),
        )
      ) {
        continue;
      }
      tools.push({
        kind: 'legacy',
        definition: stableDefinition,
        descriptor: stableDescriptor,
        name: qualifiedToolName(stableDescriptor.name, namespace),
        identity: `${stableDefinition.name}#${stableDescriptor.action}`,
        ...semantics,
      });
    }
  }

  validateProspectiveTools(tools, maxTools);
  return { tools, allowedEffects };
}

function qualifiedToolName(name: string, namespace?: string): string {
  return namespace ? `${namespace}_${name}` : name;
}

function actionSemantics(
  action: string,
  declared: Partial<
    Pick<WebMcpToolDefinition, 'effect' | 'idempotent' | 'openWorld'>
  >,
): ToolSemantics {
  switch (action) {
    case 'list':
    case 'get':
      return { effect: 'read', idempotent: true, openWorld: false };
    case 'create':
      return { effect: 'write', idempotent: false, openWorld: false };
    case 'update':
      return { effect: 'write', idempotent: true, openWorld: false };
    case 'delete':
      return { effect: 'destructive', idempotent: true, openWorld: false };
    default:
      return {
        effect: VALID_EFFECTS.includes(declared.effect as WebMcpToolEffect)
          ? (declared.effect as WebMcpToolEffect)
          : 'destructive',
        idempotent: declared.idempotent ?? false,
        openWorld: declared.openWorld ?? true,
      };
  }
}

function snapshotRoute(
  route: WebToolDescriptor['route'],
): WebToolDescriptor['route'] {
  return route ? snapshotValue(route) : undefined;
}

function snapshotValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => snapshotValue(entry)) as T;
  }
  if (value && typeof value === 'object') {
    const snapshot: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      snapshot[key] = snapshotValue(entry);
    }
    return snapshot as T;
  }
  return value;
}

function snapshotLegacyDescriptor(
  descriptor: WebToolDescriptor,
  semantics: ToolSemantics,
): WebToolDescriptor {
  return snapshotValue({
    ...descriptor,
    ...semantics,
    readOnly: semantics.effect === 'read',
    route: snapshotRoute(descriptor.route),
  });
}

function snapshotLegacyDefinition(
  definition: SmrtWebCollectionDefinition,
): SmrtWebCollectionDefinition {
  const snapshot = snapshotValue({
    ...definition,
    actions: [...definition.actions],
  });
  snapshot.toolDescriptors = snapshot.toolDescriptors?.map((descriptor) =>
    snapshotLegacyDescriptor(
      descriptor,
      actionSemantics(descriptor.action, descriptor),
    ),
  );
  return snapshot;
}

function snapshotCanonicalDefinition(
  definition: WebMcpToolDefinition,
  semantics: ToolSemantics,
): WebMcpToolDefinition {
  return snapshotValue({
    ...definition,
    ...semantics,
    readOnly: semantics.effect === 'read',
    route: snapshotRoute(definition.route) as WebMcpToolDefinition['route'],
  });
}

function validateProspectiveTools(
  tools: readonly ProspectiveTool[],
  maxTools?: number,
): void {
  if (maxTools !== undefined && tools.length > maxTools) {
    throw new Error(
      `WebMCP tool budget exceeded: ${tools.length} tools selected, maximum is ${maxTools}`,
    );
  }
  const names = new Set<string>();
  const identities = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Duplicate WebMCP tool name: ${tool.name}`);
    }
    names.add(tool.name);
    if (identities.has(tool.identity)) {
      throw new Error(`Duplicate WebMCP tool identity: ${tool.identity}`);
    }
    identities.add(tool.identity);
  }
}

function annotationsFor(
  tool: ProspectiveTool,
): NonNullable<WebMcpToolRegistration['annotations']> {
  return {
    readOnlyHint: tool.effect === 'read',
    destructiveHint: tool.effect === 'destructive',
    idempotentHint: tool.idempotent,
    openWorldHint: tool.openWorld,
    untrustedContentHint: true,
  };
}

function guardedExecute(
  tool: ProspectiveTool,
  allowedEffects: ReadonlySet<WebMcpToolEffect>,
  isDisposed: () => boolean,
  execute: (args: Record<string, unknown>) => Promise<string> | string,
): WebMcpToolRegistration['execute'] {
  return (args) => {
    if (isDisposed()) {
      throw new Error(`WebMCP tool ${tool.name} is no longer registered`);
    }
    if (!allowedEffects.has(tool.effect)) {
      throw new Error(
        `WebMCP policy no longer allows ${tool.effect} tool ${tool.name}`,
      );
    }
    return execute(args ?? {});
  };
}

function isCanonicalToolDefinition(
  definition: WebMcpRegistrationDefinition,
): definition is WebMcpToolDefinition {
  return 'collection' in definition && 'readOnly' in definition;
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
      throwIfSmrtWebError(deleteResult, `delete(${definition.collection})`);
      result = { success: true, id };
      break;
    }
    default:
      if (!fetchers.custom) {
        throw new Error(
          `${definition.collection} has no custom action fetcher`,
        );
      }
      result = throwIfSmrtWebError(
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
