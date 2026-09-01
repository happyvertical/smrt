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
  ) => void | Promise<void>;
}

/** Disposes a registration and exposes completion of browser registration. */
export interface WebMcpRegistrationDisposer {
  (): void;
  /** Rejects if the browser rejects any tool; all sibling tools are aborted. */
  readonly ready: Promise<void>;
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

/**
 * A hand-written browser tool from application code — not generated from a
 * `@smrt()` model. Structurally identical to the WebMCP `registerTool` input;
 * kept as a separate type so this framework-agnostic module never depends on
 * a UI layer's tool-spec type.
 */
export interface WebMcpBespokeToolSpec {
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
  execute: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface RegisterWebMcpBespokeToolOptions {
  /**
   * Allowed effects. Omitted means read-only exposure — the same default as
   * {@link registerWebMcpTools}. `namespace` and `maxTools` deliberately do
   * not apply to a bespoke tool (#2586): a component author already chose a
   * stable name, and counting one intent against a shared budget could make
   * an unrelated generated tool set fail to register.
   */
  effects?: readonly WebMcpToolEffect[];
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
  destructive: boolean;
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
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

type ProspectiveTool = ProspectiveLegacyTool | ProspectiveCanonicalTool;
type ToolSemantics = Pick<
  ProspectiveTool,
  'effect' | 'destructive' | 'idempotent' | 'openWorld'
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
): WebMcpRegistrationDisposer {
  const exposure = validateExposurePolicy(options);
  const ctx = getModelContext();
  if (!ctx) return registrationDisposer(() => {}, Promise.resolve());

  const basePath = options.basePath ?? '/api/v1';
  const client = options.client;
  // Selection, filtering, duplicate detection, and budget validation happen
  // before any browser registration or collection allocation. A bad policy or
  // definition set therefore has no partial capability exposure.
  const { tools, allowedEffects } = selectProspectiveTools(
    definitions,
    options,
    exposure,
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
  const registrations: Promise<void>[] = [];

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
        registrations.push(
          Promise.resolve(
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
            ),
          ),
        );
        continue;
      }
      const { definition } = tool;
      const fetchers = options.resolveToolFetchers
        ? options.resolveToolFetchers(
            snapshotCanonicalDefinition(definition, {
              effect: tool.effect,
              destructive: tool.destructive,
              idempotent: tool.idempotent,
              openWorld: tool.openWorld,
            }),
          )
        : createDefinitionFetchers(
            { name: definition.collection, endpoint: definition.endpoint },
            basePath,
            options.fetchFn,
          );
      registrations.push(
        Promise.resolve(
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
          ),
        ),
      );
    }
  } catch (error) {
    // Abort removes every tool registered with this call. Collection cleanup is
    // best-effort async but all handles are detached synchronously first. An
    // earlier browser promise may still reject after this synchronous failure;
    // observe every started registration before returning control to the host.
    void Promise.all(registrations).catch(() => undefined);
    dispose();
    throw error;
  }

  const ready = Promise.all(registrations)
    .then(() => undefined)
    .catch((error: unknown) => {
      dispose();
      throw error;
    });
  // Direct callers may only need the synchronous disposer. Mark the browser
  // rejection as observed while preserving `ready`'s rejection for callers
  // that need to report registration failures.
  void ready.catch(() => undefined);
  return registrationDisposer(dispose, ready);
}

function registrationDisposer(
  dispose: () => void,
  ready: Promise<void>,
): WebMcpRegistrationDisposer {
  return Object.assign(dispose, { ready });
}

/**
 * Register one hand-written browser tool through the same fail-closed effect
 * classification and `effects` exposure policy as {@link registerWebMcpTools}
 * (#2586). A tool with no `annotations`, or with annotations that leave its
 * effect undeclared, classifies destructive/non-idempotent/open-world — the
 * same default `actionSemantics` gives an undeclared custom model action —
 * and is excluded unless the policy allows `destructive`. `namespace` and
 * `maxTools` are out of scope for a bespoke tool; see
 * {@link RegisterWebMcpBespokeToolOptions}.
 *
 * @returns a disposer that deregisters the tool this call registered (a
 * no-op double-call). On a browser without WebMCP, or when policy excludes
 * the tool's effect, the call is a no-op and the disposer is inert.
 */
