/**
 * Framework-agnostic declarative view intents (#2588).
 *
 * A view intent is an interaction a component owns that has no model
 * projection and never will — filter this list, advance the wizard, open the
 * archived tab. It is declared as a LITERAL object in a `.ts` module and
 * compiles into the mounted `ControlInteractionRegistry` /
 * `DataSurfaceRegistry` commands that `@happyvertical/smrt-ui` already
 * exposes, never around them.
 *
 * ## The hard invariant: an intent can never reach REST
 *
 * Enforced twice, structurally and at runtime.
 *
 * **Structurally**, {@link ViewIntentDeclaration} has no `execute`, `fetch`,
 * `url`, `route`, `endpoint`, or `method` field, and no field of function
 * type anywhere. Its `target` is a closed two-member union naming a browser
 * registry. There is no way to spell a network call in the type.
 *
 * **At runtime**, {@link defineIntent} rejects any key outside the declared
 * allowlist and any non-JSON value (functions included) anywhere in the
 * declaration, so a declaration cast through `as any` cannot smuggle one in
 * either. It reads every property exactly once and keeps a JSON COPY, so a
 * getter or Proxy cannot show the checker plain data and hand something else
 * to whoever reads the property next. The tool's `execute` is then CONSTRUCTED
 * by
 * {@link compileViewIntentToolSpec} from `intent.target` alone. An author
 * never supplies a callable, so there is no author-controlled code on the
 * execution path to place a `fetch` in.
 *
 * The decorator remains the sole authority on model-operation exposure
 * (epic #2585 invariant 1): a component may reference an operation
 * `@smrt({ api })` already exposes, through the generated model tools, but an
 * intent can only move browser state. And because intents dispatch registry
 * commands, `StagedControlReview` stays on the path unconditionally — an
 * agent-sourced `stage` is a proposal, and `apply` still requires the
 * registry's trusted local human gesture.
 *
 * ## Static form (the #2591 scanner contract)
 *
 * Declarations must be module-scope `defineIntent({ ... })` calls with a
 * single object literal argument, in a `.ts`/`.tsx` module — see
 * `packages/smrt-web/AGENTS.md` "Declarative view intents" for the contract
 * a scanner matcher implements against. Computed or conditional tool sets
 * keep using `useWebMcpTool`.
 *
 * This module imports nothing at runtime — not the client-data engine, not
 * `./index.js`, not `./webmcp.js` — so a `Foo.intents.ts` sidecar costs a
 * page nothing but its own declarations. Registration lives in `webmcp.ts`
 * (`registerViewIntent`), which is loaded lazily by every binding.
 */

import {
  capabilityDeclarationHints,
  resolveDeclaredCapability,
  WEBMCP_TOOL_EFFECTS,
  type WebMcpCapabilityAnnotations,
  type WebMcpCapabilityClassification,
  type WebMcpCapabilityDeclaration,
} from './capability-classification.js';

// ---------------------------------------------------------------------------
// Declaration contract
// ---------------------------------------------------------------------------

/**
 * Control commands a view intent may dispatch. Structurally mirrors
 * `ControlCommandAction` in `@happyvertical/smrt-ui/forms`; this package
 * cannot import that one (see AGENTS.md "No inter-smrt dependencies").
 */
export type ViewIntentControlAction =
  | 'focus'
  | 'reveal'
  | 'highlight'
  | 'explain'
  | 'validate'
  | 'stage'
  | 'apply'
  | 'discard'
  | 'clear'
  | 'undo';

const VIEW_INTENT_CONTROL_ACTIONS: readonly ViewIntentControlAction[] = [
  'focus',
  'reveal',
  'highlight',
  'explain',
  'validate',
  'stage',
  'apply',
  'discard',
  'clear',
  'undo',
];

/** Mirrors `DataSurfaceIdentity['kind']` in `@happyvertical/smrt-ui/data`. */
export type ViewIntentDataSurfaceKind = 'table' | 'list' | 'report' | 'custom';

const VIEW_INTENT_DATA_SURFACE_KINDS: readonly ViewIntentDataSurfaceKind[] = [
  'table',
  'list',
  'report',
  'custom',
];

