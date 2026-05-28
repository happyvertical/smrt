/**
 * Resource-list handler for `GET /api/_resources`.
 *
 * Returns the auth-aware list of resources and commands that an HTTP-based
 * CLI client (e.g. `@happyvertical/smrt-app-cli`) can invoke. Walks the
 * `ObjectRegistry` to find classes whose `@smrt({ cli: ... })` decorator
 * exposes commands, resolves each command's URL shape (scope, http method,
 * path segments) the same way the SvelteKit route generator does, and
 * filters the result through a caller-supplied `commandPolicy`.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // apps/<app>/src/routes/api/_resources/+server.ts
 * import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
 * import './smrt-register';
 *
 * export const GET = createResourceListHandler({
 *   ensureRegistry: async () => { await import('./smrt-register'); },
 *   commandPolicy: ({ command, session }) => session.user != null,
 *   kebabRoutes: true, // match the vite-plugin setting
 * });
 * ```
 */

// Importing the registration shim here keeps this subpath self-sufficient
// (mirrors the pattern in `./index.ts`).
import '../__smrt-register__.js';

import {
  ObjectRegistry,
  type SmartObjectConfig,
} from '@happyvertical/smrt-core';
import { classnameToTablename } from '@happyvertical/smrt-core/utils';
import {
  methodNameToKebab,
  resolveApiActionSet,
} from '@happyvertical/smrt-core/vite-plugin';
import type { TerminalAuthServiceOptions } from '../services/TerminalAuthService.js';
import { loadBearerSessionContext, parseBearerToken } from './index.js';
import type { SessionLocals } from './types.js';

/** Shape returned by `ObjectRegistry.getAllClasses()` values. Mirrors the
 * relevant parts of `RegisteredClass` from `@happyvertical/smrt-core/registry/types`.
 * Kept structural so we don't depend on a non-public type export. */