export function registerWebMcpBespokeTool(
  spec: WebMcpBespokeToolSpec,
  options: RegisterWebMcpBespokeToolOptions = {},
): WebMcpRegistrationDisposer {
  const { allowedEffects } = validateExposurePolicy(options);
  const ctx = getModelContext();
  if (!ctx) return registrationDisposer(() => {}, Promise.resolve());

  const semantics = actionSemantics(
    'bespoke',
    bespokeDeclaredSemantics(spec.annotations),
  );
  if (!allowedEffects.has(semantics.effect)) {
    return registrationDisposer(() => {}, Promise.resolve());
  }

  const controller = new AbortController();
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    controller.abort();
  };

  let registration: void | Promise<void>;
  try {
    registration = ctx.registerTool(
      {
        name: spec.name,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: annotationsFor(semantics),
        execute: guardedExecute(
          { name: spec.name, effect: semantics.effect },
          allowedEffects,
          () => disposed,
          spec.execute,
        ),
      },
      { signal: controller.signal },
    );
  } catch (error) {
    dispose();
    throw error;
  }

  const ready = Promise.resolve(registration).catch((error: unknown) => {
    dispose();
    throw error;
  });
  // Callers may only need the synchronous disposer; keep `ready`'s rejection
  // observable for callers that report registration failures without
  // producing an unhandled rejection when nobody awaits it.
  void ready.catch(() => undefined);
  return registrationDisposer(dispose, ready);
}

const VALID_EFFECTS: readonly WebMcpToolEffect[] = [
  'read',
  'write',
  'destructive',
];
const NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface ValidatedExposurePolicy {
  allowedEffects: ReadonlySet<WebMcpToolEffect>;
  maxTools?: number;
  namespace?: string;
}

function validateExposurePolicy(
  options: WebMcpExposurePolicy,
): ValidatedExposurePolicy {
  const effects = options.effects ?? ['read'];
  for (const effect of effects) {
    if (!VALID_EFFECTS.includes(effect)) {
      throw new Error(`Invalid WebMCP effect: ${String(effect)}`);
    }
  }
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
  return {
    allowedEffects: new Set(effects),
    ...(maxTools !== undefined ? { maxTools } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
  };
}

function selectProspectiveTools(
  definitions: readonly WebMcpRegistrationDefinition[],
  options: RegisterWebMcpToolsOptions,
  exposure: ValidatedExposurePolicy,
): {
  tools: ProspectiveTool[];
  allowedEffects: ReadonlySet<WebMcpToolEffect>;
} {
  const { allowedEffects, maxTools, namespace } = exposure;

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
      if (options.filterTool && !options.filter) {
        throw new Error(
          '[smrt-web] legacy WebMCP definitions require filter when filterTool is configured',
        );
      }
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
      return {
        effect: 'read',
        destructive: false,
        idempotent: true,
        openWorld: false,
      };
    case 'create':
      return {
        effect: 'write',
        // SMRT create routes are natural-key upserts, so they may replace an
        // existing row and cannot claim the MCP additive-only guarantee.
        destructive: true,
        idempotent: false,
        openWorld: false,
      };
    case 'update':
      return {
        effect: 'write',
        destructive: true,
        idempotent: true,
        openWorld: false,
      };
    case 'delete':
      return {
        effect: 'destructive',
        destructive: true,
        idempotent: true,
        openWorld: false,
      };
    default: {
      const effect = VALID_EFFECTS.includes(declared.effect as WebMcpToolEffect)
        ? (declared.effect as WebMcpToolEffect)
        : 'destructive';
      return {
        effect,
        destructive: effect !== 'read',
        idempotent: declared.idempotent ?? false,
        openWorld: declared.openWorld ?? true,
      };
    }
  }
}

