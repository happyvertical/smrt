/**
 * Canonical custom-action metadata and transport-safe result helpers.
 *
 * Custom actions are intentionally distinct from generated CRUD. Their target
 * is derived from method metadata: instance methods target an item and static
 * methods target the collection. API route configuration may shape an HTTP
 * route, but it cannot change a method's receiver.
 */

import type { ApiHttpMethod, ToolEffect } from '../registry/types.js';
import type {
  MethodDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { convertTypeToJsonSchema } from '../tools/tool-generator.js';

export type CustomActionScope = 'item' | 'collection';
export type { ToolEffect } from '../registry/types.js';

/**
 * Public method names declared directly on `SmrtObject`/`SmrtClass`
 * (`src/object.ts`, `src/class.ts`) that form the constructor → `initialize()`
 * → `save()`/`delete()`/`loadFromId()` lifecycle and its immediate supporting
 * mechanism: identity/persistence bookkeeping, transaction binding, and
 * serialization. `save()` is what generated `create`/`update` call;
 * `initialize()` is what `get`/`list` hydration calls; `loadFromId()`/
 * `loadFromSlug()` are what `get()` calls; `toJSON()`/`toPublicJSON()` are
 * what every read serializes through. None of these are a subclass-specific
 * operation, so none is exposed as a generated CLI/MCP custom action --
 * even when a subclass declares its own override (e.g. `User.save()` at
 * `packages/users/src/models/User.ts`). An override is still the same
 * lifecycle operation, not a new one (#2638). `delete` itself is a CRUD verb
 * `packages/cli/src/cli-generator.ts`'s `CLIGenerator`/`MCPGenerator` already
 * special-case, so it is not repeated here.
 *
 * Scope is deliberately narrower than "every public method on
 * SmrtObject/SmrtClass/SmrtCollection":
 *
 * - AI operations `is()`/`do()`/`describe()` are declared on `SmrtObject`
 *   but are explicitly designed to be overridden with domain-specific
 *   behavior and exposed as a distinct action -- confirmed by existing,
 *   intentional coverage
 *   (`vite-plugin/generated-client-integration.test.ts`'s `ArtCollection.
 *   describe(tone)` with its own declared API route). Excluding them here
 *   would regress real, working behavior. (The sibling
 *   `generators/cli-commands.spec.ts` fixture that used to cover the same
 *   `describe()` custom action was retired with core's `CLIGenerator`,
 *   #2664; this remaining fixture still exercises the behavior.)
 * - Relationship loading (`loadRelated`/`loadRelatedMany`/`getRelated`/
 *   `isRelatedLoaded`), memory (`remember`/`recall`/`recallAll`/`forget`/
 *   `forgetScope`), embeddings (`generateEmbeddings`/`getEmbedding`/
 *   `hasStaleEmbeddings`/`clearEmbeddings`), and AI-usage introspection
 *   (`getAiUsageSnapshot`/`resetAiUsage`/`listAiUsage`/`summarizeAiUsage`)
 *   are generic capabilities a class may legitimately want to trigger or
 *   report on as a distinct action (e.g. "regenerate this record's
 *   embeddings"), not "the mechanism behind CRUD" the way `save`/
 *   `initialize` are. Nothing in the measured #2638 residual touches them,
 *   so blanket-excluding them is a separate, unevidenced call this fix does
 *   not make.
 * - `SmrtCollection`'s own surface (`count`, `facets`, `query`, `findOne`,
 *   `generateMissingEmbeddings`, ...) is excluded entirely for the same
 *   reason: the measured residual is 100% item-class overrides (`User`,
 *   `Invoice`, `Payment`, ...), never a collection-class override, and
 *   `count`/`facets` read as genuinely distinct query capabilities in
 *   existing fixtures elsewhere in the repo (e.g.
 *   `packages/content/src/server/content-list-actions.test.ts`). Extending
 *   this rule to `SmrtCollection` needs its own review, not a ride-along
 *   here.
 *
 * This can only be a METHOD-NAME list, not a reuse of the existing
 * class-name sets (`FRAMEWORK_METHOD_BASE_NAMES` in
 * `scanner/manifest-generator.ts`, the registry's own by-name skip in
 * `registry/inheritance-resolver.ts`, or the broader 8-class
 * `FRAMEWORK_BASE_CLASSES` those two modules also cross-reference for the
 * unrelated schema-field-merge question): those sets answer "is this
 * ancestor one of the excluded classes", which only ever decides whether to
 * MERGE an ancestor's methods onto a subclass that does not declare them.
 * A locally declared override -- the #2638 case -- IS the subclass's own
 * method; there is no ancestor lookup to skip, because the method that
 * needs excluding was never inherited in the first place. The same
 * plumbing-vs-operation judgment #2624 made at the class level has to be
 * re-expressed as a method-name list to reach the override case too, which
 * is why this is a fifth name list rather than a reuse of one of the four.
 *
 * A static, hand-maintained list (not runtime introspection of the actual
 * `SmrtObject`/`SmrtClass` prototypes) matches the existing pattern for all
 * four sibling lists above, and keeps this transport-neutral module usable
 * from a pure manifest/AST build path (`vite-plugin/sveltekit-generator.ts`)
 * that has no live class registry to introspect. Re-derive this list from
 * those two files' own public method signatures if they change.
 */
export const FRAMEWORK_LIFECYCLE_METHOD_NAMES: ReadonlySet<string> = new Set([
  // SmrtClass (src/class.ts) — resource/transaction plumbing.
  'destroy',
  'withDatabase',
  // SmrtObject (src/object.ts) — identity/persistence lifecycle mechanism.
  'initialize',
  'loadDataFromDb',
  'getFields',
  'toJSON',
  'toPlainObject',
  'toPublicJSON',
  'getId',
  'getSlug',
  'getSavedId',
  'isSaved',
  'save',
  'claimRevision',
  'classifyConstraintError',
  'loadFromId',
  'loadFromSlug',
  'markAsPersisted',
  'requireInsertOnSave',
  'withTransaction',
]);

/**
 * True when `methodName` is one of the universal `SmrtObject`/`SmrtClass`
 * lifecycle methods above — the mechanism behind generated CRUD, never a
 * subclass-specific custom action, even when the subclass declares its own
 * override.
 */
export function isFrameworkLifecycleMethod(methodName: string): boolean {
  return FRAMEWORK_LIFECYCLE_METHOD_NAMES.has(methodName);
}

/** Minimal shape `resolveCustomActionNames` needs from a method entry. */
export interface ResolvableMethod {
  isPublic: boolean;
}

/**
 * Resolve the effective set of custom (non-CRUD) command/tool names exposed
 * for an object, given its transport config's `include`/`exclude` and its
 * method map: every public method, minus CRUD verbs, minus framework
 * lifecycle methods, restricted to `include` when present and always minus
 * `exclude`. Its sole caller as of #2664 (`CLIGenerator` and the
 * `generateCLIModule()` virtual module were retired):
 *
 * - `findCliApiCoherenceViolations`'s bare-`cli: true`/`cli: {}` branch
 *   (over the static manifest, no explicit `include`) -- see
 *   `resolveCliActionSet` in `vite-plugin/sveltekit-generator.ts`.
 *
 * NOT the one universal resolution, and deliberately not reused by every
 * caller that resolves a CLI command set:
 *
 * - Core's now-retired `CLIGenerator.assertCommandExposed()` (#2664) did not
 *   call this for its custom-method branch — it checked
 *   `isFrameworkLifecycleMethod()` directly plus its own inline
 *   public/include/exclude logic, so it could give a distinct error message
 *   per failure reason (unknown vs. not public vs. not enabled vs. lifecycle
 *   method) rather than a single boolean membership test. The shipped local
 *   CLI's `generateObjectCommands()` (`packages/cli/src/cli-generator.ts`)
 *   has no equivalent of that gate at all today — it filters on reserved-CRUD
 *   name collision, `isPublic`, and `exclude`/`include`, but never
 *   `isFrameworkLifecycleMethod()`, so a locally overridden lifecycle method
 *   IS a reachable command there (see `knowledge.ts`'s `configuredOperations()`
 *   docblock for the same caveat).
 * - `findCliApiCoherenceViolations`'s EXPLICIT-`cli.include` branch
 *   deliberately bypasses this function too: an `include` entry naming a
 *   typo, a getter, or a private/protected method must still surface as
 *   "unreachable" at build time (the pre-#2638 behavior), and this function
 *   can only ever return names that exist in the manifest's `methods` map —
 *   it would silently drop such an entry instead of flagging it. See
 *   `resolveCliActionSet` in `vite-plugin/sveltekit-generator.ts` for the
 *   full rationale; do not "simplify" that branch onto this function.
 *
 * `crudActionNames` stays a parameter even though every caller now passes
 * {@link CRUD_OPERATIONS} (#2665 retired the last of the inline copies at
 * `vite-plugin/sveltekit-generator.ts`, following `CLIGenerator`'s #2646
 * switch; `vite-plugin/index.ts`'s copy backed the `generateCLIModule()`
 * emitter #2664 later retired, so `index.ts` no longer calls this function
 * or imports `CRUD_OPERATIONS` at all). Removing the parameter is a separate,
 * unevidenced call this fix does not make -- it would foreclose a caller
 * that legitimately needs a different verb set, and no such need has been
 * demonstrated either way.
 */
export function resolveCustomActionNames(
  methods: Iterable<[string, ResolvableMethod]>,
  config: { include?: string[]; exclude?: string[] } | undefined,
  crudActionNames: readonly string[],
): Set<string> {
  const included = config?.include;
  const excluded = config?.exclude ?? [];
  const result = new Set<string>();
  for (const [name, method] of methods) {
    if (crudActionNames.includes(name)) continue;
    if (isFrameworkLifecycleMethod(name)) continue;
    if (!method.isPublic) continue;
    if (excluded.includes(name)) continue;
    if (included !== undefined && !included.includes(name)) continue;
    result.add(name);
  }
  return result;
}

/**
 * The CRUD verbs a generated surface emits directly. A method whose name
 * collides with one of these may not be exposed as a custom action under that
 * name: the generated operation already claims it, so a second command/tool
 * would land on a name that is taken.
 *
 * This is a NAMESPACE rule, independent of where the method came from — a
 * class's own `list()` collides exactly as a merged ancestor's does (#2646).
 *
 * What a collision means differs by EMITTER, so consult the one you are
 * changing rather than assuming a single rule. The reservation lives at each
 * emission site, not here, and several emitters still keep their own inline
 * verb array — find them with a multi-line-tolerant search (#2665 turned the
 * single-line form of this grep blind to a wrapped literal like
 * `templates/default-ui.ts`'s `CRUD_OPERATIONS_FOR_BROWSER_TEMPLATE`):
 *
 *     rg -U "'list',\s*'get',\s*'create',\s*'update',\s*'delete'" packages --type ts | grep -v include:
 *
 * This is a STARTING POINT, not a closed inventory: the `include:` filter
 * only drops a single-line `include: [...]` block, so a wrapped one (e.g.
 * `packages/content/src/content.ts`) still surfaces, and the pattern also
 * matches non-decorator uses of the same five-word literal that have nothing
 * to do with this collision rule (e.g. `packages/smrt-workbench/src/
 * discovery.ts`'s `CRUD_ACTIONS`, `packages/smrt-dev-mcp/.../
 * introspect-project.ts`'s `DEFAULT_MCP_OPERATIONS`). Triage each hit rather
 * than trusting the raw list. Within `packages/core/src/vite-plugin/`
 * specifically, the emitter-relevant survivors as of #2665 are
 * `generated-client.ts` and `templates/default-ui.ts` (the latter
 * deliberate, value-pinned by `issue-2665-crud-verb-consolidation.spec.ts`);
 * `scanner/manifest-generator.ts` and `packages/users/src/sveltekit/
 * resource-list-handler.ts` are outside this PR's scope.
 *
 * The sites this rule was audited against (#2646), NOT an exhaustive
 * inventory:
 *
 * - `generators/mcp.ts` — unconditional, case-folded. `executeAction` switches
 *   on the verb parsed out of the tool id, so `${object}_list` runs the
 *   built-in list whichever branch emitted it: the class's method could never
 *   run, and emitting one would hand the caller an operation `include` never
 *   named.
 * - `packages/cli/src/cli-generator.ts`, behind the shipped `smrt` object
 *   commands — reserves only where the CRUD command is actually emitted, and
 *   reserves the command NAMES AND THEIR ALIASES (`ls`, `show`, `new`, `edit`,
 *   `rm`), because lookup matches aliases too (#2648). The set is derived from
 *   the commands actually pushed, so it cannot drift from those aliases. Each
 *   command carries its own handler invoking the class's method, so with
 *   `cli: { include: ['list', 'get'] }` neither a public `create()` nor an
 *   `edit()` collides with anything and both stay reachable.
 * - `vite-plugin/sveltekit-generator.ts` — unconditional, exact, via
 *   {@link isCrudOperation} (#2665; previously its own `STANDARD_API_ACTIONS`
 *   copy).
 * - `vite-plugin/web-collections.ts` + `tool-schema.ts` — case-folded (ids are
 *   lowercased whole like MCP's), CONDITIONAL, and scoped PER COLLECTION.
 *   Applied in both of `selectWebMcpToolEntries`' loops and at the shared
 *   `buildWebToolDescriptorsForHost` choke point, which the legacy
 *   per-collection descriptor export also passes through (#2648).
 *
 *   Conditional, unlike `generators/mcp.ts`: MCP dispatch parses the verb out
 *   of the tool id, so `${obj}_list` can only ever run the built-in list, but a
 *   WebMCP descriptor carries its own `route` from `resolveApiActionRouteConfig`
 *   — with `api: { include: ['List'] }`, `product_list` dispatches to
 *   `/products/List` and is the only tool for that id, so reserving it would
 *   make a custom-action-only model undiscoverable.
 *
 *   Per collection, not per host: the id prefix is the OWNER's `className`, so
 *   every host mapping to one collection shares the namespace. A host-local
 *   check lets a model that excludes `list` but declares `List()` claim
 *   `product_list`, after which a sibling's real `list` is dropped by the
 *   fold-dedupe. The emitted-verb set is the union over the collection's hosts.
 *
 *   `resolveApiActionSet` stays exact-match: REST routes keep declared casing,
 *   so `/products/List` is genuinely distinct from `/products`.
 *
 * `vite-plugin/api-client-entries.ts` and `vite-plugin/sveltekit-generator.ts`
 * now import {@link CRUD_OPERATIONS} (or {@link isCrudOperation} where a bare
 * `.includes()` on the readonly tuple failed the stricter
 * `tsconfig.typecheck.json`) rather than keeping their own verb copies
 * (#2665). `vite-plugin/index.ts`'s copy backed `generateCLIModule()`, which
 * #2664 retired along with the rest of the unused `smrt-virt-cli` module, so
 * `index.ts` no longer imports anything from this module at all.
 * `vite-plugin/templates/default-ui.ts` keeps its
 * verb list as a local literal deliberately: `src/vite-plugin/templates/**`
 * is excluded from both tsconfigs and the vite-dts build graph, and the
 * package build copies that directory to `dist/` verbatim rather than
 * compiling it -- see the module's own comment. Its `.ts` source is never
 * resolved or bundled by anything in this package, so a static import of the
 * Node-side `isCrudOperation`/`CRUD_OPERATIONS` (which pull in
 * `tools/tool-generator.js`) would never be satisfied there. The
 * consolidation test instead asserts the literal's *value* matches
 * {@link CRUD_OPERATIONS} rather than assuming it imports it. Consolidating
 * the lists did not change any of the
 * per-emitter RULES documented above -- each site still decides case-folding
 * and conditionality for itself.
 *
 * Read the list through {@link isCrudOperation} or {@link isCrudToolAction}
 * rather than re-declaring it; the two differ only in case folding, because the
 * transports namespace differently (see below).
 */
export const CRUD_OPERATIONS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
] as const;

