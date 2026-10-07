/**
 * SvelteKit route adapters for an `McpAppServer`. Mirrors the
 * `@happyvertical/smrt-users/sveltekit` pattern: minimal `HandleInput` type
 * so we never need `@sveltejs/kit` as a real dependency.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/+server.ts — one call with the app defaults
 * import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { Item } from '$lib/objects/Item';
 * import { runtime } from '$lib/server/smrt';
 * export const POST = mountMcpAppRoute({
 *   runtime,
 *   models: [Item],
 *   requiredScopes: ['items.read'],
 *   effects: ['read'],
 * });
 * ```
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/+server.ts — a custom server core
 * import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { mcpServer } from '$lib/server/mcp';
 * export const POST = mountMcpRoute(mcpServer);
 * ```
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
} from '@modelcontextprotocol/server';
import type {
  McpDeploymentProfile,
  McpLocalTokenPrincipal,
  McpPrincipalMapping,
  McpResourceAuth,
  McpVerifiedIdentity,
} from './auth.js';
import {
  type CreateDefaultMcpAppServerOptions,
  createDefaultMcpAppServer,
} from './defaults.js';
import {
  MCP_ORIGIN_DENIED_CODE,
  MCP_TOOL_ACCESS_DENIED_CODE,
  McpAccessError,
} from './errors.js';
import {
  createMcpProtocolServerForRequest,
  MCP_TASKS_EXTENSION,
  type McpProtocolRequestOptions,
} from './protocol.js';
import type {
  CallToolInput,
  McpAppPrincipal,
  McpAppServer,
  McpSmrtOptionsThunk,
} from './server.js';

/** Minimal subset of a SvelteKit RequestEvent we actually touch. */
type SvelteKitRequestEvent = {
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

/** A SvelteKit `+server.ts` request handler with no SvelteKit dependency. */
export type McpSvelteKitHandler = (
  event: SvelteKitRequestEvent,
) => Promise<Response>;

type ResolvedRequestPrincipal = {
  principal: McpAppPrincipal | null;
  /** Defined only for the legacy discovery-only authentication adapter. */
  legacyAuthenticated?: boolean;
};

/** Locals reader used to pull the request principal out of `event.locals`. */
export type McpPrincipalResolver = (
  event: SvelteKitRequestEvent,
) => McpAppPrincipal | null | undefined;

/** Backwards-compatible alias for callers that name the principal a user. */
export type McpUserResolver = McpPrincipalResolver;

const defaultResolvePrincipal: McpPrincipalResolver = (event) =>
  (event.locals?.user ?? null) as McpAppPrincipal | null;

function resolveRequestPrincipal(
  event: SvelteKitRequestEvent,
  options: MountMcpRouteOptions,
): ResolvedRequestPrincipal {
  const resolvePrincipal =
    options.resolvePrincipal ?? options.resolveUser ?? defaultResolvePrincipal;
  const principal = resolvePrincipal(event) ?? null;
  // Keep the legacy boolean gate for existing apps, but apply it to the same
  // principal that both routes receive. A new principal resolver supersedes it.
  if (
    !options.resolvePrincipal &&
    options.resolveAuthenticated &&
    !options.resolveAuthenticated(event)
  ) {
    return { principal: null, legacyAuthenticated: false };
  }
  return {
    principal,
    ...(options.resolvePrincipal || !options.resolveAuthenticated
      ? {}
      : { legacyAuthenticated: true }),
  };
}

function listToolsInput(resolved: ResolvedRequestPrincipal) {
  // Before principal-aware routes, `resolveAuthenticated` affected discovery
  // independently of `resolveUser`. Preserve a true legacy result only when
  // there is no principal to pass; new routes should use `resolvePrincipal`
  // for a single identity on both discovery and calls.
  if (!resolved.principal && resolved.legacyAuthenticated) {
    return { authenticated: true };
  }
  return { principal: resolved.principal };
}

/**
 * The bearer-authentication surface `mountMcpRoute` and the metadata route
 * need from `createMcpResourceAuth` (`./auth`). Typed structurally so this
 * entry does not load the JWT verifier.
 */
export type McpRouteResourceAuth = Pick<
  McpResourceAuth,
  'metadataUrl' | 'metadataResponse' | 'authenticate' | 'sessionFallback'
>;

/**
 * A protected-resource adapter, or a thunk read on every request. A `null` or
 * `undefined` result (for example the `local` profile) means the route uses
 * its session principal resolver instead.
 */
export type McpRouteResourceAuthSource =
  | McpRouteResourceAuth
  | null
  | undefined
  | (() => McpRouteResourceAuth | null | undefined);

function currentResourceAuth(
  source: McpRouteResourceAuthSource,
): McpRouteResourceAuth | null {
  const value = typeof source === 'function' ? source() : source;
  return value ?? null;
}

/**
 * The runtime calls the protected-resource metadata route (and the bearer
 * half of {@link mountMcpAppRoute}) use: the deployment profile and the two
 * credential bindings `createHostedMcpResourceAuth` (`./auth`) takes. The
 * runtime from `@happyvertical/smrt-app-runtime/sveltekit` satisfies it as is.
 */
export interface McpRouteAuthRuntime {
  /** Resolve the deployment profile (the SMRT runtime memoizes it). */
  resolvedRuntime(): Promise<{ readonly profile: McpDeploymentProfile }>;
  /**
   * Verify an owner-minted local MCP token (`smrt app token`); `null` denies.
   * Consulted only in the `local` profile.
   */
  verifyLocalMcpToken(token: string): Promise<McpLocalTokenPrincipal | null>;
  /**
   * Map a verified hosted access-token identity to the current account and
   * tenant; `null` denies. Consulted only in hosted profiles.
   */
  resolveMcpPrincipal(
    identity: McpVerifiedIdentity,
  ): Promise<McpPrincipalMapping | null>;
}

/**
 * The runtime calls {@link mountMcpAppRoute} uses; the runtime from
 * `@happyvertical/smrt-app-runtime/sveltekit` satisfies it as is.
 */
export interface McpAppRouteRuntime extends McpRouteAuthRuntime {
  /** The request's database (its RLS transaction inside one). */
  databaseConfig(): SmrtClassOptions['db'];
  /**
   * Run `run` bound to a bearer-authenticated principal (see
   * {@link McpPrincipalBinder}): under `database-rls` in a fresh transaction
   * publishing that user, tenant and live permissions capped to its scopes.
   */
  runAsPrincipal<T>(
    principal: McpAppPrincipal & { id: string },
    run: (bound?: McpBoundPrincipal) => Promise<T>,
  ): Promise<T>;
}

const ROUTE_AUTH_RUNTIME_METHODS = [
  'resolvedRuntime',
  'verifyLocalMcpToken',
  'resolveMcpPrincipal',
] as const;
const APP_ROUTE_RUNTIME_METHODS = [
  ...ROUTE_AUTH_RUNTIME_METHODS,
  'databaseConfig',
  'runAsPrincipal',
] as const;
const DEPLOYMENT_PROFILES: readonly string[] = [
  'local',
  'self-hosted',
  'cloud',
];

/** Fail closed at mount: a runtime missing any binding is a wiring error. */
function assertRuntime(
  runtime: unknown,
  methods: readonly string[],
  mount: string,
): void {
  const value = runtime as Record<string, unknown> | null;
  const missing =
    !value || typeof value !== 'object'
      ? methods
      : methods.filter((method) => typeof value[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `${mount}: runtime must provide ${missing.join(', ')}.`,
    );
  }
}

/**
 * One `createHostedMcpResourceAuth` source per runtime and profile, shared by
 * the app route and the metadata route like the module an app used to keep.
 * Keyed by profile, so a runtime whose profile changes never reuses another
 * profile's adapter; each source keeps its own caching and retry rules.
 */
const runtimeAuthSources = new WeakMap<
  object,
  Map<McpDeploymentProfile, () => McpRouteResourceAuth | null>
>();
let authModule: Promise<typeof import('./auth.js')> | undefined;

/** Load `./auth` (the JWT verifier) only when a runtime-derived route needs it. */
function loadAuthModule(): Promise<typeof import('./auth.js')> {
  authModule ??= import('./auth.js').catch((error: unknown) => {
    authModule = undefined;
    throw error;
  });
  return authModule;
}

/**
 * The bearer adapter a runtime provides for its profile, resolved once per
 * request. Rejects (the route answers 500, before any dispatch) when the
 * profile cannot be resolved or is unknown, when hosted configuration is
 * missing, or when no adapter results: a runtime route never serves a
 * request without its profile's bearer adapter (which would ignore a
 * presented bearer and leave only the session principal).
 */
async function runtimeResourceAuth(
  runtime: McpRouteAuthRuntime,
): Promise<McpRouteResourceAuth> {
  const resolved = await runtime.resolvedRuntime();
  const profile = (resolved as { profile?: unknown } | null | undefined)
    ?.profile;
  if (typeof profile !== 'string' || !DEPLOYMENT_PROFILES.includes(profile)) {
    throw new Error('MCP runtime resolved an unknown deployment profile.');
  }
  let sources = runtimeAuthSources.get(runtime);
  if (!sources) {
    sources = new Map();
    runtimeAuthSources.set(runtime, sources);
  }
  let source = sources.get(profile as McpDeploymentProfile);
  if (!source) {
    const { createHostedMcpResourceAuth } = await loadAuthModule();
    source =
      sources.get(profile as McpDeploymentProfile) ??
      createHostedMcpResourceAuth({
        profile: profile as McpDeploymentProfile,
        runtime,
      });
    sources.set(profile as McpDeploymentProfile, source);
  }
  const adapter = source();
  if (!adapter) {
    throw new Error('MCP runtime provided no bearer adapter for its profile.');
  }
  return adapter;
}

/** Parse an origin to its canonical `scheme://host[:port]`, or `undefined`. */
function canonicalOrigin(value: string): string | undefined {
  if (value === 'null') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.pathname !== '/') return undefined;
  return url.origin;
}