/**
 * The optional record a registry identity is qualified by. Rich forms use it
 * to tell apart controls that share a `formId`/`controlId` across records.
 * Structurally mirrors `ControlIdentity['subject']` /
 * `DataSurfaceIdentity['subject']` in `@happyvertical/smrt-ui`.
 */
export interface ViewIntentSubject {
  type: string;
  id: string;
  label?: string;
}

/**
 * A control-registry target: the intent dispatches exactly one
 * `ControlInteractionRegistry` command against a mounted control.
 *
 * `formId`/`controlId` are the statically declared half of the identity. A
 * binding supplies the mounted identity and must MATCH anything declared
 * here — a declaration is authority over a binding, never the other way
 * round.
 */
export interface ViewIntentControlTarget {
  registry: 'control';
  action: ViewIntentControlAction;
  formId?: string;
  controlId?: string;
}

/**
 * A data-surface target: the intent dispatches one
 * `DataSurfaceVisibleCommand` — a browser-visible state transition, never a
 * server-side query or mutation.
 */
export interface ViewIntentDataSurfaceTarget {
  registry: 'dataSurface';
  /** The visible-command `controlId` the mounted surface implements. */
  controlId: string;
  surfaceId?: string;
  kind?: ViewIntentDataSurfaceKind;
}

export type ViewIntentTarget =
  | ViewIntentControlTarget
  | ViewIntentDataSurfaceTarget;

/**
 * The literal object passed to {@link defineIntent}. Every field is data;
 * none is a function, a URL, or a route.
 */
export interface ViewIntentDeclaration {
  /**
   * Stable, namespaced identity — at least one dot, lowercase, e.g.
   * `orders.filter_by_status`. It is the intent's name in the manifest
   * (#2591) and in a playbook step (`{ kind: 'intent', id }`, #2589), so it
   * must not be derived from anything that can change (a namespace, a
   * generated tool name, a route).
   */
  id: string;
  /** Human/agent-readable description. Becomes the tool description. */
  description: string;
  /** JSON Schema for the tool's arguments. Must be plain JSON. */
  inputSchema?: Record<string, unknown>;
  /**
   * Partial capability declaration resolved by the shared fail-closed rule
   * (#2587). Omitted entirely, an intent classifies destructive,
   * non-idempotent, open-world.
   */
  capability?: WebMcpCapabilityDeclaration;
  /** Which registry this compiles into, and what it addresses there. */
  target: ViewIntentTarget;
}

/**
 * A validated, frozen intent.
 *
 * `kind: 'intent'` and `id` are the exported identity a `smrt-playbooks`
 * step reference (`{ kind: 'intent', id }`) names, and this object is
 * directly assignable to that package's `PlaybookIntentRecord` seam —
 * `{ id, classification, planes }` — so {@link resolveViewIntent} can be
 * passed as its `intents` resolver unchanged.
 */
export interface ViewIntent {
  readonly kind: 'intent';
  readonly id: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Resolved through the shared fail-closed rule at declaration time. */
  readonly classification: WebMcpCapabilityClassification;
  readonly target: ViewIntentTarget;
  /**
   * An intent moves mounted browser state, so it is browser-valid only. A
   * server-side agent reaches one through the #2446 command/ack bridge, which
   * a playbook must declare explicitly.
   */
  readonly planes: readonly ['browser'];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const DECLARATION_KEYS = new Set([
  'id',
  'description',
  'inputSchema',
  'capability',
  'target',
]);
const CAPABILITY_KEYS = new Set(['effect', 'idempotent', 'openWorld']);
const CONTROL_TARGET_KEYS = new Set([
  'registry',
  'action',
  'formId',
  'controlId',
]);
const DATA_SURFACE_TARGET_KEYS = new Set([
  'registry',
  'controlId',
  'surfaceId',
  'kind',
]);

/** Lowercase, dot-namespaced, at least two segments. */
const INTENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_]*)+$/;
const IDENTIFIER_MAX_LENGTH = 256;
const INTENT_ID_MAX_LENGTH = 128;
const DESCRIPTION_MAX_LENGTH = 1024;

/**
 * The six fixed `smrt_ui_*` tools are explicitly unchanged by this contract,
 * and intents sit above them rather than duplicating them. An intent whose
 * derived tool name would land in their namespace is rejected.
 */