/**
 * Exact-match test for a case-SENSITIVE surface. The CLI keeps a method's
 * declared casing in its command name (`${object}:${methodName}`) and resolves
 * an action by exact match, so `foo:List` is a distinct, callable custom
 * command that must not be folded into `foo:list`.
 */
export function isCrudOperation(name: string): boolean {
  return (CRUD_OPERATIONS as readonly string[]).includes(name);
}

/**
 * Case-FOLDED test for a lowercase tool namespace. MCP tool identifiers are
 * lowercased whole (`` `${object}_${methodName}`.toLowerCase() ``) for a stable
 * protocol vocabulary, so a method named `List` lands on the identifier
 * `object_list` that the generated CRUD tool already owns. The namespace key is
 * the lowercased name, so the collision test has to be too (#2646).
 */
export function isCrudToolAction(name: string): boolean {
  return isCrudOperation(name.toLowerCase());
}

export interface CustomActionMetadata {
  scope: CustomActionScope;
  /** An item-targeted action requires its target identifier. */
  idRequired: boolean;
  /** Present only when scanner/manifest metadata is available. */
  parameters?: MethodDefinition['parameters'];
  /** Collection actions on a model class invoke its static method. */
  isStatic: boolean;
  /** Browser/agent-visible effect. Omitted declarations fail closed. */
  effect?: ToolEffect;
  /** Whether repeating the action with the same arguments is safe. */
  idempotent?: boolean;
  /** Whether the opaque action may interact outside the SMRT application. */
  openWorld?: boolean;
}