function normalizeTrustedOrigins(
  values: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(values)) {
    throw new TypeError('MCP trustedOrigins must be an array of origins.');
  }
  const origins = new Set<string>();
  for (const value of values) {
    const origin =
      typeof value === 'string' ? canonicalOrigin(value) : undefined;
    if (!origin) throw new TypeError('Invalid MCP trusted origin.');
    origins.add(origin);
  }
  return origins;
}

/**
 * Same-origin is judged against `event.url`, which SvelteKit derives from the
 * adapter's configured origin (for example adapter-node `ORIGIN`, or its
 * `PROTOCOL_HEADER`/`HOST_HEADER` proxy settings). This package does not read
 * `X-Forwarded-*` itself.
 */
function originPermitted(
  event: SvelteKitRequestEvent,
  trusted: ReadonlySet<string>,
): boolean {
  const header = event.request.headers.get('origin');
  if (header !== null) {
    const origin = canonicalOrigin(header.trim());
    return (
      origin !== undefined &&
      (origin === event.url.origin || trusted.has(origin))
    );
  }
  // No Origin: a non-browser client, unless fetch metadata says otherwise.
  const site = event.request.headers
    .get('sec-fetch-site')
    ?.trim()
    .toLowerCase();
  return site !== 'cross-site' && site !== 'same-site';
}

function originDeniedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'MCP request origin is not permitted.',
        data: { code: MCP_ORIGIN_DENIED_CODE, retryable: false },
      },
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  );
}

/**
 * Project the session hook's request-local result onto an MCP principal.
 *
 * Reads only `locals.user.id`, the session-authorized `locals.tenantId`, and
 * `locals.permissions` as populated by `createSessionHandler` from
 * `@happyvertical/smrt-users/sveltekit`. Headers, URL-selected tenants
 * (`locals.selectedTenantId`), request bodies and route arguments are never
 * identity inputs. Any missing or malformed field yields `null`
 * (unauthenticated), which fails closed for every non-public tool.
 */
export function principalFromSessionLocals(event: {
  locals?: Record<string, unknown>;
}): McpAppPrincipal | null {
  const locals = event.locals;
  if (!locals || typeof locals !== 'object') return null;
  const user = locals.user as { id?: unknown } | null | undefined;
  const tenantId = locals.tenantId;
  const permissions = locals.permissions;
  if (!user || typeof user !== 'object') return null;
  if (typeof user.id !== 'string' || user.id.length === 0) return null;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  if (
    !Array.isArray(permissions) ||
    !permissions.every((value) => typeof value === 'string')
  )
    return null;
  return {
    id: user.id,
    tenantId,
    kind: 'human',
    scopes: [...permissions].sort(),
  };
}

/**
 * Run MCP dispatch for a bearer-authenticated principal inside an
 * application-owned context bound to that principal (for example
 * `runtime.runAsPrincipal` from `@happyvertical/smrt-app-runtime/sveltekit`,
 * which opens the principal's permission context and, under `database-rls`,
 * its RLS transaction). Must call `run` exactly once and return its result;
 * throwing before `run` (an unbindable principal) is a denial.
 *
 * Pass `run` the bound principal carrying its *effective* `scopes` (for
 * example the token scopes still granted by live membership permissions).
 * Dispatch then authorizes with those scopes, intersected with the token's:
 * a binder can only narrow authority, and changing the principal's `id` or
 * `tenantId` is a denial. Calling `run()` with no argument keeps the token
 * scopes.
 */
export type McpPrincipalBinder = <T>(
  principal: McpAppPrincipal & { id: string },
  run: (bound?: McpBoundPrincipal) => Promise<T>,
) => Promise<T>;

/**
 * The principal a binder hands back to `run`: the authenticated identity,
 * possibly as a frozen snapshot whose arrays are readonly (for example the
 * deep-frozen principal `runtime.runAsPrincipal` passes its callback).
 */
export type McpBoundPrincipal = Omit<McpAppPrincipal, 'scopes' | 'roles'> & {
  id: string;
  scopes?: readonly string[];
  roles?: readonly string[];
};

/**
 * The principal dispatch authorizes after binding: the authenticated identity
 * with only the scopes both the token and the binder grant. `undefined` when
 * the binder changed the identity or returned malformed scopes.
 */
