/**
 * Canonical custom-action metadata and transport-safe result helpers.
 *
 * Custom actions are intentionally distinct from generated CRUD. Their target
 * is derived from method metadata: instance methods target an item and static
 * methods target the collection. API route configuration may shape an HTTP
 * route, but it cannot change a method's receiver.
 */

import type { ToolEffect } from '../registry/types.js';
import type { MethodDefinition } from '../scanner/types.js';
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
 * `CLIGenerator`/`MCPGenerator` already special-case, so it is not repeated
 * here.
 *
 * Scope is deliberately narrower than "every public method on
 * SmrtObject/SmrtClass/SmrtCollection":
 *
 * - AI operations `is()`/`do()`/`describe()` are declared on `SmrtObject`
 *   but are explicitly designed to be overridden with domain-specific
 *   behavior and exposed as a distinct action -- confirmed by existing,
 *   intentional coverage (`generators/cli-commands.spec.ts`'s
 *   `describe()` custom-action fixture,
 *   `vite-plugin/generated-client-integration.test.ts`'s `ArtCollection.
 *   describe(tone)` with its own declared API route). Excluding them here
 *   would regress real, working behavior.
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
 * `exclude`. Reused by three callers, so they agree with each other and
 * with what `listCommands()` advertises:
 *
 * - `CLIGenerator.listCommands()` (over the live `ObjectRegistry`).
 * - `findCliApiCoherenceViolations`'s bare-`cli: true`/`cli: {}` branch
 *   (over the static manifest, no explicit `include`) -- see
 *   `resolveCliActionSet` in `vite-plugin/sveltekit-generator.ts`.
 * - `generateCLIModule()` in `vite-plugin/index.ts`, which generates the
 *   `smrt:cli` virtual module's static command metadata. It layers one
 *   additional filter on top of this function's result: a leading `_` on
 *   the method name, because the manifest's `isPublic` is unreliable there
 *   (see that call site's own comment) and this function has no other
 *   signal to exclude an internal-by-convention method.
 *
 * NOT the one universal resolution, and deliberately not reused by every
 * caller that resolves a CLI command set:
 *
 * - `CLIGenerator.assertCommandExposed()` does not call this for its custom-
 *   method branch — it checks `isFrameworkLifecycleMethod()` directly plus
 *   its own inline public/include/exclude logic, so it can give a distinct
 *   error message per failure reason (unknown vs. not public vs. not
 *   enabled vs. lifecycle method) rather than a single boolean membership
 *   test.
 * - `findCliApiCoherenceViolations`'s EXPLICIT-`cli.include` branch
 *   deliberately bypasses this function too: an `include` entry naming a
 *   typo, a getter, or a private/protected method must still surface as
 *   "unreachable" at build time (the pre-#2638 behavior), and this function
 *   can only ever return names that exist in the manifest's `methods` map —
 *   it would silently drop such an entry instead of flagging it. See
 *   `resolveCliActionSet` in `vite-plugin/sveltekit-generator.ts` for the
 *   full rationale; do not "simplify" that branch onto this function.
 *
 * `crudActionNames` is supplied by the caller rather than duplicated here:
 * `CLIGenerator` and the SvelteKit generator each already keep their own
 * copy of the five CRUD verb names (`CRUD_OPERATIONS`/`STANDARD_API_ACTIONS`).
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
 * The CRUD verbs every generated surface emits directly. A method whose name
 * matches one of these is never a custom action: the verb is already taken by
 * the generated operation, so exposing the method under it would emit a second
 * command/tool under a name that is already claimed.
 *
 * This is a NAMESPACE rule, independent of where the method came from — a
 * class's own `list()` collides exactly as a merged ancestor's does (#2646).
 * Every transport reads this one list.
 */
export const CRUD_OPERATIONS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
] as const;

/** Whether `name` is a generated CRUD verb rather than a custom action. */
export function isCrudOperation(name: string): boolean {
  return (CRUD_OPERATIONS as readonly string[]).includes(name);
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
  const requestedScope = readConfiguredScope(
    options.apiConfig,
    options.actionName,
  );
  // A route-only scope override cannot manufacture a receiver. A normal
  // instance method is always item-targeted; a static model method and a
  // recognized collection-class method are always collection-targeted. Keep
  // a matching explicit value for diagnostics/config round-tripping only.
  const scope = requestedScope === defaultScope ? requestedScope : defaultScope;
  const configured = readConfiguredToolMetadata(
    options.apiConfig,
    options.actionName,
  );
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
  return metadata.parameters.map(
    (parameter) =>
      args[customActionParameterInputName(metadata, parameter.name)],
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
  apiConfig: unknown,
  actionName: string,
): CustomActionScope | undefined {
  if (!isRecord(apiConfig) || !isRecord(apiConfig.routes)) return undefined;
  const route = apiConfig.routes[actionName];
  return isRecord(route) &&
    (route.scope === 'item' || route.scope === 'collection')
    ? route.scope
    : undefined;
}

function readConfiguredToolMetadata(
  apiConfig: unknown,
  actionName: string,
): {
  effect?: ToolEffect;
  idempotent?: boolean;
  openWorld?: boolean;
} {
  if (!isRecord(apiConfig) || !isRecord(apiConfig.routes)) return {};
  const route = apiConfig.routes[actionName];
  if (!isRecord(route)) return {};
  const effect =
    route.effect === 'read' ||
    route.effect === 'write' ||
    route.effect === 'destructive'
      ? route.effect
      : undefined;
  if (
    effect === 'read' &&
    (route.method === 'PUT' ||
      route.method === 'PATCH' ||
      route.method === 'DELETE')
  ) {
    throw new Error(
      `Custom action ${actionName} cannot declare a read effect for a ${route.method} route`,
    );
  }
  return {
    ...(effect ? { effect } : {}),
    ...(typeof route.idempotent === 'boolean'
      ? { idempotent: route.idempotent }
      : {}),
    ...(typeof route.openWorld === 'boolean'
      ? { openWorld: route.openWorld }
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