/** Fully resolved metadata returned by {@link resolveCustomActionMetadata}. */
export type ResolvedCustomActionMetadata = CustomActionMetadata &
  Required<Pick<CustomActionMetadata, 'effect' | 'idempotent' | 'openWorld'>>;

/**
 * Return the transport field for a method parameter. Flat tool and CLI
 * transports reserve `id` for receiver parsing even when a collection action
 * rejects it, so every action parameter named `id` is exposed as `actionId`.
 * REST already has separate path/body namespaces.
 */
export function customActionParameterInputName(
  _metadata: Pick<CustomActionMetadata, 'idRequired'>,
  parameterName: string,
): string {
  return parameterName === 'id' ? 'actionId' : parameterName;
}

export interface ResolveCustomActionMetadataOptions {
  actionName: string;
  method?: {
    isStatic?: boolean;
    parameters?: MethodDefinition['parameters'];
    /**
     * The method's `@method()` config, whose options win field by field over
     * the class-level `api.routes` entry for the same action (#2686).
     */
    decoratorConfig?: Record<string, unknown>;
  };
  apiConfig?: unknown;
  /** Collection-class actions have a collection receiver even when non-static. */
  defaultScope?: CustomActionScope;
}

type JsonSchema = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;

/**
 * Resolve the target contract shared by MCP, generated REST, CLI discovery,
 * and WebMCP. A missing manifest method retains the historical item-shaped
 * schema; runtime callers may still provide their legacy collection fallback.
 */
export function resolveCustomActionMetadata(
  options: ResolveCustomActionMetadataOptions,
): ResolvedCustomActionMetadata {
  const defaultScope =
    options.defaultScope ?? (options.method?.isStatic ? 'collection' : 'item');
  const requestedScope = readConfiguredScope(options);
  // A DECLARED scope -- from `api.routes[action].scope` or `@method({ scope })`
  // -- cannot manufacture a receiver. A normal instance method is always
  // item-targeted; a static model method and a recognized collection-class
  // method are always collection-targeted. A matching explicit value is kept
  // for diagnostics/config round-tripping only; a contradicting one is
  // reported by `resolveDeclaredScopeMismatch` at build time rather than
  // relocating the method (#2686).
  const scope = requestedScope === defaultScope ? requestedScope : defaultScope;
  const configured = readConfiguredToolMetadata(options);
  const effect = configured.effect ?? 'destructive';

  return {
    scope,
    idRequired: scope === 'item',
    ...(options.method?.parameters
      ? { parameters: options.method.parameters }
      : {}),
    isStatic: options.method?.isStatic === true,
    effect,
    // Per-field fail-closed default (#2587, CapabilityDeclaration in
    // @happyvertical/smrt-types): an omitted `idempotent` resolves to
    // `false` regardless of the declared `effect` — a declared 'read'
    // action is not guaranteed idempotent (e.g. a dequeue-shaped read that
    // advances state), so a caller who wants the idempotent hint must
    // declare it explicitly.
    idempotent: configured.idempotent ?? false,
    openWorld: configured.openWorld ?? true,
  };
}

/**
 * The declared scope, when it contradicts the receiver the method actually
 * has; `undefined` when there is no declaration or it agrees.
 *
 * A scope is a DECLARATION about a method, not a relocation of it: nothing in
 * a config can move an instance method onto the class. Silently ignoring a
 * contradiction leaves an author believing a route exists at a collection URL
 * that was never written, so the generators report this at build time
 * (#2686).
 */
export function resolveDeclaredScopeMismatch(options: {
  actionName: string;
  method?: ExposableMethod;
  apiConfig?: unknown;
  /** The receiver-derived scope, as the emitter computed it. */
  effectiveScope: CustomActionScope;
}): CustomActionScope | undefined {
  const declared = resolveEffectiveActionMetadata({
    actionName: options.actionName,
    ...(options.method ? { method: options.method } : {}),
    apiConfig: options.apiConfig,
  }).scope;
  if (!declared || declared === options.effectiveScope) return undefined;
  return declared;
}