function effectiveBoundPrincipal(
  authenticated: McpAppPrincipal & { id: string },
  bound: McpBoundPrincipal | undefined,
): (McpAppPrincipal & { id: string }) | undefined {
  if (bound === undefined) return authenticated;
  if (
    !bound ||
    typeof bound !== 'object' ||
    bound.id !== authenticated.id ||
    (bound.tenantId ?? null) !== (authenticated.tenantId ?? null) ||
    !Array.isArray(bound.scopes) ||
    !bound.scopes.every((scope) => typeof scope === 'string')
  ) {
    return undefined;
  }
  const granted = new Set(bound.scopes);
  return {
    ...authenticated,
    scopes: (authenticated.scopes ?? []).filter((scope) => granted.has(scope)),
  };
}

/** Options shared by both route mounts. */
export interface MountMcpRouteOptions {
  /**
   * Bind a bearer-authenticated principal around dispatch (see
   * {@link McpPrincipalBinder}). The `smrtOptions` database thunk, task
   * handling and tool execution all run inside the binding, and the response
   * is fully materialized before it returns. A binder that throws before
   * running dispatch, or returns without running it, yields HTTP 403 with the
   * safe `mcp_tool_access_denied` JSON-RPC error. Scopes the binder hands
   * back become the effective authority for the tool policy, so live
   * revocation applies even without a database-enforced policy. Used only when `auth`
   * authenticated the request; the session-locals path is unchanged.
   */
  bindPrincipal?: McpPrincipalBinder;
  /**
   * Refuse a modern-endpoint request whose `Origin` header is present but is
   * neither the request URL's own origin nor in `trustedOrigins` (and, when
   * `Origin` is absent, one whose `Sec-Fetch-Site` is `cross-site` or
   * `same-site`). The check runs before bearer authentication, principal
   * resolution and any task or tool dispatch, and answers 403 with the safe
   * `mcp_origin_denied` JSON-RPC error. Requests without browser origin
   * signals (server-side MCP clients, the `smrt-app-cli` stdio bridge) are
   * unaffected. Off unless set for `mountMcpRoute`; on by default for
   * `mountMcpAppRoute`. Ignored by the deprecated REST-shaped mounts.
   */
  checkOrigin?: boolean;
  /**
   * Additional exact origins (`scheme://host[:port]`) accepted by the origin
   * check, e.g. a browser-hosted MCP client, or the public origin when a
   * proxy makes `event.url` differ from what browsers send. `null`, wildcards,
   * paths and credentials are rejected at mount time.
   */
  trustedOrigins?: readonly string[];
  /**
   * Optional bearer authentication for the modern `mountMcpRoute` endpoint.
   * When the source yields an adapter, every request must carry a valid
   * bearer token: a failed check returns the adapter's challenge response
   * before any dispatch, and the adapter's mapped principal replaces the
   * session principal (`resolvePrincipal` is not consulted). When it yields
   * `null`, the route resolves its principal from the request as usual. A
   * `sessionFallback` adapter (the local owner-token adapter) challenges only
   * requests that carry an `Authorization` header; others keep the session
   * principal. Set `allowAnonymous` to permit a headerless request with a
   * non-fallback adapter. Ignored by the deprecated REST-shaped mounts.
   */
  auth?: McpRouteResourceAuthSource;
  /**
   * Permit an anonymous request when an auth adapter is configured but no
   * Authorization header is present. The server policy still exposes only
   * explicitly public read-only tools and resources. A presented bearer is
   * always verified; a bad token never falls back to anonymous access.
   */
  allowAnonymous?: boolean;
  /** Optional extension discovery projected from the request-authorized tool catalog. */
  extensions?: McpProtocolRequestOptions['extensions'];
  /**
   * Resolve the request principal once for both discovery and direct calls.
   * Defaults to `event.locals.user`.
   */
  resolvePrincipal?: McpPrincipalResolver;
  /**
   * Backwards-compatible alias for `resolvePrincipal`.
   */
  resolveUser?: McpUserResolver;
  /**
   * Deprecated legacy authentication gate. When `resolvePrincipal` is not
   * supplied, a false result makes the principal null for both routes.
   */
  resolveAuthenticated?: (event: SvelteKitRequestEvent) => boolean;
}

function protocolServerForRequest(
  server: McpAppServer,
  resolved: ResolvedRequestPrincipal,
): McpAppServer {
  // Older applications sometimes used a boolean discovery-only adapter. Keep
  // its positive result intact for the deprecated resolver while new mounts
  // consistently use the principal on both MCP methods.
  if (!resolved.legacyAuthenticated || resolved.principal) return server;
  return {
    ...server,
    serverInfo: server.serverInfo,
    listTools: () => server.listTools({ authenticated: true }),
    callTool: (input) => server.callTool(input),
  };
}

/**
 * Mount a modern, stateless Streamable HTTP MCP endpoint as a SvelteKit
 * `POST` handler. The scoped SDK validates the 2026-07-28 envelope plus the
 * required `Mcp-Method` and `Mcp-Name` headers, returning `-32020` on a
 * mismatch. A fresh protocol server is created for each HTTP request, so this
 * route holds neither MCP sessions nor request principal state between nodes.
 */