const RESERVED_TOOL_NAME_PREFIX = 'smrt_ui_';

function fail(message: string): never {
  throw new Error(`[smrt-web] invalid view intent declaration: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        `unknown key '${key}' at ${path}. A declaration is data only — there is no field for an execute function, a URL, a route, or a fetch.`,
      );
    }
  }
}

/**
 * Validate that a value is JSON data and return a fresh deep COPY of it. This
 * is the runtime half of the no-REST invariant: a function value is the only
 * way author code could reach the execution path, and there is no legitimate
 * reason for one to appear in a static declaration.
 *
 * It copies rather than merely asserting because validate-then-store-by-
 * reference is a time-of-check/time-of-use gap: a getter (or a Proxy) can
 * return plain JSON to the checker and a function to whoever reads the
 * property next. Every property is read exactly once, here, and everything
 * downstream sees only this copy — so what was validated is precisely what is
 * kept, frozen, and handed to the browser.
 */
function cloneJsonValue(value: unknown, path: string, depth = 0): unknown {
  if (depth > 32) fail(`${path} nests deeper than 32 levels`);
  if (value === null) return null;
  if (typeof value === 'function') {
    fail(
      `${path} is a function. A view intent declaration carries no code: its execute is constructed by the registry from 'target', so an intent has no path to REST.`,
    );
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} must be a finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      cloneJsonValue(entry, `${path}[${index}]`, depth + 1),
    );
  }
  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    // `Object.entries` reads each own enumerable property once. Symbol-keyed
    // properties are deliberately dropped: they are not JSON, they cannot be
    // named by a scanner, and nothing downstream reads them.
    for (const [key, entry] of Object.entries(value)) {
      const cloned = cloneJsonValue(entry, `${path}.${key}`, depth + 1);
      // `defineProperty`, not assignment: an own `__proto__` key (which
      // `JSON.parse` produces, so an agent argument can carry one) would
      // otherwise hit `Object.prototype`'s setter — silently dropping the key
      // AND swapping the copy's prototype for cloned input. This keeps the
      // copy exactly what was validated.
      Object.defineProperty(copy, key, {
        value: cloned,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  }
  fail(
    `${path} must be JSON data (got ${Object.prototype.toString.call(value)})`,
  );
}

function assertIdentifier(
  value: unknown,
  path: string,
  maxLength = IDENTIFIER_MAX_LENGTH,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail(`${path} must be at most ${maxLength} characters`);
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) fail(`${path} contains a control character`);
  }
  return value;
}

function normalizeCapability(
  value: unknown,
): WebMcpCapabilityDeclaration | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail('capability must be an object literal');
  assertNoUnknownKeys(value, CAPABILITY_KEYS, 'capability');
  const { effect, idempotent, openWorld } = value;
  if (effect !== undefined && !WEBMCP_TOOL_EFFECTS.includes(effect as never)) {
    fail(`capability.effect must be one of ${WEBMCP_TOOL_EFFECTS.join(', ')}`);
  }
  if (idempotent !== undefined && typeof idempotent !== 'boolean') {
    fail('capability.idempotent must be a boolean');
  }
  if (openWorld !== undefined && typeof openWorld !== 'boolean') {
    fail('capability.openWorld must be a boolean');
  }
  return {
    ...(effect === undefined ? {} : { effect: effect as never }),
    ...(idempotent === undefined ? {} : { idempotent }),
    ...(openWorld === undefined ? {} : { openWorld }),
  };
}

function normalizeTarget(value: unknown): ViewIntentTarget {
  if (!isPlainObject(value)) fail('target must be an object literal');
  const registry = value.registry;
  if (registry === 'control') {
    assertNoUnknownKeys(value, CONTROL_TARGET_KEYS, 'target');
    const action = value.action;
    if (!VIEW_INTENT_CONTROL_ACTIONS.includes(action as never)) {
      fail(
        `target.action must be one of ${VIEW_INTENT_CONTROL_ACTIONS.join(', ')}`,
      );
    }
    return {
      registry: 'control',
      action: action as ViewIntentControlAction,
      ...(value.formId === undefined
        ? {}
        : { formId: assertIdentifier(value.formId, 'target.formId') }),
      ...(value.controlId === undefined
        ? {}
        : { controlId: assertIdentifier(value.controlId, 'target.controlId') }),
    };
  }
  if (registry === 'dataSurface') {
    assertNoUnknownKeys(value, DATA_SURFACE_TARGET_KEYS, 'target');
    if (
      value.kind !== undefined &&
      !VIEW_INTENT_DATA_SURFACE_KINDS.includes(value.kind as never)
    ) {
      fail(
        `target.kind must be one of ${VIEW_INTENT_DATA_SURFACE_KINDS.join(', ')}`,
      );
    }
    return {
      registry: 'dataSurface',
      controlId: assertIdentifier(value.controlId, 'target.controlId'),
      ...(value.surfaceId === undefined
        ? {}
        : { surfaceId: assertIdentifier(value.surfaceId, 'target.surfaceId') }),
      ...(value.kind === undefined
        ? {}
        : { kind: value.kind as ViewIntentDataSurfaceKind }),
    };
  }
  fail("target.registry must be 'control' or 'dataSurface'");
}

/** Derive the WebMCP tool name for an intent id. */
export function viewIntentToolName(id: string): string {
  return id.replace(/[.-]/g, '_');
}

// ---------------------------------------------------------------------------
// The declaration registry
// ---------------------------------------------------------------------------

const REGISTRY_KEY = Symbol.for('@happyvertical/smrt-web:view-intents');

interface ViewIntentRegistryState {
  intents: Map<string, ViewIntent>;
}

function registryState(): ViewIntentRegistryState {
  // A `globalThis` singleton, matching `ObjectRegistry` in smrt-core, so the
  // registry survives HMR and duplicate module instances in a dev bundle.
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY] as ViewIntentRegistryState | undefined;
  if (existing) return existing;
  const created: ViewIntentRegistryState = { intents: new Map() };
  host[REGISTRY_KEY] = created;
  return created;
}

/**
 * Declare a view intent.
 *
 * Call this at MODULE SCOPE with a single object literal — no spreads, no
 * conditionals, no computed values — in a `.ts` module, conventionally a
 * `Foo.intents.ts` sidecar beside the component that binds it. That form is
 * the contract #2591's scanner matcher reads without evaluating the module.
 *
 * The returned intent is deeply frozen and registered under its `id`. A
 * byte-identical re-declaration returns the SAME frozen object. A
 * re-declaration that differs REPLACES the previous one and warns: editing a
 * sidecar is what an HMR update is for, and throwing there would break the
 * single most common dev action on these files. Two genuinely different
 * intents sharing an id is an authoring mistake the warning surfaces, and one
 * #2591's scanner catches statically, where both declarations are visible at
 * once.
 *
 * @throws if the declaration is not static JSON data, carries an unknown
 * key, carries a function anywhere, names a reserved tool namespace, or
 * derives a WebMCP tool name another intent already derives.
 */
export function defineIntent(declaration: ViewIntentDeclaration): ViewIntent {
  if (!isPlainObject(declaration)) {
    fail('defineIntent expects an object literal');
  }
  // `Object.keys` invokes no getter, so the allowlist check is safe to run on
  // the caller's object and gives the clearest message for a smuggled key.
  assertNoUnknownKeys(declaration, DECLARATION_KEYS, 'declaration');
  // Validate AND copy before any field-specific check, so a smuggled callable
  // is rejected wherever it sits — including inside `inputSchema` or `target`
  // — and every check below reads the copy rather than re-reading a property
  // that could answer differently the second time.
  const source = cloneJsonValue(declaration, 'declaration') as Record<
    string,
    unknown
  >;
  assertNoUnknownKeys(source, DECLARATION_KEYS, 'declaration');

  const id = assertIdentifier(source.id, 'id', INTENT_ID_MAX_LENGTH);
  if (!INTENT_ID_PATTERN.test(id)) {
    fail(
      `id '${id}' must be lowercase and namespaced with at least one dot, e.g. 'orders.filter_by_status'`,
    );
  }
  if (viewIntentToolName(id).startsWith(RESERVED_TOOL_NAME_PREFIX)) {
    fail(
      `id '${id}' resolves into the reserved '${RESERVED_TOOL_NAME_PREFIX}' namespace of the six fixed UI tools`,
    );
  }
  const description = assertIdentifier(
    source.description,
    'description',
    DESCRIPTION_MAX_LENGTH,
  );
  if (source.inputSchema !== undefined && !isPlainObject(source.inputSchema)) {
    fail('inputSchema must be an object literal');
  }

  const intent: ViewIntent = deepFreeze({
    kind: 'intent',
    id,
    description,
    inputSchema: (source.inputSchema ?? {
      type: 'object',
      properties: {},
    }) as Record<string, unknown>,
    classification: resolveDeclaredCapability(
      normalizeCapability(source.capability) ?? {},
    ),
    target: normalizeTarget(source.target),
    planes: ['browser'] as const,
  });

  const state = registryState();
  // `viewIntentToolName` is not injective — `orders.foo_bar` and
  // `orders.foo.bar` both flatten to `orders_foo_bar` — and two intents that
  // collide there would fight over one WebMCP tool name at mount, where the
  // failure is a shadowed or rejected registration rather than a clear error.
  // Reject the second declaration instead, at the only place both are visible.
  const toolName = viewIntentToolName(id);
  for (const other of state.intents.values()) {
    if (other.id !== id && viewIntentToolName(other.id) === toolName) {
      fail(
        `id '${id}' derives the WebMCP tool name '${toolName}', which intent '${other.id}' already derives`,
      );
    }
  }
  const existing = state.intents.get(id);
  if (existing) {
    if (JSON.stringify(existing) === JSON.stringify(intent)) return existing;
    // biome-ignore lint/suspicious/noConsole: smrt-web has no logger dep (TanStack-only); a replaced intent declaration surfaces via console.warn by design (#2588)
    console.warn(
      `[smrt-web] view intent '${id}' was re-declared with a different definition; replacing it. In development this is an HMR update. In a built application it means two declarations share one id.`,
    );
  }
  state.intents.set(id, intent);
  return intent;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Every intent declared in modules loaded so far, in declaration order. */
export function listViewIntents(): readonly ViewIntent[] {
  return [...registryState().intents.values()];
}

/**
 * Look up a declared intent by id.
 *
 * Directly usable as `smrt-playbooks`' `PlaybookIntentResolver` seam (#2589):
 * a {@link ViewIntent} satisfies its `PlaybookIntentRecord` shape, so an
 * intent step inherits this intent's classification and browser-only plane
 * validity rather than classifying itself.
 */
export function resolveViewIntent(id: string): ViewIntent | undefined {
  return registryState().intents.get(id);
}

/**
 * Drop every declared intent. For tests and HMR teardown; production code
 * has no reason to call it.
 */
export function clearViewIntentRegistry(): void {
  registryState().intents.clear();
}

// ---------------------------------------------------------------------------
// Compilation to a bespoke tool spec
// ---------------------------------------------------------------------------

/**
 * The `ControlInteractionRegistry` surface an intent uses. Declared
 * structurally so this package takes no dependency on
 * `@happyvertical/smrt-ui`; the real registry satisfies it.
 */
export interface ViewIntentControlRegistryPort {
  execute(
    command: {
      action: ViewIntentControlAction;
      identity: ViewIntentControlIdentity;
      value?: unknown;
      durationMs?: number;
      revision?: number;
    },
    context?: { source: 'agent' },
  ): Promise<{ ok: boolean; reason?: string }>;
}

/** A mounted control's full registry key, subject included. */
export interface ViewIntentControlIdentity {
  formId: string;
  controlId: string;
  subject?: ViewIntentSubject;
}

/** A mounted data surface's full registry key, subject included. */
export interface ViewIntentDataSurfaceIdentity {
  surfaceId: string;
  kind: ViewIntentDataSurfaceKind;
  subject?: ViewIntentSubject;
}

/** The `DataSurfaceRegistry` surface an intent uses. */
export interface ViewIntentDataSurfaceRegistryPort {
  inspect(
    identity: ViewIntentDataSurfaceIdentity,
  ): { revision: number } | undefined;
  execute(command: {
    version: 1;
    commandId: string;
    identity: ViewIntentDataSurfaceIdentity;
    expectedRevision: number;
    controlId: string;
    payload?: unknown;
  }): Promise<{ ok: boolean; revision?: number; reason?: string }>;
}

/** The mounted identity a binding supplies for an intent's lifetime. */
export type ViewIntentBinding =
  | {
      registry: 'control';
      registryPort: ViewIntentControlRegistryPort;
      identity: ViewIntentControlIdentity;
    }
  | {
      registry: 'dataSurface';
      registryPort: ViewIntentDataSurfaceRegistryPort;
      identity: ViewIntentDataSurfaceIdentity;
    };

/**
 * A bespoke tool spec, structurally identical to
 * `WebMcpBespokeToolSpec` in `./webmcp.js`. Declared here rather than
 * imported so this module stays free of even a type edge to the registrar
 * entry.
 */
export interface ViewIntentToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: WebMcpCapabilityAnnotations;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Reasons an intent may report back to an agent. Anything else collapses to
 * `denied`, so a registry's internal reason never leaks through a tool
 * result. Mirrors the allowlist the fixed `smrt_ui_*` tools apply.
 */
const PUBLIC_REASONS = new Set([
  'not_found',
  'unsupported',
  'consent_required',
  'human_confirmation_required',
  'sensitive_control',
  'control_not_writable',
  'control_not_editable',
  'nothing_to_undo',
  'stale_revision',
  'idempotency_conflict',
  'non_monotonic_revision',
  'invalid_request',
  'denied',
]);

function publicReason(reason: unknown): string {
  return typeof reason === 'string' && PUBLIC_REASONS.has(reason)
    ? reason
    : 'denied';
}

function ok(result: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...result });
}

function denied(reason: string): string {
  return JSON.stringify({ ok: false, reason });
}

/**
 * WebMCP hands `execute` whatever the agent sent. Anything that is not a plain
 * object becomes an empty argument set, so a string or array argument fails
 * closed through the normal `invalid_request` path instead of throwing a
 * TypeError out of an `in` check.
 */
function toolArguments(args: unknown): Record<string, unknown> {
  return isPlainObject(args) ? args : {};
}

let commandCounter = 0;

function newCommandId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (typeof cryptoLike?.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  commandCounter += 1;
  return `intent-${Date.now().toString(36)}-${commandCounter}`;
}

class IntentArgumentError extends Error {}

/**
 * Validate one agent-supplied argument and return a JSON copy of it. Copying
 * closes the same time-of-check gap `cloneJsonValue` closes for declarations:
 * the value handed to a registry command is the one that was validated, not
 * whatever a getter answers on the next read.
 */
function jsonArg(args: Record<string, unknown>, key: string): unknown {
  try {
    return cloneJsonValue(args[key], key);
  } catch {
    throw new IntentArgumentError(key);
  }
}

/**
 * Read `revision` ONCE and keep the value that was type-checked, so a
 * two-faced getter cannot pass the `number` check and then land something
 * else on the command.
 */
function optionalRevision(args: Record<string, unknown>): {
  revision?: number;
} {
  const revision = args.revision;
  return typeof revision === 'number' && Number.isFinite(revision)
    ? { revision }
    : {};
}

/**
 * Collapse anything thrown on the execution path to an allowlisted reason.
 *
 * A registry does not only RETURN a rejection — `DataSurfaceRegistry` throws
 * for a payload that is too deep, too large, or carries a forbidden or
 * prototype-pollution key, and any registry can throw from a host handler. An
 * uncaught throw would escape both the `{ ok, reason }` contract and the
 * {@link publicReason} allowlist, handing the agent a raw internal message.
 * The six fixed `smrt_ui_*` tools guard the same way (`executeSafely` in
 * smrt-svelte's `webmcp-ui.ts`), collapsing anything unrecognized rather than
 * letting it out.
 */
function intentErrorReason(error: unknown): string {
  return error instanceof IntentArgumentError ? 'invalid_request' : 'denied';
}

function buildControlCommand(
  target: ViewIntentControlTarget,
  identity: ViewIntentControlIdentity,
  args: Record<string, unknown>,
): Parameters<ViewIntentControlRegistryPort['execute']>[0] {
  const base = { action: target.action, identity };
  switch (target.action) {
    case 'highlight': {
      const durationMs = args.durationMs;
      if (durationMs !== undefined) {
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
          throw new IntentArgumentError('durationMs');
        }
        return { ...base, durationMs };
      }
      return base;
    }
    case 'stage':
      if (!('value' in args)) throw new IntentArgumentError('value');
      return { ...base, value: jsonArg(args, 'value') };
    case 'apply':
      // `reviewedValueIsCanonical` is deliberately never set from intent
      // arguments: it is the staged-review surface's own marker, and an
      // agent-driven intent must not be able to claim a human review.
      return {
        ...base,
        ...('value' in args ? { value: jsonArg(args, 'value') } : {}),
        ...optionalRevision(args),
      };
    case 'discard':
      return { ...base, ...optionalRevision(args) };
    default:
      return base;
  }
}

/**
 * Compile a declared intent plus a mounted binding into a bespoke tool spec.
 *
 * The `execute` this returns is built here from `intent.target`; nothing an
 * author wrote is called. It dispatches exactly one registry command with
 * `source: 'agent'`, so every policy the registry enforces — staged review,
 * local-gesture proof, sensitivity, writability — applies unchanged.
 *
 * @throws if the binding does not match the intent's declared target.
 */
export function compileViewIntentToolSpec(
  intent: ViewIntent,
  binding: ViewIntentBinding,
): ViewIntentToolSpec {
  if (binding.registry !== intent.target.registry) {
    throw new Error(
      `[smrt-web] intent '${intent.id}' targets the ${intent.target.registry} registry but was bound to ${binding.registry}`,
    );
  }

  const spec = {
    name: viewIntentToolName(intent.id),
    description: intent.description,
    inputSchema: intent.inputSchema,
    annotations: capabilityDeclarationHints(intent.classification),
  };

  if (binding.registry === 'control' && intent.target.registry === 'control') {
    const target = intent.target;
    const identity = binding.identity;
    assertBoundIdentity(intent.id, 'formId', target.formId, identity.formId);
    assertBoundIdentity(
      intent.id,
      'controlId',
      target.controlId,
      identity.controlId,
    );
    const registry = binding.registryPort;
    return {
      ...spec,
      execute: async (args) => {
        try {
          const command = buildControlCommand(
            target,
            identity,
            toolArguments(args),
          );
          const result = await registry.execute(command, { source: 'agent' });
          return result.ok
            ? ok({ action: target.action, identity })
            : denied(publicReason(result.reason));
        } catch (error) {
          return denied(intentErrorReason(error));
        }
      },
    };
  }

  if (
    binding.registry === 'dataSurface' &&
    intent.target.registry === 'dataSurface'
  ) {
    const target = intent.target;
    const identity = binding.identity;
    assertBoundIdentity(
      intent.id,
      'surfaceId',
      target.surfaceId,
      identity.surfaceId,
    );
    assertBoundIdentity(intent.id, 'kind', target.kind, identity.kind);
    const registry = binding.registryPort;
    return {
      ...spec,
      execute: async (args) => {
        try {
          const input = toolArguments(args);
          const payload =
            'payload' in input ? jsonArg(input, 'payload') : undefined;
          const snapshot = registry.inspect(identity);
          if (!snapshot) return denied('not_found');
          const result = await registry.execute({
            version: 1,
            commandId: newCommandId(),
            identity,
            expectedRevision: snapshot.revision,
            controlId: target.controlId,
            ...(payload === undefined ? {} : { payload }),
          });
          return result.ok
            ? ok({
                controlId: target.controlId,
                identity,
                ...(result.revision === undefined
                  ? {}
                  : { revision: result.revision }),
              })
            : denied(publicReason(result.reason));
        } catch (error) {
          return denied(intentErrorReason(error));
        }
      },
    };
  }

  /* c8 ignore next 3 -- unreachable: registry equality is checked above */
  throw new Error(
    `[smrt-web] intent '${intent.id}' could not be compiled for its binding`,
  );
}

function assertBoundIdentity(
  id: string,
  field: string,
  declared: string | undefined,
  bound: string,
): void {
  if (declared !== undefined && declared !== bound) {
    throw new Error(
      `[smrt-web] intent '${id}' declares ${field} '${declared}' but was bound to '${bound}'`,
    );
  }
}
