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
import type { CallToolInput, McpAppServer, McpAppUser } from './server.js';

/** Minimal subset of a SvelteKit RequestEvent we actually touch. */
type SvelteKitRequestEvent = {
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

type SvelteKitHandler = (event: SvelteKitRequestEvent) => Promise<Response>;

/** Locals reader used to pull the authenticated user out of `event.locals`. */
export type McpUserResolver = (
  event: SvelteKitRequestEvent,
) => McpAppUser | null | undefined;

const defaultResolveUser: McpUserResolver = (event) =>
  (event.locals?.user ?? null) as McpAppUser | null;

const defaultResolveAuthenticated = (event: SvelteKitRequestEvent): boolean =>
  Boolean(event.locals?.user);

/** Options shared by both route mounts. */
export interface MountMcpRouteOptions {
  /**
   * Resolve the authenticated user from `event.locals`. Defaults to
   * `event.locals.user`.
   */
  resolveUser?: McpUserResolver;
  /**
   * Resolve whether the request is authenticated. Defaults to
   * `Boolean(event.locals.user)`.
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
  const resolveAuthenticated =
    options.resolveAuthenticated ?? defaultResolveAuthenticated;

  return async (event) => {
    try {
      const tools = await server.listTools({
        authenticated: resolveAuthenticated(event),
      });
      return jsonResponse({ tools });
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse({ error: error.message }, error.status);
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
  const resolveUser = options.resolveUser ?? defaultResolveUser;

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
      user: resolveUser(event) ?? null,
    };

    try {
      return jsonResponse(await server.callTool(input));
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      throw error;
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export { McpAccessError } from './errors.js';
export type { McpAppServer } from './server.js';