/** Build the custom-action portion of an MCP/WebMCP JSON Schema. */
export function buildCustomActionInputSchema(
  metadata: CustomActionMetadata,
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (metadata.idRequired) {
    properties.id = {
      type: 'string',
      description: 'ID of the object to execute action on',
    };
    required.push('id');
  }

  // Absent metadata is the legacy options-bag contract. Do not infer direct
  // positional arguments from runtime function arity: it is lossy after
  // transpilation and would make discovery non-deterministic.
  if (!metadata.parameters) {
    properties.options = {
      type: 'object',
      description: 'Additional options for the custom action',
      additionalProperties: true,
    };
  } else if (
    metadata.parameters.length === 1 &&
    metadata.parameters[0]?.name === 'options'
  ) {
    const parameter = metadata.parameters[0];
    properties.options = {
      ...convertTypeToJsonSchema(parameter.type),
      description: 'Options for the custom action',
      ...(parameter.default !== undefined
        ? { default: parameter.default }
        : {}),
    };
    if (!parameter.optional) required.push('options');
  } else {
    for (const parameter of metadata.parameters) {
      const inputName = customActionParameterInputName(
        metadata,
        parameter.name,
      );
      properties[inputName] = {
        ...convertTypeToJsonSchema(parameter.type),
        ...(parameter.default !== undefined
          ? { default: parameter.default }
          : {}),
      };
      if (!parameter.optional) required.push(inputName);
    }
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Translate a transport object into the method's call arguments. Legacy
 * actions retain their single options-bag invocation; scanner metadata enables
 * an exact positional projection without changing legacy action behavior.
 */
export function buildCustomActionInvocationArgs(
  metadata: CustomActionMetadata,
  args: ToolArgs,
): unknown[] {
  const { id: _id, options, ...directArgs } = args;

  if (!metadata.parameters) {
    return [
      isRecord(options) && Object.keys(options).length > 0
        ? options
        : directArgs,
    ];
  }
  if (metadata.parameters.length === 0) return [];
  if (
    metadata.parameters.length === 1 &&
    metadata.parameters[0]?.name === 'options'
  ) {
    // Preserve `undefined` (and an explicit `null`) so JavaScript default
    // parameter initializers and intentional null handling retain their native
    // semantics. Legacy options bags still receive an empty object below.
    return [options];
  }
  return metadata.parameters.map((parameter) =>
    coerceCustomActionArgument(
      args[customActionParameterInputName(metadata, parameter.name)],
      parameter.type,
    ),
  );
}

/**
 * Domain-neutral returned-failure convention for custom actions. The explicit
 * `ok: false` marker prevents successful opaque values such as `{ code,
 * message }` from being reclassified as failures by a transport.
 */
export interface CustomActionFailure {
  ok: false;
  code: string;
  message: string;
  status: number;
  details?: unknown;
  retryable?: boolean;
  correlationId?: string;
}

/** Stable MCP `_meta` member shared with the app discovery contract (#2181). */
export const SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY = 'io.happyvertical/smrt';

/**
 * Detect, validate, and redact an explicitly returned custom-action failure.
 * Unknown return values remain opaque successes. `status` defaults to 400 so
 * REST callers receive non-2xx semantics even when an adapter omits it.
 */
export function normalizeCustomActionFailure(
  value: unknown,
): CustomActionFailure | undefined {
  if (!isRecord(value) || value.ok !== false) return undefined;
  if (typeof value.code !== 'string' || typeof value.message !== 'string') {
    return undefined;
  }

  const status =
    typeof value.status === 'number' &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599
      ? value.status
      : 400;

  return {
    ok: false,
    code: value.code,
    message: redactText(value.message),
    status,
    ...(Object.hasOwn(value, 'details')
      ? { details: redactValue(value.details) }
      : {}),
    ...(typeof value.retryable === 'boolean'
      ? { retryable: value.retryable }
      : {}),
    ...(typeof value.correlationId === 'string'
      ? { correlationId: value.correlationId }
      : {}),
  };
}

function readConfiguredScope(
  options: ResolveCustomActionMetadataOptions,
): CustomActionScope | undefined {
  return resolveEffectiveActionMetadata({
    actionName: options.actionName,
    ...(options.method ? { method: options.method } : {}),
    apiConfig: options.apiConfig,
  }).scope;
}

function readConfiguredToolMetadata(
  options: ResolveCustomActionMetadataOptions,
): {
  effect?: ToolEffect;
  idempotent?: boolean;
  openWorld?: boolean;
} {
  const effective = resolveEffectiveActionMetadata({
    actionName: options.actionName,
    ...(options.method ? { method: options.method } : {}),
    apiConfig: options.apiConfig,
  });
  // Validated against the EFFECTIVE verb, so a `@method({ httpMethod })`
  // override is checked the same way a legacy `routes[action].method` is.
  if (
    effective.effect === 'read' &&
    (effective.httpMethod === 'PUT' ||
      effective.httpMethod === 'PATCH' ||
      effective.httpMethod === 'DELETE')
  ) {
    throw new Error(
      `Custom action ${options.actionName} cannot declare a read effect for a ${effective.httpMethod} route`,
    );
  }
  return {
    ...(effective.effect ? { effect: effective.effect } : {}),
    ...(effective.idempotent !== undefined
      ? { idempotent: effective.idempotent }
      : {}),
    ...(effective.openWorld !== undefined
      ? { openWorld: effective.openWorld }
      : {}),
  };
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value))
    return value.map((entry) => redactValue(entry, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return '[REDACTED]';
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? '[REDACTED]'
      : redactValue(nested, seen);
  }
  return result;
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|api[_-]?key)=([^\s&]+)/giu,
      '$1=[REDACTED]',
    );
}

