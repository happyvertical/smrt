/**
 * SvelteKit route adapters for an `McpAppServer`. Mirrors the
 * `@happyvertical/smrt-users/sveltekit` pattern: minimal `HandleInput` type
 * so we never need `@sveltejs/kit` as a real dependency.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/tools/+server.ts
 * import { mountMcpToolsRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { mcpServer } from '$lib/server/mcp';
 * export const GET = mountMcpToolsRoute(mcpServer);
 * ```
 */

import { McpAccessError } from './errors.js';
import type { CallToolInput, McpAppPrincipal, McpAppServer } from './server.js';

/** Minimal subset of a SvelteKit RequestEvent we actually touch. */
type SvelteKitRequestEvent = {
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

type SvelteKitHandler = (event: SvelteKitRequestEvent) => Promise<Response>;

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
): McpAppPrincipal | null {
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
    return null;
  }
  return principal;
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

/**
 * Mount `server.listTools` as a `GET` handler. Returns the tool list shape
 * `{ tools }` for compatibility with the stock MCP bridge.
 */
export function mountMcpToolsRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): SvelteKitHandler {
  return async (event) => {
    try {
      const tools = await server.listTools({
        principal: resolveRequestPrincipal(event, options),
      });
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
 */
export function mountMcpCallRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): SvelteKitHandler {
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
      principal: resolveRequestPrincipal(event, options),
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