/**
 * Translate a bespoke tool's optional MCP-shaped `annotations` into the
 * `declared` input `actionSemantics` already accepts for an undeclared
 * custom model action, so both paths share one fail-closed default. Checks
 * run in this fixed order, and `destructiveHint: true` always wins even when
 * `readOnlyHint: true` is also present — a contradictory pair (an author
 * error, or an attempted downgrade) must fail closed to `destructive`
 * rather than being read through as `read`:
 *
 *   1. `destructiveHint === true` -> `destructive`, regardless of `readOnlyHint`.
 *   2. otherwise `readOnlyHint === true` -> `read`.
 *   3. otherwise `destructiveHint === false` -> the `write` effect BUCKET
 *      used for exposure-policy filtering — a write tool still requires an
 *      explicit `effects` opt-in separate from `read`.
 *   4. Anything else — no annotations, or both hints left undeclared —
 *      resolves through `actionSemantics`'s own default to destructive,
 *      non-idempotent, open-world.
 *
 * The re-emitted `destructiveHint` annotation does not simply echo the
 * caller's input: `actionSemantics`'s default branch sets
 * `destructive: effect !== 'read'` for every non-read custom action, bespoke
 * or generated, so a `write`-bucket bespoke tool is still re-emitted with
 * `destructiveHint: true` even when the caller declared `false` — identical
 * to how a generated custom action declared `effect: 'write'` is annotated.
 * `destructiveHint: false` only ever selects the `write` bucket here; it
 * never survives into the annotation sent to `document.modelContext`.
 */
function bespokeDeclaredSemantics(
  annotations: WebMcpBespokeToolSpec['annotations'],
): Partial<Pick<WebMcpToolDefinition, 'effect' | 'idempotent' | 'openWorld'>> {
  if (!annotations) return {};
  const effect: WebMcpToolEffect | undefined =
    annotations.destructiveHint === true
      ? 'destructive'
      : annotations.readOnlyHint === true
        ? 'read'
        : annotations.destructiveHint === false
          ? 'write'
          : undefined;
  return {
    ...(effect ? { effect } : {}),
    ...(annotations.idempotentHint !== undefined
      ? { idempotent: annotations.idempotentHint }
      : {}),
    ...(annotations.openWorldHint !== undefined
      ? { openWorld: annotations.openWorldHint }
      : {}),
  };
}

function snapshotRoute(
  route: WebToolDescriptor['route'],
): WebToolDescriptor['route'] {
  return route ? snapshotValue(route) : undefined;
}

function snapshotValue<T>(
  value: T,
  active = new WeakSet<object>(),
  path = '$',
): T {
  if (value && typeof value === 'object') {
    if (active.has(value)) {
      throw new Error(
        `[smrt-web] WebMCP definitions must be acyclic (cycle at ${path})`,
      );
    }
    active.add(value);
  }

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        snapshotValue(entry, active, `${path}[${index}]`),
      ) as T;
    }
    if (value && typeof value === 'object') {
      const snapshot: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        snapshot[key] = snapshotValue(entry, active, `${path}.${key}`);
      }
      return snapshot as T;
    }
    return value;
  } finally {
    if (value && typeof value === 'object') active.delete(value);
  }
}

function snapshotLegacyDescriptor(
  descriptor: WebToolDescriptor,
  semantics: ToolSemantics,
): WebToolDescriptor {
  return snapshotValue({
    ...descriptor,
    effect: semantics.effect,
    idempotent: semantics.idempotent,
    openWorld: semantics.openWorld,
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
    effect: semantics.effect,
    idempotent: semantics.idempotent,
    openWorld: semantics.openWorld,
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
  tool: ToolSemantics,
): NonNullable<WebMcpToolRegistration['annotations']> {
  return {
    readOnlyHint: tool.effect === 'read',
    destructiveHint: tool.destructive,
    idempotentHint: tool.idempotent,
    openWorldHint: tool.openWorld,
    untrustedContentHint: true,
  };
}

function guardedExecute(
  tool: Pick<ProspectiveTool, 'name' | 'effect'>,
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