function isSensitiveKey(key: string): boolean {
  return /(?:token|secret|password|authorization|cookie|credential|api[_-]?key)/iu.test(
    key,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------------ *
 * @method() metadata and the API wire-ability gate (#2686)
 * ------------------------------------------------------------------------ */

/**
 * The `@method()` decorator's options, as they reach a consumer.
 *
 * Narrowed from the manifest's untyped `MethodDefinition.decoratorConfig` by
 * {@link readMethodDecoratorConfig}. The authoring type is `MethodOptions` in
 * `decorators/index.ts`; this is the read side, and it is deliberately
 * defensive — every field is validated, and a malformed one is dropped rather
 * than trusted, the same stance `readConfiguredToolMetadata` takes for a
 * scanned `api.routes` entry.
 */
export interface MethodDecoratorConfig {
  /**
   * `false` withholds a method the wire-ability heuristic accepted; `true`
   * exposes one it rejected.
   *
   * `true` bypasses the HEURISTIC only. It cannot manufacture a receiver, undo
   * `api: false`, escape an `include`/`exclude` boundary, reach a non-public
   * method, or claim a CRUD verb the generated operation already owns — and it
   * does not hydrate a parameter the transport cannot build (a model instance
   * still arrives as whatever JSON the caller sent).
   */
  expose?: boolean;
  /** Why the method is withheld. Reported by the knowledge artifact. */
  reason?: string;
  /** HTTP verb for the generated route. Migrates from `api.routes[m].method`. */
  httpMethod?: ApiHttpMethod;
  /** Route path segment(s). Migrates from `api.routes[m].path`. */
  path?: string;
  /**
   * Declared receiver scope. Migrates from `api.routes[m].scope`.
   *
   * DECLARATIVE, not relocating: the executable receiver decides (an instance
   * method is item-scoped, a static or collection-class method is
   * collection-scoped), exactly as `api.routes[m].scope` already behaves. A
   * mismatch keeps the receiver and reports a diagnostic.
   */
  scope?: CustomActionScope;
  /** Browser/agent-visible effect. Migrates from `api.routes[m].effect`. */
  effect?: ToolEffect;
  /** Whether repeating the action with the same arguments is safe. */
  idempotent?: boolean;
  /** Whether the action may interact outside the SMRT application. */
  openWorld?: boolean;
  /** AI/tool description. Migrates from `ai.descriptions[m]`. */
  description?: string;
}

/** Minimal method shape the exposure resolver reads. */
export interface ExposableMethod {
  isPublic?: boolean;
  isStatic?: boolean;
  parameters?: MethodDefinition['parameters'];
  decoratorConfig?: Record<string, unknown>;
}

/**
 * Read and validate the `@method()` config the scanner put on a manifest
 * method. Returns `undefined` for an undecorated method.
 */
export function readMethodDecoratorConfig(
  method: ExposableMethod | undefined,
): MethodDecoratorConfig | undefined {
  const raw = method?.decoratorConfig;
  if (!isRecord(raw)) return undefined;

  const scope =
    raw.scope === 'item' || raw.scope === 'collection' ? raw.scope : undefined;
  const effect =
    raw.effect === 'read' ||
    raw.effect === 'write' ||
    raw.effect === 'destructive'
      ? raw.effect
      : undefined;

  return {
    ...(typeof raw.expose === 'boolean' ? { expose: raw.expose } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
    ...(isApiHttpMethod(raw.httpMethod) ? { httpMethod: raw.httpMethod } : {}),
    ...(typeof raw.path === 'string' ? { path: raw.path } : {}),
    ...(scope ? { scope } : {}),
    ...(effect ? { effect } : {}),
    ...(typeof raw.idempotent === 'boolean'
      ? { idempotent: raw.idempotent }
      : {}),
    ...(typeof raw.openWorld === 'boolean' ? { openWorld: raw.openWorld } : {}),
    ...(typeof raw.description === 'string'
      ? { description: raw.description }
      : {}),
  };
}

function isApiHttpMethod(value: unknown): value is ApiHttpMethod {
  return (
    value === 'GET' ||
    value === 'POST' ||
    value === 'PUT' ||
    value === 'PATCH' ||
    value === 'DELETE'
  );
}

/**
 * JavaScript values a JSON request body or query string cannot carry, keyed by
 * the type NAME the manifest records for them.
 *
 * Deliberately a name list rather than "anything not primitive": the manifest
 * cannot tell an interface from a class, so an unrecognized capitalized name
 * is assumed to be a plain data bag (see {@link isWireableTypeName}). These are
 * the well-known exceptions where that assumption is wrong for every project.
 * Model classes are excluded separately, by asking the manifest.
 */
const NON_SERIALIZABLE_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Function',
  'Buffer',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
  'Blob',
  'File',
  'FormData',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'Stream',
  'Readable',
  'Writable',
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'AbortSignal',
  'AbortController',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Error',
  'Symbol',
  'Promise',
  'SmrtDatabase',
  'DatabaseInterface',
  'SmrtCollection',
  'SmrtObject',
]);

/**
 * Generic container names whose ARGUMENTS carry the payload. `Record` is
 * included: its value type is checked, its key type is always a string-ish
 * index and never a receiver.
 */
const JSON_CONTAINER_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Array',
  'ReadonlyArray',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'NonNullable',
]);

/** Primitive/JSON-native type names a wire request can always carry. */
const JSON_PRIMITIVE_TYPE_NAMES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'void',
  'any',
  'unknown',
  'object',
  // A Date-typed parameter is hydrated from its ISO string by the generated
  // handler and by the runtime REST dispatcher -- see
  // `coerceCustomActionArgument`. Without that hydration a Date parameter is
  // NOT wire-able, so the two must stay together.
  'Date',
  'bigint',
]);

/** Options that let the wire-ability test consult the surrounding manifest. */
export interface WireabilityOptions {
  /**
   * True when `name` identifies a class the manifest knows about — a model,
   * collection, or junction. Such a parameter wants a live instance with
   * methods and a database binding; JSON cannot produce one.
   *
   * OPTIONAL, and its absence is a documented widening: without a manifest
   * (`resolveApiActionSet(objectDef)` with no second argument) the test cannot
   * distinguish `Asset` from `AssetOptions`, so it accepts both. Every
   * in-repo caller passes a manifest; the parameter stays optional only
   * because `resolveApiActionSet`'s manifest argument is public API and
   * optional there.
   */
  isModelClassName?: (name: string) => boolean;
}

/** Result of testing one method (or one parameter) for wire-ability. */
export interface WireabilityVerdict {
  wireable: boolean;
  /** Present only when `wireable` is false. */
  reason?: string;
}

const WIREABLE: WireabilityVerdict = { wireable: true };

/**
 * True when a manifest type NAME can be carried by a JSON request body.
 *
 * The default is ACCEPT: the manifest records types as strings and cannot tell
 * `RunContentReviewOptions` (an interface — a plain bag) from `Content` (a
 * model class). Rejecting every unrecognized capitalized name would withhold
 * routes from the overwhelmingly common options-bag shape, so an unrecognized
 * name is assumed to be a bag and rejection is driven by positive evidence:
 * a known non-serializable runtime type, a manifest class, or a bare type
 * parameter.
 */
function classifyTypeName(
  typeName: string,
  options: WireabilityOptions,
  depth: number,
): WireabilityVerdict {
  const type = typeName.trim();
  if (type === '') return WIREABLE;

  // Union: one JSON-shaped member is enough, because the caller can always
  // choose that branch. `addReference(content: Content | string)` already
  // accepts an id string and is genuinely reachable over HTTP (#2686).
  //
  // Split on TOP-LEVEL `|` only. A naive `split('|')` tore
  // `Array<Asset | string>` into `Array<Asset` and `string`, and the truncated
  // first fragment matched no rule and fell through to the default-accept path
  // — certifying a container of model instances as wire-able while the
  // union-free `Array<Asset>` was correctly rejected.
  const unionParts = splitTopLevel(type, '|');
  if (unionParts.length > 1) {
    const branches = unionParts.filter(
      (branch) => branch !== 'null' && branch !== 'undefined',
    );
    if (branches.length === 0) return WIREABLE;
    const verdicts = branches.map((branch) =>
      classifyTypeName(branch, options, depth + 1),
    );
    if (verdicts.some((verdict) => verdict.wireable)) return WIREABLE;
    return {
      wireable: false,
      reason: `every branch of \`${type}\` is unreachable over HTTP (${verdicts[0]?.reason ?? 'not JSON-shaped'})`,
    };
  }

  if (type.endsWith('[]')) {
    return classifyTypeName(type.slice(0, -2), options, depth + 1);
  }

  // String/number/boolean literal types.
  if (/^'.*'$/su.test(type) || /^-?\d/u.test(type)) return WIREABLE;

  const generic = /^([\w$.]+)\s*<(.*)>$/su.exec(type);
  if (generic) {
    const base = generic[1];
    if (JSON_CONTAINER_TYPE_NAMES.has(base)) {
      // Depth-bounded: the manifest stores the type as flat text, and a deeply
      // nested generic contributes nothing the gate can act on.
      if (depth >= WIREABILITY_MAX_DEPTH) return WIREABLE;
      const args = splitTopLevel(generic[2], ',');
      for (const arg of args) {
        const verdict = classifyTypeName(arg, options, depth + 1);
        if (!verdict.wireable) return verdict;
      }
      return WIREABLE;
    }
    return classifyTypeName(base, options, depth + 1);
  }

  if (NON_SERIALIZABLE_TYPE_NAMES.has(type)) {
    return {
      wireable: false,
      reason: `\`${type}\` is a runtime value a JSON request cannot carry`,
    };
  }
  if (JSON_PRIMITIVE_TYPE_NAMES.has(type)) return WIREABLE;

  // A bare type parameter (`T`, `T1`, `TResult`) has no shape at all to
  // validate or build, so it can never be certified wire-able.
  if (/^T(?:[0-9]|[A-Z][A-Za-z0-9]*)?$/u.test(type) || /^[A-Z]$/u.test(type)) {
    return {
      wireable: false,
      reason: `\`${type}\` is an unresolved type parameter`,
    };
  }

  // Qualified names (`ns.Thing`) are judged on their final segment, which is
  // what the manifest registers a class under.
  const simpleName = type.includes('.')
    ? (type.split('.').pop() as string)
    : type;
  if (options.isModelClassName?.(simpleName)) {
    return {
      wireable: false,
      reason: `\`${simpleName}\` is a model class instance, not JSON data`,
    };
  }

  return WIREABLE;
}