export function mountMcpRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return mountMcpRouteWith(server, options, () =>
    currentResourceAuth(options.auth),
  );
}

/**
 * {@link mountMcpRoute} with the bearer adapter supplied per request by
 * `resolveAuth` (sync for an `auth` source, async for a runtime). It runs
 * after the origin check and before any principal or dispatch work; a throw
 * or rejection rejects the handler (no dispatch).
 */
function mountMcpRouteWith(
  server: McpAppServer,
  options: MountMcpRouteOptions,
  resolveAuth: () =>
    | McpRouteResourceAuth
    | null
    | Promise<McpRouteResourceAuth | null>,
): McpSvelteKitHandler {
  const trustedOrigins = options.checkOrigin
    ? normalizeTrustedOrigins(options.trustedOrigins ?? [])
    : undefined;
  return async (event) => {
    // Ambient browser credentials (session cookies) must not let another
    // origin drive this endpoint; refuse before any identity or dispatch work.
    if (trustedOrigins && !originPermitted(event, trustedOrigins)) {
      return originDeniedResponse();
    }
    const auth = await resolveAuth();
    if (!auth) return dispatch(event, resolveRequestPrincipal(event, options));
    if (!event.request.headers.has('authorization')) {
      // A session-fallback adapter (local owner tokens) keeps its established
      // session path. Explicit anonymous access is separate: it deliberately
      // ignores session locals and custom resolvers, so bearer auth cannot be
      // bypassed through ambient authority.
      if (auth.sessionFallback === true) {
        return dispatch(event, resolveRequestPrincipal(event, options));
      }
      if (options.allowAnonymous === true) {
        return dispatch(event, { principal: null });
      }
    }
    const checked = await auth.authenticate(event.request);
    if (!checked.ok) return checked.response;
    if (!options.bindPrincipal) {
      return dispatch(event, { principal: checked.principal });
    }
    let entered = false;
    let response: Response;
    try {
      response = await options.bindPrincipal(
        checked.principal,
        async (bound) => {
          entered = true;
          const principal = effectiveBoundPrincipal(checked.principal, bound);
          if (!principal) return principalUnboundResponse();
          // Materialize the body inside the binding so no dispatch work can
          // outlive the principal's context (or its RLS transaction).
          const dispatched = await dispatch(event, { principal });
          return new Response(await dispatched.arrayBuffer(), {
            status: dispatched.status,
            statusText: dispatched.statusText,
            headers: dispatched.headers,
          });
        },
      );
    } catch (error) {
      if (entered) throw error;
      return principalUnboundResponse();
    }
    return entered ? response : principalUnboundResponse();
  };

  async function dispatch(
    event: SvelteKitRequestEvent,
    resolved: ResolvedRequestPrincipal,
  ): Promise<Response> {
    const taskResponse = await maybeHandleTaskRequest(
      server,
      resolved.principal,
      event.request,
    );
    if (taskResponse) return taskResponse;
    const handler = createMcpHandler(
      () =>
        createMcpProtocolServerForRequest(
          protocolServerForRequest(server, resolved),
          {
            principal: resolved.principal,
            extensions: options.extensions,
          },
        ),
      {
        // The legacy REST-shaped mounts below remain a deprecated migration
        // path. This endpoint accepts only the modern MCP protocol.
        legacy: 'reject',
        // The SDK validates every request before consulting its listen router.
        // Zero capacity keeps this mount stateless by refusing a
        // listen request before it can open an SSE response.
        maxSubscriptions: 0,
      },
    );
    return handler.fetch(event.request);
  }
}

function principalUnboundResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'MCP tool access is not permitted.',
        data: { code: MCP_TOOL_ACCESS_DENIED_CODE, retryable: false },
      },
    }),
    {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    },
  );
}

/** Options for {@link mountMcpAppRoute}. */
export interface MountMcpAppRouteOptions
  extends CreateDefaultMcpAppServerOptions,
    Pick<
      MountMcpRouteOptions,
      | 'auth'
      | 'bindPrincipal'
      | 'extensions'
      | 'checkOrigin'
      | 'trustedOrigins'
      | 'allowAnonymous'
    > {
  /**
   * Resolve the request principal when no bearer adapter is active. Defaults
   * to {@link principalFromSessionLocals}.
   */
  resolvePrincipal?: McpPrincipalResolver;
  /**
   * The application runtime (`runtime` from
   * `@happyvertical/smrt-app-runtime/sveltekit`). It supplies the three
   * bindings an app otherwise wires by hand, each still overridable:
   * `smrtOptions` defaults to `() => ({ db: runtime.databaseConfig() })`,
   * `bindPrincipal` to `runtime.runAsPrincipal`, and `auth` to
   * `createHostedMcpResourceAuth({ profile, runtime })` for the profile
   * resolved per request (`runtime.resolvedRuntime()`, after the origin
   * check), so the route module needs no top-level `await`. Fails closed: a
   * runtime missing a binding throws at mount, and a profile that cannot be
   * resolved, or a hosted profile without its configuration, rejects the
   * request (HTTP 500) before dispatch instead of serving it without the
   * profile's bearer adapter. An explicit `auth` (including `null`) is used
   * as given.
   */
  runtime?: McpAppRouteRuntime;
}