interface RegisteredClassLike {
  name: string;
  qualifiedName?: string;
  packageName?: string;
  config: SmartObjectConfig;
  methods: Map<string, unknown>;
  tools?: ToolLike[];
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Types                                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

const STANDARD_API_ACTIONS = [
  'list',
  'get',
  'create',
  'update',
  'delete',
] as const;

type StandardApiAction = (typeof STANDARD_API_ACTIONS)[number];
type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type CommandKind = 'crud' | 'custom';
export type CommandScope = 'item' | 'collection';

export interface CommandDefinition {
  /** Method name in source casing — source of truth for HTTP routing. */
  methodName: string;
  /** Kebab-case identifier used by the CLI argv parser. */
  commandName: string;
  kind: CommandKind;
  scope: CommandScope;
  httpMethod: ApiHttpMethod;
  /** URL path segments after `/<apiPath>[/<id>]/`. May be empty. */
  pathSegments: string[];
  description?: string;
  /** JSONSchema describing the command's argv-flag surface. */
  parameters?: Record<string, unknown>;
}

export interface CliResource {
  /** Kebab-case identifier; the first positional argument after the CLI name. */
  slug: string;
  className: string;
  qualifiedName?: string;
  packageName?: string;
  label: string;
  /** Collection segment, no leading slash, no `/api` prefix. */
  apiPath: string;
  commands: CommandDefinition[];
}

export interface ResolvedSession {
  user: SessionLocals['user'];
  permissions: string[];
  tenantId: string | null;
  sessionId: string | null;
}

export interface CommandPolicyContext {
  resource: Omit<CliResource, 'commands'>;
  command: CommandDefinition;
  session: ResolvedSession;
  /**
   * Stable identifiers for policy authors that need more than the
   * caller-facing `resource` view (e.g. package-scoped role checks).
   */
  classMeta: {
    name: string;
    qualifiedName?: string;
    packageName?: string;
    decoratorConfig: SmartObjectConfig;
  };
}

export interface ResourceListResponseBody {
  user: { authenticated: boolean; id?: string };
  warnings: string[];
  resources: CliResource[];
}

/**
 * Per-command lint warning emitted by the handler when a method couldn't be
 * surfaced as a command (dynamic path params, DELETE-with-body, multi-arg,
 * etc.). Filtered through `commandPolicy` so callers only see warnings for
 * commands they would have been allowed to invoke.
 */
interface SkipWarning {
  /** The class/method this warning pertains to (`Praeco.discover`). */
  ref: string;
  /** Human-readable reason: `dynamic-path-params unsupported` etc. */
  reason: string;
  /** Candidate command — used by policy to decide visibility. */
  candidate: CommandDefinition;
  /** The owning class for visibility scoping. */
  resourceMeta: Omit<CliResource, 'commands'>;
  classMeta: CommandPolicyContext['classMeta'];
}

export interface CreateResourceListHandlerOptions
  extends TerminalAuthServiceOptions {
  /**
   * Ensures `ObjectRegistry` is populated before the handler walks it.
   *
   * v0.1 escape hatch: the consumer app must trigger its `@smrt()` side
   * effects (typically by importing the generated `smrt-register.ts`).
   * Without this, a fresh request handler process may see an empty
   * registry and return zero resources.
   */
  ensureRegistry: () => void | Promise<void>;

  /**
   * Resolve the caller's session. Defaults to `event.locals` (set by
   * `createSessionHandler` in `hooks.server.ts`) with a `Bearer <token>`
   * fallback for terminal-auth CLI clients.
   *
   * If a bearer token is present but doesn't resolve to a live session,
   * the handler responds 401 — NOT silent anonymous, so a stale CLI token
   * gets a clear signal to re-authenticate.
   */
  resolveSession?: (event: SveltekitEvent) => Promise<ResolvedSession>;

  /**
   * Per-command permission filter. Default: deny everything when the
   * caller is anonymous; allow everything when authenticated.
   *
   * Note: this is _capability filtering_, not row-level authorization.
   * Per-route handlers remain authoritative for `can user X update record Y`.
   */
  commandPolicy?: (ctx: CommandPolicyContext) => boolean | Promise<boolean>;

  /**
   * Override the slug derivation. Default: kebab-case of `collection`
   * (which is already plural+lowercase from the manifest generator).
   */
  resourceSlug?: (meta: {
    className: string;
    collection: string;
    qualifiedName?: string;
    packageName?: string;
  }) => string;

  /**
   * Match the vite plugin's `svelteKit.kebabRoutes` setting. When `true`,
   * custom method URL segments are kebab-cased on the wire (the CLI sends
   * `/discover-from-url`); when `false`, source-cased (`/discoverFromUrl`).
   * Defaults to `false` to match the vite plugin default.
   */
  kebabRoutes?: boolean;
}

type SveltekitEvent = {
  cookies: { get: (name: string) => string | undefined };
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Public factory                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export function createResourceListHandler(
  options: CreateResourceListHandlerOptions,
): (event: SveltekitEvent) => Promise<Response> {
  const {
    ensureRegistry,
    resolveSession = (event) => defaultResolveSession(event, options),
    commandPolicy = defaultCommandPolicy,
    resourceSlug = defaultResourceSlug,
    kebabRoutes = false,
  } = options;

  return async (event: SveltekitEvent): Promise<Response> => {
    await ensureRegistry();

    let session: ResolvedSession;
    try {
      session = await resolveSession(event);
    } catch (error) {
      if (error instanceof InvalidBearerError) {
        return jsonResponse({ error: error.message }, 401);
      }
      throw error;
    }

    const resources: CliResource[] = [];
    const skipWarnings: SkipWarning[] = [];
    const slugSeen = new Map<string, string>();

    for (const [registeredName, registered] of ObjectRegistry.getAllClasses()) {
      const def = synthesizeDefinition(
        registeredName,
        registered as unknown as RegisteredClassLike,
      );
      const cliConfig = def.decoratorConfig.cli;
      if (!cliConfig) continue;

      // Resolve included method set per v4 rules.
      // resolveApiActionSet only reads decoratorConfig + methods; cast is safe.
      const apiActionSet = resolveApiActionSet(
        def as unknown as Parameters<typeof resolveApiActionSet>[0],
      );
      const includedMethods = resolveCliIncludedMethods(
        cliConfig,
        apiActionSet,
      );
      if (includedMethods.length === 0) continue;

      // Compute the resource shell first; commands are derived from it.
      const slug = resourceSlug({
        className: def.className,
        collection: def.collection,
        qualifiedName: def.qualifiedName,
        packageName: def.packageName,
      });
      const previous = slugSeen.get(slug);
      if (previous && previous !== def.qualifiedName) {
        return jsonResponse(
          {
            error: 'resource-slug-collision',
            slug,
            classes: [previous, def.qualifiedName ?? def.className].filter(
              Boolean,
            ),
          },
          500,
        );
      }
      slugSeen.set(slug, def.qualifiedName ?? def.className);

      const resourceShell: Omit<CliResource, 'commands'> = {
        slug,
        className: def.className,
        qualifiedName: def.qualifiedName,
        packageName: def.packageName,
        label: humanLabel(def.className),
        apiPath: resolveApiPath(def),
      };

      const classMeta: CommandPolicyContext['classMeta'] = {
        name: def.className,
        qualifiedName: def.qualifiedName,
        packageName: def.packageName,
        decoratorConfig: def.decoratorConfig,
      };

      // Build candidate commands + collect skip warnings.
      // `commandNameSeen` is empty at start; CRUD commands populate it as
      // they're built. Custom commands that kebab to a CRUD name are caught
      // by the explicit CRUD-shadowing check below before they get here.
      const commandNameSeen = new Set<string>();
      const candidates: CommandDefinition[] = [];

      for (const methodName of includedMethods) {
        const result = buildCommand(def, methodName, kebabRoutes);
        if (!result.ok) {
          skipWarnings.push({
            ref: `${def.className}.${methodName}`,
            reason: result.reason,
            candidate: result.candidate,
            resourceMeta: resourceShell,
            classMeta,
          });
          continue;
        }

        // Detect kebab collisions and CRUD shadowing inside this class.
        if (
          result.command.kind === 'custom' &&
          STANDARD_API_ACTIONS.includes(
            result.command.commandName as StandardApiAction,
          )
        ) {
          return jsonResponse(
            {
              error: 'command-name-shadows-crud',
              className: def.className,
              methodName,
              commandName: result.command.commandName,
            },
            500,
          );
        }
        if (commandNameSeen.has(result.command.commandName)) {
          return jsonResponse(
            {
              error: 'command-name-collision',
              className: def.className,
              commandName: result.command.commandName,
            },
            500,
          );
        }
        commandNameSeen.add(result.command.commandName);
        candidates.push(result.command);
      }

      // Run the command policy.
      const allowed: CommandDefinition[] = [];
      for (const candidate of candidates) {
        const ok = await commandPolicy({
          resource: resourceShell,
          command: candidate,
          session,
          classMeta,
        });
        if (ok) allowed.push(candidate);
      }
      if (allowed.length === 0) continue;

      resources.push({ ...resourceShell, commands: allowed });
    }

    // Filter warnings through policy: only surface warnings the caller could
    // have seen the underlying command for.
    const visibleWarnings: string[] = [];
    for (const w of skipWarnings) {
      const ok = await commandPolicy({
        resource: w.resourceMeta,
        command: w.candidate,
        session,
        classMeta: w.classMeta,
      });
      if (ok) visibleWarnings.push(`${w.ref}: ${w.reason}`);
    }

    const body: ResourceListResponseBody = {
      user: session.user
        ? { authenticated: true, id: String(session.user.id ?? '') }
        : { authenticated: false },
      warnings: visibleWarnings,
      resources,
    };

    return jsonResponse(body, 200, {
      'cache-control': 'private, no-store',
    });
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers — synthesis                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Shape we feed into `resolveApiActionSet`. Mirrors the relevant parts of
 * `SmartObjectDefinition` from `@happyvertical/smrt-core/scanner` so we
 * can compute the API set against runtime-registered classes (which the
 * registry stores as `RegisteredClass`, not as `SmartObjectDefinition`).
 */
interface SynthesizedDefinition {
  className: string;
  qualifiedName?: string;
  packageName?: string;
  collection: string;
  decoratorConfig: SmartObjectConfig;
  methods: Record<string, MethodLike>;
  tools?: ToolLike[];
}

interface MethodLike {
  name: string;
  isStatic?: boolean;
  isPublic?: boolean;
  parameters?: Array<{ name: string; type: string; optional?: boolean }>;
  returnType?: string;
  description?: string;
}

interface ToolLike {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function synthesizeDefinition(
  _registeredName: string,
  registered: RegisteredClassLike,
): SynthesizedDefinition {
  const methods: Record<string, MethodLike> = {};
  for (const [name, value] of registered.methods.entries()) {
    methods[name] = value as MethodLike;
  }

  const decoratorConfig = (registered.config ?? {}) as SmartObjectConfig;
  const collection =
    deriveCollectionFromConfig(decoratorConfig) ??
    classnameToTablename(registered.name);

  return {
    className: registered.name,
    qualifiedName: registered.qualifiedName,
    packageName: registered.packageName,
    collection,
    decoratorConfig,
    methods,
    tools: registered.tools as ToolLike[] | undefined,
  };
}

function deriveCollectionFromConfig(
  config: SmartObjectConfig,
): string | undefined {
  // `tableName` doubles as the collection-path source in the generator.
  return config?.tableName ?? undefined;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers — command resolution                                               */
/* ────────────────────────────────────────────────────────────────────────── */

function resolveCliIncludedMethods(
  cliConfig: NonNullable<SmartObjectConfig['cli']>,
  apiActionSet: Set<string>,
): string[] {
  if (cliConfig === true) {
    // Boolean shorthand: CRUD only (intersected with what the API exposes).
    return STANDARD_API_ACTIONS.filter((a) => apiActionSet.has(a));
  }
  if (cliConfig === false) return [];

  const obj = cliConfig as {
    include?: string[];
    exclude?: string[];
    mirror?: 'api';
  };
  let candidates: string[];

  if (obj.mirror === 'api') {
    candidates = [...apiActionSet];
  } else if (obj.include?.includes('*')) {
    candidates = [...apiActionSet];
  } else if (obj.include && obj.include.length > 0) {
    candidates = obj.include.filter((m) => apiActionSet.has(m));
  } else {
    // No include + no mirror → CRUD only.
    candidates = STANDARD_API_ACTIONS.filter((a) => apiActionSet.has(a));
  }

  if (obj.exclude && obj.exclude.length > 0) {
    const excludeSet = new Set(obj.exclude);
    candidates = candidates.filter((m) => !excludeSet.has(m));
  }
  return candidates;
}

interface BuildSuccess {
  ok: true;
  command: CommandDefinition;
}
interface BuildSkip {
  ok: false;
  reason: string;
  candidate: CommandDefinition;
}

function buildCommand(
  def: SynthesizedDefinition,
  methodName: string,
  kebabRoutes: boolean,
): BuildSuccess | BuildSkip {
  const isCrud = STANDARD_API_ACTIONS.includes(methodName as StandardApiAction);

  if (isCrud) {
    return {
      ok: true,
      command: buildCrudCommand(methodName as StandardApiAction),
    };
  }

  const methodDef = def.methods[methodName];
  if (!methodDef) {
    // Manifest doesn't know this method — fall through anyway so the user
    // sees something coherent rather than silently dropping it.
    return {
      ok: true,
      command: buildCustomCommand(def, methodName, undefined, kebabRoutes),
    };
  }

  // Multi-arg: skip with warning. v0.1 only supports single-options-object.
  const paramCount = methodDef.parameters?.length ?? 0;
  if (paramCount > 1) {
    return {
      ok: false,
      reason: 'multi-arg unsupported (use single-options-object convention)',
      candidate: buildCustomCommand(def, methodName, methodDef, kebabRoutes),
    };
  }

  const candidate = buildCustomCommand(def, methodName, methodDef, kebabRoutes);

  // Dynamic path-param segments (`[id]`, `:foo`) → unsupported in v0.1.
  if (hasDynamicSegments(candidate.pathSegments)) {
    return {
      ok: false,
      reason: 'dynamic-path-params unsupported',
      candidate,
    };
  }

  // DELETE-with-body — skip. DELETE is OK for `<col>/<id>` (id from positional),
  // but a custom DELETE method that accepts a body is too fragile through
  // proxies/frameworks. Detect by either a non-empty schema OR a methodDef
  // that takes any parameters at all.
  if (candidate.httpMethod === 'DELETE' && candidate.kind === 'custom') {
    const methodHasParams = (methodDef.parameters?.length ?? 0) > 0;
    if (methodHasParams || hasNonIdParameters(candidate.parameters)) {
      return {
        ok: false,
        reason: 'DELETE-with-body unsupported',
        candidate,
      };
    }
  }

  return { ok: true, command: candidate };
}

function buildCrudCommand(name: StandardApiAction): CommandDefinition {
  const item = name === 'get' || name === 'update' || name === 'delete';
  const httpMethod: ApiHttpMethod =
    name === 'list' || name === 'get'
      ? 'GET'
      : name === 'create'
        ? 'POST'
        : name === 'update'
          ? 'PUT'
          : 'DELETE';

  return {
    methodName: name,
    commandName: name,
    kind: 'crud',
    scope: item ? 'item' : 'collection',
    httpMethod,
    pathSegments: [],
    description: defaultCrudDescription(name),
  };
}

function buildCustomCommand(
  def: SynthesizedDefinition,
  methodName: string,
  methodDef: MethodLike | undefined,
  kebabRoutes: boolean,
): CommandDefinition {
  const apiConfigObj = getApiConfigObject(def.decoratorConfig.api);
  const routeConfig = apiConfigObj?.routes?.[methodName] as
    | { scope?: CommandScope; method?: string; path?: string }
    | undefined;

  const defaultScope: CommandScope = methodDef?.isStatic
    ? 'collection'
    : 'item';
  const scope = routeConfig?.scope ?? defaultScope;
  const httpMethod = normalizeApiHttpMethod(routeConfig?.method);

  let pathSegments: string[];
  if (routeConfig?.path) {
    // Explicit override — used verbatim, no kebab transform.
    pathSegments = routeConfig.path
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pathSegments.length === 0) pathSegments = [methodName];
  } else {
    pathSegments = [kebabRoutes ? methodNameToKebab(methodName) : methodName];
  }

  const parameters = resolveParametersSchema(def, methodName, methodDef);

  return {
    methodName,
    commandName: methodNameToKebab(methodName),
    kind: 'custom',
    scope,
    httpMethod,
    pathSegments,
    description: methodDef?.description,
    parameters,
  };
}

function resolveParametersSchema(
  def: SynthesizedDefinition,
  methodName: string,
  methodDef: MethodLike | undefined,
): Record<string, unknown> | undefined {
  // 1. Prefer the tool JSONSchema (build-time generated by `smrt scan`).
  const tool = def.tools?.find((t) => t.function.name === methodName);
  if (tool?.function.parameters) return tool.function.parameters;

  // 2. Fall back to inferring from the single `options: { ... }` parameter.
  const param0 = methodDef?.parameters?.[0];
  if (param0 && /^\s*\{/.test(param0.type)) {
    // Crude shape — the CLI will detect this as "complex schema" and fall
    // back to the positional JSON payload escape hatch.
    return { type: 'object', additionalProperties: true };
  }

  // 3. No schema available — flag to CLI to use positional JSON.
  return undefined;
}

function normalizeApiHttpMethod(method?: string): ApiHttpMethod {
  switch (method?.toUpperCase()) {
    case 'GET':
    case 'POST':
    case 'PUT':
    case 'PATCH':
    case 'DELETE':
      return method.toUpperCase() as ApiHttpMethod;
    default:
      return 'POST';
  }
}

function getApiConfigObject(
  api: SmartObjectConfig['api'],
): { routes?: Record<string, unknown> } | undefined {
  if (typeof api !== 'object' || api === null) return undefined;
  return api as { routes?: Record<string, unknown> };
}

function hasDynamicSegments(segments: string[]): boolean {
  return segments.some((s) => /^\[.+\]$/.test(s) || s.startsWith(':'));
}

function hasNonIdParameters(parameters?: Record<string, unknown>): boolean {
  if (!parameters || typeof parameters !== 'object') return false;
  const props = (parameters as { properties?: Record<string, unknown> })
    .properties;
  if (!props) return false;
  const keys = Object.keys(props).filter((k) => k !== 'id');
  return keys.length > 0;
}

function defaultCrudDescription(name: StandardApiAction): string {
  switch (name) {
    case 'list':
      return 'List records';
    case 'get':
      return 'Get a record by id';
    case 'create':
      return 'Create a new record';
    case 'update':
      return 'Update an existing record';
    case 'delete':
      return 'Delete a record';
  }
}

function resolveApiPath(def: SynthesizedDefinition): string {
  const apiCfg = getApiConfigObject(def.decoratorConfig.api);
  const override = (apiCfg as { path?: string } | undefined)?.path;
  if (typeof override === 'string' && override.length > 0) return override;
  return def.collection.replace(/_/g, '-');
}

function defaultResourceSlug(meta: {
  className: string;
  collection: string;
}): string {
  // Collection is already plural+lowercased; just normalise separators.
  return meta.collection.replace(/_/g, '-');
}

function humanLabel(className: string): string {
  // Praeco → Praeco; XMLExport → Xml Export. Cheap default.
  return className
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers — session resolution                                               */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Thrown by the default `resolveSession` when a bearer token is present in
 * the request but doesn't resolve to a live session. The handler catches
 * this and responds 401. Exported so custom `resolveSession` implementations
 * can opt in to the same semantics.
 */
export class InvalidBearerError extends Error {
  constructor(message = 'Invalid or expired bearer token.') {
    super(message);
    this.name = 'InvalidBearerError';
  }
}

async function defaultResolveSession(
  event: SveltekitEvent,
  options: TerminalAuthServiceOptions,
): Promise<ResolvedSession> {
  // 1. Locals win when set (already validated by hooks.server.ts).
  const locals = (event.locals ?? {}) as Partial<SessionLocals>;
  if (locals.user) {
    return {
      user: locals.user,
      permissions: locals.permissions ?? [],
      tenantId: locals.tenantId ?? null,
      sessionId: locals.sessionId ?? null,
    };
  }

  // 2. Bearer-token fallback for terminal-auth CLI clients.
  const bearer = parseBearerToken(event.request.headers.get('authorization'));
  if (bearer) {
    const ctx = await loadBearerSessionContext(bearer, options);
    if (!ctx) {
      // Bearer present but doesn't resolve — fail loud, not silent anonymous.
      throw new InvalidBearerError();
    }
    return {
      user: ctx.user,
      permissions: ctx.permissions,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
    };
  }

  // 3. Truly anonymous.
  return {
    user: null,
    permissions: [],
    tenantId: null,
    sessionId: null,
  };
}

function defaultCommandPolicy(ctx: CommandPolicyContext): boolean {
  return ctx.session.user != null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers — HTTP                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders,
    },
  });
}
