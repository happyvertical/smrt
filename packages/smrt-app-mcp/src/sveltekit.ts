/**
 * SvelteKit route adapters for an `McpAppServer`. Mirrors the
 * `@happyvertical/smrt-users/sveltekit` pattern: minimal `HandleInput` type
 * so we never need `@sveltejs/kit` as a real dependency.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/+server.ts
 * import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { mcpServer } from '$lib/server/mcp';
 * export const POST = mountMcpRoute(mcpServer);
 * ```
 */

import { createMcpHandler } from '@modelcontextprotocol/server';
import { McpAccessError } from './errors.js';
import { createMcpProtocolServer } from './protocol.js';
import type { CallToolInput, McpAppPrincipal, McpAppServer } from './server.js';

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

/** Options shared by both route mounts. */
export interface MountMcpRouteOptions {
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
  return async (event) => {
    const resolved = resolveRequestPrincipal(event, options);
    const handler = createMcpHandler(
      () =>
        createMcpProtocolServer(protocolServerForRequest(server, resolved), {
          principal: resolved.principal,
        }),
      {
        // The legacy REST-shaped mounts below remain the migration path for
        // one release. This endpoint is deliberately 2026-07-28-only.
        legacy: 'reject',
        // The SDK validates every request before consulting its listen router.
        // Zero capacity keeps this tools-only mount stateless by refusing a
        // listen request before it can open an SSE response.
        maxSubscriptions: 0,
      },
    );
    return handler.fetch(event.request);
  };
}

/**
 * Mount `server.listTools` as a `GET` handler. Returns the tool list shape
 * `{ tools }` for compatibility with the stock MCP bridge.
 *
 * @deprecated Use {@link mountMcpRoute}; retained for one release so existing
 * REST-shaped mounts can migrate without a coordinated cutover.
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
 * @deprecated Use {@link mountMcpRoute}; retained for one release so existing
 * REST-shaped mounts can migrate without a coordinated cutover.
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

export { McpAccessError } from './errors.js';
export type { McpAppPrincipal, McpAppServer } from './server.js';