/** Recursion bound for generic type arguments. */
const WIREABILITY_MAX_DEPTH = 6;

/**
 * Class names a manifest knows about, cached per manifest object.
 *
 * The manifest is rebuilt, never mutated in place, so identity is a safe cache
 * key; a `WeakMap` keeps a discarded manifest's set collectable.
 */
const manifestClassNameCache = new WeakMap<
  SmartObjectManifest,
  ReadonlySet<string>
>();

/**
 * Build the `isModelClassName` predicate {@link classifyMethodWireability}
 * needs, from a manifest.
 *
 * Both the SIMPLE and QUALIFIED name of every manifest class are registered: a
 * parameter is annotated with the simple name in source, but a qualified name
 * can reach the predicate through a `TSQualifiedName` annotation.
 *
 * Returns `undefined` for a missing manifest, which widens the gate — see
 * {@link WireabilityOptions.isModelClassName}.
 */
export function createManifestClassNamePredicate(
  manifest: SmartObjectManifest | undefined,
): ((name: string) => boolean) | undefined {
  if (!manifest) return undefined;
  let names = manifestClassNameCache.get(manifest);
  if (!names) {
    const collected = new Set<string>();
    for (const [key, object] of Object.entries(manifest.objects ?? {})) {
      collected.add(key);
      if (object?.className) collected.add(object.className);
      if (object?.qualifiedName) collected.add(object.qualifiedName);
    }
    names = collected;
    manifestClassNameCache.set(manifest, names);
  }
  const resolved = names;
  return (name: string) => resolved.has(name);
}

/**
 * Split a type string on `delimiter`, but only where it appears OUTSIDE every
 * bracket pair — so `Record<string, Asset | null>` splits into two parts on
 * `,` and one part on `|`, never into truncated fragments like `Record<string`.
 *
 * A naive `split()` on either delimiter produces fragments that match no
 * classification rule and are therefore accepted by the default-accept path,
 * silently widening the gate. Both the union test and the type-argument scan
 * read this one implementation.
 */
function splitTopLevel(source: string, delimiter: ',' | '|'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '<' || char === '(' || char === '[' || char === '{')
      depth += 1;
    else if (char === '>' || char === ')' || char === ']' || char === '}')
      depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Whether one declared parameter can be built from a JSON request body or
 * query string.
 */
export function classifyParameterWireability(
  parameter: MethodDefinition['parameters'][number],
  options: WireabilityOptions = {},
): WireabilityVerdict {
  // A rest parameter has no stable name in a body (`options['...args']`), so
  // no transport can project one. This is independent of its element type.
  if (parameter.name.startsWith('...')) {
    return {
      wireable: false,
      reason: `rest parameter \`${parameter.name}\` cannot be projected from a request body`,
    };
  }

  // Fail closed on scanner uncertainty. `type` reads `'any'` for an
  // intersection or tuple the scanner could not express, and treating that as
  // the author's explicit `any` would route a method nobody certified (#2686).
  if (parameter.typeUnresolved) {
    return {
      wireable: false,
      reason: `the declared type of \`${parameter.name}\` could not be resolved by the scanner`,
    };
  }

  for (const memberType of parameter.memberTypes ?? []) {
    const verdict = classifyTypeName(memberType, options, 1);
    if (!verdict.wireable) {
      return {
        wireable: false,
        reason: `\`${parameter.name}\` contains a member where ${verdict.reason}`,
      };
    }
  }

  const verdict = classifyTypeName(parameter.type ?? 'any', options, 0);
  if (verdict.wireable) return WIREABLE;
  return {
    wireable: false,
    reason: `parameter \`${parameter.name}\`: ${verdict.reason}`,
  };
}

/**
 * Whether every declared parameter of a method can be built from a JSON
 * request body or query string.
 *
 * A method with NO manifest parameter metadata is wire-able: that is the
 * legacy options-bag contract every transport already supports, and absent
 * metadata is not evidence of a hostile signature.
 */
export function classifyMethodWireability(
  method: Pick<ExposableMethod, 'parameters'>,
  options: WireabilityOptions = {},
): WireabilityVerdict {
  for (const parameter of method.parameters ?? []) {
    const verdict = classifyParameterWireability(parameter, options);
    if (!verdict.wireable) return verdict;
  }
  return WIREABLE;
}

/**
 * Why a public method is not reachable as a generated API action.
 *
 * Machine-readable so callers can react differently per cause: the route
 * emitters warn on `no-receiver` (a configuration mistake worth shouting
 * about) and stay quiet on the rest, while the knowledge artifact reports the
 * accompanying `reason` text for every one of them (#2686).
 */
export type ApiMethodRejectionCode =
  | 'api-disabled'
  | 'crud-reserved'
  | 'not-public'
  | 'lifecycle-method'
  | 'excluded'
  | 'not-included'
  | 'withheld'
  | 'not-wireable'
  | 'no-receiver';

/** Verdict of {@link resolveApiMethodExposure}. */
export interface ApiMethodExposure {
  exposed: boolean;
  /** Present only when `exposed` is false. */
  code?: ApiMethodRejectionCode;
  /** Human-readable explanation, present only when `exposed` is false. */
  reason?: string;
}

export interface ResolveApiMethodExposureOptions extends WireabilityOptions {
  actionName: string;
  method: ExposableMethod;
  /** The class's scanned `api` config (`decoratorConfig.api`). */
  apiConfig?: unknown;
  /**
   * True when the HOST is a collection class, which emits only
   * collection-scoped routes. Drives the receiver check.
   */
  isCollectionClass?: boolean;
}

const EXPOSED: ApiMethodExposure = { exposed: true };