/**
 * {@link MountMcpAppRouteOptions} with a `runtime`, which makes `smrtOptions`
 * optional (it defaults to the runtime's request database).
 */
export interface MountMcpAppRuntimeRouteOptions
  extends Omit<MountMcpAppRouteOptions, 'runtime' | 'smrtOptions'> {
  runtime: McpAppRouteRuntime;
  /** Default: `() => ({ db: runtime.databaseConfig() })`. */
  smrtOptions?: McpSmrtOptionsThunk;
}

/** A mounted app route; `server` is the policy core it serves. */
export type McpAppSvelteKitHandler = McpSvelteKitHandler & {
  readonly server: McpAppServer;
};

/**
 * One-call application MCP endpoint: the app's declared `models`, the default
 * principal scope policy (see `createDefaultMcpAppServer`), principals from
 * the SvelteKit session locals, and optional bearer authentication, mounted
 * as the stateless {@link mountMcpRoute} `POST` endpoint. The origin check
 * (`checkOrigin`) is on by default because the default principal is an
 * ambient session cookie; set `trustedOrigins` for extra browser origins or
 * `checkOrigin: false` to opt out.
 *
 * With `runtime`, the request database, the bearer adapter (local owner
 * tokens or hosted access tokens, per the resolved profile) and the principal
 * binding come from the application runtime (see
 * {@link MountMcpAppRouteOptions.runtime}).
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/+server.ts
 * import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { Item } from '$lib/objects/Item';
 * import { runtime } from '$lib/server/smrt';
 *
 * export const POST = mountMcpAppRoute({
 *   runtime,
 *   models: [Item],
 *   requiredScopes: ['items.read'],
 *   effects: ['read'],
 * });
 * ```
 */
export function mountMcpAppRoute(
  options: MountMcpAppRouteOptions | MountMcpAppRuntimeRouteOptions,
): McpAppSvelteKitHandler {
  const {
    auth,
    allowAnonymous,
    bindPrincipal,
    extensions,
    resolvePrincipal,
    checkOrigin,
    trustedOrigins,
    runtime,
    ...serverOptions
  } = options;
  if (runtime !== undefined) {
    assertRuntime(runtime, APP_ROUTE_RUNTIME_METHODS, 'mountMcpAppRoute');
  }
  const server = createDefaultMcpAppServer({
    ...serverOptions,
    smrtOptions:
      serverOptions.smrtOptions !== undefined || !runtime
        ? (serverOptions.smrtOptions as McpSmrtOptionsThunk)
        : () => ({ db: runtime.databaseConfig() }),
  });
  const routeOptions: MountMcpRouteOptions = {
    auth,
    allowAnonymous,
    bindPrincipal:
      bindPrincipal !== undefined || !runtime
        ? bindPrincipal
        : (principal, run) => runtime.runAsPrincipal(principal, run),
    extensions,
    // Default on: the default principal is an ambient session cookie.
    checkOrigin: checkOrigin ?? true,
    trustedOrigins,
    resolvePrincipal: resolvePrincipal ?? principalFromSessionLocals,
  };
  const handler = mountMcpRouteWith(
    server,
    routeOptions,
    auth !== undefined || !runtime
      ? () => currentResourceAuth(auth)
      : () => runtimeResourceAuth(runtime),
  );
  return Object.defineProperty(handler, 'server', {
    value: server,
    enumerable: true,
  }) as McpAppSvelteKitHandler;
}

/** Options form of {@link mountMcpProtectedResourceMetadataRoute}. */
export interface MountMcpProtectedResourceMetadataRouteOptions {
  /** The application runtime; derives the adapter per request. */
  runtime: McpRouteAuthRuntime;
  /** Explicit adapter source; when set, used as given instead of `runtime`. */
  auth?: McpRouteResourceAuthSource;
}

/**
 * Mount the RFC 9728 protected-resource metadata document as a SvelteKit
 * `GET` handler, at the exact `metadataUrl` path the bearer challenge
 * advertises (for `/api/mcp`:
 * `src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts`).
 *
 * Returns 404 when the source yields no adapter or the local owner-token
 * adapter (the `local` profile), or when the request path is not the
 * advertised metadata path. This handler does
 * not implement an OAuth authorization server; the metadata names the
 * operator-owned issuer.
 *
 * Pass `{ runtime }` to derive the adapter the way
 * {@link mountMcpAppRoute} does (the profile resolved per request, the same
 * cached adapter as the app route); an unresolvable profile or missing hosted
 * configuration rejects the request (HTTP 500).
 *
 * @example
 * ```ts
 * // src/routes/.well-known/oauth-protected-resource/api/mcp/+server.ts
 * import { mountMcpProtectedResourceMetadataRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { runtime } from '$lib/server/smrt';
 * export const GET = mountMcpProtectedResourceMetadataRoute({ runtime });
 * ```
 */