/**
 * The single decision every generated-API consumer asks: is this method
 * reachable as a custom REST action, and if not, why?
 *
 * ONE resolver, four consumers — both SvelteKit route emitters
 * (`generateRoutesForObject`, `generateCollectionRoutesForObject`), the
 * cli↔api coherence resolver (`resolveApiActionSet`), and the knowledge
 * artifact's API projection. They previously each re-derived a subset: the
 * emitters filtered on `shouldIncludeInApi` plus their own receiver skip,
 * `resolveApiActionSet` mirrored both, and `knowledge.ts` mirrored the
 * receiver half a third time. A gate added to only one of them would report a
 * method as unavailable while still writing its route file, which is the exact
 * incoherence this issue exists to close (#2686).
 *
 * Order matters, and is the tested precedence contract:
 *
 * 1. `api: false` — the class has no REST surface at all.
 * 2. A CRUD verb — the generated operation already owns the name (#2646).
 * 3. Non-public — never a surface.
 * 4. A framework lifecycle method (`save`, `initialize`, `toJSON`, ...) — the
 *    mechanism behind generated CRUD, not a distinct operation, even when a
 *    subclass declares its own override. `CLIGenerator` and `MCPGenerator`
 *    already gate on this; REST did not, and this is where it joins them
 *    (#2638, #2657).
 * 5. `api.exclude` — an explicit withdrawal.
 * 6. `api.include` — an explicit allowlist boundary.
 * 7. `@method({ expose: false })` — an explicit withdrawal that outranks every
 *    remaining rule, including a legacy `api.routes` entry for the same
 *    method. This is why the decorator is `@method()` and not `@action()`:
 *    declaring something an action in order to say it is not one contradicts
 *    itself.
 * 8. Explicit legacy exposure — a name listed in `api.include` or carrying an
 *    `api.routes` entry is a DECLARATION that this method is a route, made
 *    before the heuristic existed. It bypasses the heuristic. This is the
 *    documented compatibility exception that makes "nothing breaks" true for
 *    the 42 existing route entries; without it, migrating a class to the new
 *    gate could silently drop a route its author had spelled out.
 * 9. `@method({ expose: true })` — bypasses the heuristic, and NOTHING else.
 *    It cannot manufacture a receiver (step 10 still applies), reach a
 *    non-public method, or hydrate a parameter the transport cannot build.
 * 10. Wire-ability — every parameter must be constructible from JSON.
 * 11. Receiver — a collection class emits only collection-scoped routes, and a
 *     model class cannot host a collection-scoped instance method.
 */
export function resolveApiMethodExposure(
  options: ResolveApiMethodExposureOptions,
): ApiMethodExposure {
  const { actionName, method, apiConfig, isCollectionClass = false } = options;

  if (apiConfig === false) {
    return { exposed: false, code: 'api-disabled', reason: 'api is disabled' };
  }
  if (isCrudOperation(actionName)) {
    return {
      exposed: false,
      code: 'crud-reserved',
      reason: `\`${actionName}\` is reserved by the generated CRUD operation of the same name`,
    };
  }
  if (method.isPublic === false) {
    return {
      exposed: false,
      code: 'not-public',
      reason: 'not a public method',
    };
  }
  if (isFrameworkLifecycleMethod(actionName)) {
    return {
      exposed: false,
      code: 'lifecycle-method',
      reason: `\`${actionName}\` is a framework lifecycle method, not a distinct operation`,
    };
  }

  const config = getIncludeExclude(apiConfig);
  if (config.exclude?.includes(actionName)) {
    return {
      exposed: false,
      code: 'excluded',
      reason: 'listed in api.exclude',
    };
  }
  const includedExplicitly = config.include?.includes(actionName) === true;
  if (config.include !== undefined && !includedExplicitly) {
    return {
      exposed: false,
      code: 'not-included',
      reason: 'not listed in api.include',
    };
  }

  const declared = readMethodDecoratorConfig(method);
  if (declared?.expose === false) {
    return {
      exposed: false,
      code: 'withheld',
      reason: declared.reason ?? 'withheld by @method({ expose: false })',
    };
  }

  const hasLegacyRoute =
    readApiRouteConfig(apiConfig, actionName) !== undefined;
  const bypassesHeuristic =
    declared?.expose === true || includedExplicitly || hasLegacyRoute;

  if (!bypassesHeuristic) {
    const wireability = classifyMethodWireability(method, {
      ...(options.isModelClassName
        ? { isModelClassName: options.isModelClassName }
        : {}),
    });
    if (!wireability.wireable) {
      return {
        exposed: false,
        code: 'not-wireable',
        reason: `not routed: ${wireability.reason}`,
      };
    }
  }

  const receiver = resolveActionReceiver(
    actionName,
    method,
    apiConfig,
    isCollectionClass,
  );
  if (!receiver.hosted) {
    return { exposed: false, code: 'no-receiver', reason: receiver.reason };
  }

  return EXPOSED;
}

/**
 * Whether the resolved scope has an executable receiver on this host, matching
 * both route emitters' own skips exactly.
 *
 * UNREACHABLE BY CONSTRUCTION, and deliberately kept:
 * {@link resolveCustomActionMetadata} already collapses a contradicting
 * declared scope back to the receiver-derived one, so the resolved scope always
 * equals `defaultScope` and neither branch below can fire. That was equally
 * true of the two `console.warn` skips in `generateRoutesForObject` /
 * `generateCollectionRoutesForObject` that this replaced — moving them here
 * changed nothing about when they fire, and dropping them would remove the only
 * structural guard should that collapse ever be relaxed.
 *
 * The signal a developer actually sees for a contradicting declaration is
 * {@link resolveDeclaredScopeMismatch}, reported by the emitters at build time.
 */
function resolveActionReceiver(
  actionName: string,
  method: ExposableMethod,
  apiConfig: unknown,
  isCollectionClass: boolean,
): { hosted: true } | { hosted: false; reason: string } {
  const defaultScope: CustomActionScope = isCollectionClass
    ? 'collection'
    : method.isStatic
      ? 'collection'
      : 'item';
  let scope: CustomActionScope;
  try {
    scope = resolveCustomActionMetadata({
      actionName,
      method,
      apiConfig,
      defaultScope,
    }).scope;
  } catch {
    // The shared resolver validates as it resolves (a `read` effect on a
    // PUT/PATCH/DELETE route throws). One malformed action must not fail a
    // whole build or knowledge projection, and a route-only override cannot
    // change the receiver anyway -- fall back to it.
    scope = defaultScope;
  }

  if (isCollectionClass) {
    if (scope !== 'collection') {
      return {
        hosted: false,
        reason:
          'collection class methods only support collection-scoped API routes',
      };
    }
    return { hosted: true };
  }
  if (scope === 'collection' && method.isStatic !== true) {
    return {
      hosted: false,
      reason: 'collection API routes require a static method',
    };
  }
  return { hosted: true };
}

/**
 * The effective route/tool metadata for one custom action, with `@method()`
 * winning FIELD BY FIELD over the class-level `api.routes` map and
 * `ai.descriptions`.
 *
 * Field-by-field, not wholesale: `@method({ description: '...' })` on a class
 * that already declares `routes: { runReview: { method: 'POST', path:
 * 'reviews' } }` must not silently reset that verb and path to their defaults.
 * Only options the decorator actually supplies override their legacy
 * counterparts (#2686).
 */
export interface EffectiveActionMetadata {
  httpMethod?: ApiHttpMethod;
  path?: string;
  scope?: CustomActionScope;
  effect?: ToolEffect;
  idempotent?: boolean;
  openWorld?: boolean;
  description?: string;
}