export function mountMcpProtectedResourceMetadataRoute(
  source:
    | McpRouteResourceAuthSource
    | MountMcpProtectedResourceMetadataRouteOptions,
): McpSvelteKitHandler {
  let resolveAuth: () =>
    | McpRouteResourceAuth
    | null
    | Promise<McpRouteResourceAuth | null>;
  if (
    source !== null &&
    typeof source === 'object' &&
    Object.hasOwn(source, 'runtime')
  ) {
    if (Object.hasOwn(source, 'authenticate')) {
      throw new TypeError(
        'mountMcpProtectedResourceMetadataRoute: pass an auth adapter or { runtime }, not both.',
      );
    }
    const { runtime, auth } =
      source as MountMcpProtectedResourceMetadataRouteOptions;
    assertRuntime(
      runtime,
      ROUTE_AUTH_RUNTIME_METHODS,
      'mountMcpProtectedResourceMetadataRoute',
    );
    resolveAuth =
      auth !== undefined
        ? () => currentResourceAuth(auth)
        : () => runtimeResourceAuth(runtime);
  } else {
    const auth = source as McpRouteResourceAuthSource;
    resolveAuth = () => currentResourceAuth(auth);
  }
  return async (event) => {
    const current = await resolveAuth();
    if (
      !current ||
      current.sessionFallback === true ||
      event.url.pathname !== new URL(current.metadataUrl).pathname
    )
      return new Response(null, {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    return current.metadataResponse();
  };
}

/**
 * The installed MCP SDK validates tools/call against a pre-Tasks result codec.
 * Intercept the extension before the SDK handler so the regular stateless HTTP
 * protocol stays untouched for every other method.
 */
async function maybeHandleTaskRequest(
  server: McpAppServer,
  principal: McpAppPrincipal | null,
  request: Request,
): Promise<Response | null> {
  if (
    !server.tasksEnabled ||
    !server.callTask ||
    !server.getTask ||
    !server.updateTask ||
    !server.cancelTask ||
    request.method !== 'POST'
  ) {
    return null;
  }
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as {
    id?: string | number | null;
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
  } | null;
  if (body?.jsonrpc !== '2.0' || body.id === undefined) return null;
  const params = body.params ?? {};
  const taskTool =
    body.method === 'tools/call' &&
    typeof params.name === 'string' &&
    (await server.isTaskTool?.(params.name)) === true;
  const taskMethod = ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(
    body.method ?? '',
  );
  if (!taskTool && !taskMethod) return null;

  // Keep task requests on the SDK's protocol-validation path until their
  // 2026 request envelope is known-good. In particular, never enqueue durable
  // work for malformed envelopes, unsupported revisions, or non-JSON bodies.
  // The fallback handler owns its wire-exact error response for those cases.
  if (!isJsonContentType(request.headers.get('content-type'))) return null;
  const classification = classifyInboundRequest({
    httpMethod: request.method,
    protocolVersionHeader:
      request.headers.get('mcp-protocol-version') ?? undefined,
    mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
    mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
    body: body as never,
  });
  if (classification.kind === 'reject') {
    return jsonRpcResponse(
      body.id,
      undefined,
      {
        code: classification.code,
        message: classification.message,
        ...(classification.data === undefined
          ? {}
          : { data: classification.data }),
      },
      classification.httpStatus,
    );
  }
  if (
    classification.kind !== 'modern' ||
    classification.classification.revision !== '2026-07-28'
  ) {
    return null;
  }

  // The SDK normally performs this modern HTTP routing validation before
  // dispatch. Task responses are intercepted ahead of that SDK handler, so
  // retain the same fail-closed header/body contract here.
  const headerMismatch = taskHeaderMismatch(request, body.method, params);
  if (headerMismatch) {
    return jsonRpcResponse(body.id, undefined, headerMismatch, 400);
  }

  const clientCapabilities = asRecord(params._meta)[
    'io.modelcontextprotocol/clientCapabilities'
  ];
  const clientSupportsTasks = Object.hasOwn(
    asRecord(asRecord(clientCapabilities).extensions),
    MCP_TASKS_EXTENSION,
  );

  // A synchronous fallback exists for tools/call; lifecycle methods do not.
  if (!clientSupportsTasks && body.method === 'tools/call') return null;
  if (!clientSupportsTasks) {
    return jsonRpcResponse(
      body.id,
      undefined,
      {
        code: -32021,
        message: 'Missing required client capability',
        data: {
          requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
        },
      },
      400,
    );
  }

  try {
    if (body.method === 'tools/call') {
      const result = await server.callTask({
        name: params.name as string,
        arguments: (params.arguments as Record<string, unknown>) ?? {},
        principal,
      });
      return jsonRpcResponse(body.id, result);
    }
    if (typeof params.taskId !== 'string') {
      return jsonRpcResponse(body.id, undefined, {
        code: -32602,
        message: 'taskId is required',
      });
    }
    if (body.method === 'tasks/get') {
      const task = await server.getTask({ taskId: params.taskId, principal });
      return jsonRpcResponse(body.id, { resultType: 'complete', ...task });
    }
    if (body.method === 'tasks/update') {
      await server.updateTask({
        taskId: params.taskId,
        inputResponses:
          params.inputResponses && typeof params.inputResponses === 'object'
            ? (params.inputResponses as Record<string, unknown>)
            : {},
        principal,
      });
      return jsonRpcResponse(body.id, { resultType: 'complete' });
    }
    await server.cancelTask({ taskId: params.taskId, principal });
    return jsonRpcResponse(body.id, { resultType: 'complete' });
  } catch (error) {
    if (error instanceof McpAccessError) {
      const { code, retryable } = error.metadata;
      return jsonRpcResponse(body.id, undefined, {
        code: error.status === 404 ? -32602 : -32600,
        message: error.message,
        data: {
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof retryable === 'boolean' ? { retryable } : {}),
        },
      });
    }
    const message =
      error instanceof Error ? error.message : 'Task operation failed';
    return jsonRpcResponse(body.id, undefined, { code: -32602, message });
  }
}

function taskHeaderMismatch(
  request: Request,
  method: string | undefined,
  params: Record<string, unknown>,
): { code: number; message: string } | undefined {
  if (
    !method ||
    normalizeHeaderValue(request.headers.get('mcp-method') ?? '') !== method
  ) {
    return {
      code: -32020,
      message: 'Mcp-Method header must match the JSON-RPC method.',
    };
  }
  const toolName =
    method === 'tools/call' && typeof params.name === 'string'
      ? params.name
      : undefined;
  const headerName = request.headers.get('mcp-name');
  if (
    toolName !== undefined &&
    (headerName === null || decodeMcpHeaderValue(headerName) !== toolName)
  ) {
    return {
      code: -32020,
      message: 'Mcp-Name header must match the tools/call name.',
    };
  }
  return undefined;
}

/** Match the SDK's RFC 9110 optional-whitespace handling for MCP headers. */
function normalizeHeaderValue(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, '');
}

/** Decode the SDK's canonical Base64 sentinel for an MCP header value. */
function decodeMcpHeaderValue(value: string): string | undefined {
  const normalized = normalizeHeaderValue(value);
  const prefix = '=?base64?';
  if (!normalized.startsWith(prefix) || !normalized.endsWith('?=')) {
    return normalized;
  }
  const encoded = normalized.slice(prefix.length, -2);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

function jsonRpcResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
  status = 200,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Mount `server.listTools` as a `GET` handler. Returns the tool list shape
 * `{ tools }` for compatibility with the stock MCP bridge.
 *
 * @deprecated Use {@link mountMcpRoute}. Existing REST-shaped mounts can use
 * this compatibility alias while migrating without a coordinated cutover.
 */
export function mountMcpToolsRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return async (event) => {
    try {
      const tools = await server.listTools(
        listToolsInput(resolveRequestPrincipal(event, options)),
      );
      return jsonResponse({ tools });
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse(mcpAccessErrorBody(error), error.status);
      }
      throw error;
    }
  };
}

/**
 * Mount `server.callTool` as a `POST` handler that expects
 * `{ name, arguments }` in the JSON body.
 *
 * @deprecated Use {@link mountMcpRoute}. Existing REST-shaped mounts can use
 * this compatibility alias while migrating without a coordinated cutover.
 */
export function mountMcpCallRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return async (event) => {
    const body = (await event.request.json().catch(() => null)) as {
      arguments?: Record<string, unknown>;
      name?: string;
    } | null;

    if (!body?.name) {
      return jsonResponse({ error: 'name is required.' }, 400);
    }

    const input: CallToolInput = {
      arguments: body.arguments ?? {},
      name: body.name,
      principal: resolveRequestPrincipal(event, options).principal,
    };

    try {
      return jsonResponse(await server.callTool(input));
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse(mcpAccessErrorBody(error), error.status);
      }
      throw error;
    }
  };
}

function mcpAccessErrorBody(error: McpAccessError): unknown {
  const { code, retryable } = error.metadata;
  // Preserve the legacy shape unless an error deliberately opts into the
  // shared structured failure contract.
  if (!code) return { error: error.message };
  return {
    error: {
      ok: false,
      code,
      message: error.message,
      status: error.status,
      ...(retryable === undefined ? {} : { retryable }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export type {
  CreateDefaultMcpAppServerOptions,
  McpAppModel,
} from './defaults.js';
export { McpAccessError } from './errors.js';
export type { McpAppPrincipal, McpAppServer } from './server.js';