export function resolveEffectiveActionMetadata(options: {
  actionName: string;
  method?: ExposableMethod;
  apiConfig?: unknown;
  aiConfig?: unknown;
}): EffectiveActionMetadata {
  const route = readApiRouteConfig(options.apiConfig, options.actionName);
  const declared = readMethodDecoratorConfig(options.method);
  const legacyDescription = readAiDescription(
    options.aiConfig,
    options.actionName,
  );

  const httpMethod =
    declared?.httpMethod ?? normalizeRouteHttpMethod(route?.method);
  const path =
    declared?.path ??
    (typeof route?.path === 'string' ? route.path : undefined);
  const scope = declared?.scope ?? normalizeRouteScope(route?.scope);
  const effect = declared?.effect ?? normalizeRouteEffect(route?.effect);
  const idempotent =
    declared?.idempotent ??
    (typeof route?.idempotent === 'boolean' ? route.idempotent : undefined);
  const openWorld =
    declared?.openWorld ??
    (typeof route?.openWorld === 'boolean' ? route.openWorld : undefined);
  const description = declared?.description ?? legacyDescription;

  return {
    ...(httpMethod ? { httpMethod } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(scope ? { scope } : {}),
    ...(effect ? { effect } : {}),
    ...(idempotent !== undefined ? { idempotent } : {}),
    ...(openWorld !== undefined ? { openWorld } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function normalizeRouteHttpMethod(value: unknown): ApiHttpMethod | undefined {
  return isApiHttpMethod(value) ? value : undefined;
}

function normalizeRouteScope(value: unknown): CustomActionScope | undefined {
  return value === 'item' || value === 'collection' ? value : undefined;
}

function normalizeRouteEffect(value: unknown): ToolEffect | undefined {
  return value === 'read' || value === 'write' || value === 'destructive'
    ? value
    : undefined;
}

function readAiDescription(
  aiConfig: unknown,
  actionName: string,
): string | undefined {
  if (!isRecord(aiConfig) || !isRecord(aiConfig.descriptions)) return undefined;
  const description = aiConfig.descriptions[actionName];
  return typeof description === 'string' ? description : undefined;
}

function readApiRouteConfig(
  apiConfig: unknown,
  actionName: string,
): Record<string, unknown> | undefined {
  if (!isRecord(apiConfig) || !isRecord(apiConfig.routes)) return undefined;
  const route = apiConfig.routes[actionName];
  return isRecord(route) ? route : undefined;
}

/**
 * Narrow a scanned transport config's `include`/`exclude`.
 *
 * A non-array value is treated as unset rather than throwing later on
 * `.includes()` — the same defensive stance every other reader of scanned
 * decorator config takes, because this data came from an AST, not a compiler.
 */
function getIncludeExclude(config: unknown): {
  include?: string[];
  exclude?: string[];
} {
  if (config === true || config === undefined || !isRecord(config)) return {};
  return {
    ...(Array.isArray(config.include) ? { include: config.include } : {}),
    ...(Array.isArray(config.exclude) ? { exclude: config.exclude } : {}),
  };
}

/**
 * Whether a method's `@method()` declaration is also a RUNTIME REST route
 * declaration, the way an `api.routes[m]` entry is.
 *
 * The runtime `APIGenerator` transport is deliberately declaration-gated: it
 * serves a custom collection action only where one was declared, because its URL
 * shape supports a single segment and an undeclared public method has never had
 * a route there. `dispatchCustomCollectionAction` and the `isRestActionRoutable`
 * preflight prediction must agree on that gate exactly, so both read this (#2686).
 *
 * True for any option that migrates from `ApiCustomRouteConfig` — its complete
 * field set is `scope`, `method`, `path`, `effect`, `idempotent`, `openWorld` —
 * because a legacy `routes: { m: { effect: 'write' } }` entry with no path or
 * verb already dispatches at `POST /<collection>/m`, and migrating it onto the
 * method must not silently delete that endpoint. Also true for an explicit
 * `expose: true`, which is a stronger statement that the method is an action
 * than an empty route entry is.
 *
 * FALSE for a bare `@method()` and for a `description`-only one. Neither
 * migrates from a route entry — `description` migrates from `ai.descriptions`,
 * and a bare decorator is a review marker — so counting them would hand the
 * runtime transport endpoints it never served.
 */
export function declaresRuntimeRestRoute(
  method: ExposableMethod | undefined,
): boolean {
  // `expose: false` outranks every other option, including one that would
  // otherwise declare a route. A predicate that still reported such an action
  // routable would make browser-plane preflight answer `allow` for an operation
  // the transport declines — the false-`allow` preflight exists to prevent.
  if (readMethodDecoratorConfig(method)?.expose === false) return false;
  return declaresRuntimeRestRouteShape(method);
}

/**
 * Whether the author WROTE a runtime REST route declaration on this method,
 * ignoring whether they then withheld it.
 *
 * Deliberately distinct from {@link declaresRuntimeRestRoute}: the dispatcher
 * must still SEE a withheld declaration in order to refuse it explicitly. This
 * router resolves `POST /<collection>/<segment>` to `create` when nothing
 * claims the segment, so dropping a withheld action from the candidate set
 * would turn a request aimed at an explicitly withheld operation into a silent
 * row insert. The candidate set reads this; the preflight PREDICTION reads
 * {@link declaresRuntimeRestRoute}, which adds the `expose: false` veto —
 * "there is a declaration here" and "it is reachable" are different questions.
 */
export function declaresRuntimeRestRouteShape(
  method: ExposableMethod | undefined,
): boolean {
  const declared = readMethodDecoratorConfig(method);
  if (!declared) return false;
  return (
    declared.httpMethod !== undefined ||
    declared.path !== undefined ||
    declared.scope !== undefined ||
    declared.effect !== undefined ||
    declared.idempotent !== undefined ||
    declared.openWorld !== undefined ||
    declared.expose !== undefined
  );
}

/**
 * Coerce one transport-supplied argument into the runtime value the declared
 * parameter type needs.
 *
 * Today that means exactly one conversion: a `Date` parameter, which the
 * wire-ability heuristic accepts as JSON-shaped. JSON has no date type, so a
 * caller can only send an ISO string (or an epoch number) and the receiving
 * method — which calls `getTime()`, or hands the value to a query builder that
 * expects a `Date` — would otherwise get a string. Accepting `Date` as
 * wire-able and NOT hydrating it here would generate a route that 500s, so the
 * two are one decision (#2686).
 *
 * Deliberately narrow:
 * - Only a TOP-LEVEL declared parameter is converted. A `Date` nested inside a
 *   named options bag is invisible to the manifest (the bag is accepted
 *   heuristically, its members unresolved), so it is not hydrated and the
 *   method must accept the string itself.
 * - An already-`Date` value, and anything that is not a string or finite
 *   number, passes through untouched, so a runtime caller invoking the same
 *   helper is never degraded.
 * - An unparseable string passes through as-is rather than becoming an
 *   `Invalid Date`, leaving the method's own validation in charge of the error
 *   message.
 */
export function coerceCustomActionArgument(
  value: unknown,
  declaredType: string | undefined,
): unknown {
  if (!declaredType || !declaredTypeAcceptsDate(declaredType)) return value;
  return toCustomActionDate(value);
}

/**
 * The `Date` half of {@link coerceCustomActionArgument}, exported on its own
 * because generated SvelteKit route code calls it directly: the generator
 * already knows at build time which parameters are `Date`-typed, so the
 * emitted handler names the conversion rather than re-deriving it from a type
 * string at runtime. Both paths share this one implementation so the two
 * transports cannot drift.
 */
export function toCustomActionDate(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value !== 'string' || value.trim() === '') return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed;
}

/**
 * True when the declared type is a `Date` and nothing else.
 *
 * `Date | null` and `Date | undefined` qualify — a nullish branch is not an
 * alternative representation. `Date | string` deliberately does NOT: that
 * signature already accepts the string a JSON caller sends, so the method's
 * own handling is authoritative and converting behind its back would change
 * which branch it takes.
 */
export function declaredTypeAcceptsDate(declaredType: string): boolean {
  const branches = declaredType
    .split('|')
    .map((branch) => branch.trim())
    .filter((branch) => branch !== 'null' && branch !== 'undefined');
  return branches.length > 0 && branches.every((branch) => branch === 'Date');
}
