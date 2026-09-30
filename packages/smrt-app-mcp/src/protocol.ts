/** MCP SDK v2 protocol adapter for the framework-neutral app server core. */
import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { McpAccessError } from './errors.js';
import type { McpAppPrincipal, McpAppServer } from './server.js';
import { compareMcpToolNames } from './tools.js';

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const DEFAULT_TOOL_LIST_CACHE_HINT = {
  ttlMs: 86_400_000,
  cacheScope: 'private' as const,
};

export interface McpProtocolServerOptions {
  /** Resolve the authenticated application principal for each MCP request. */
  principal?:
    | McpAppPrincipal
    | null
    | ((
        context: ServerContext,
      ) => McpAppPrincipal | null | Promise<McpAppPrincipal | null>);
}

async function resolvePrincipal(
  option: McpProtocolServerOptions['principal'],
  context: ServerContext,
): Promise<McpAppPrincipal | null> {
  if (typeof option === 'function') return (await option(context)) ?? null;
  return option ?? null;
}

/**
 * Adapt an app MCP core to the SDK v2 low-level server protocol.
 *
 * Transport ownership remains with the caller. In particular, this does not
 * add a production HTTP endpoint; it is safe to compose with `serveStdio` or
 * `createMcpHandler` in a deployment that supplies its own authentication.
 */
export function createMcpProtocolServer(
  appServer: McpAppServer,
  options: McpProtocolServerOptions = {},
): Server {
  // Task lifecycle records are owner-scoped. Unlike ordinary public read-only
  // tools, they cannot be safely exposed without a stable principal id.
  const tasksEnabled =
    appServer.tasksEnabled &&
    typeof options.principal !== 'function' &&
    Boolean(options.principal?.id);
  const server = new Server(appServer.serverInfo, {
    capabilities: {
      tools: {},
      ...(appServer.listResources && appServer.readResource
        ? { resources: {} }
        : {}),
      ...(tasksEnabled ? { extensions: { [MCP_TASKS_EXTENSION]: {} } } : {}),
    } as never,
    cacheHints: { 'tools/list': DEFAULT_TOOL_LIST_CACHE_HINT },
  });

  server.setRequestHandler('tools/list', async (_request, context) => {
    const principal = await resolvePrincipal(options.principal, context);
    const cacheHint =
      (await appServer.getToolsListCacheHint?.()) ??
      DEFAULT_TOOL_LIST_CACHE_HINT;
    return {
      tools: [...(await appServer.listTools({ principal }))].sort(
        (left, right) => compareMcpToolNames(left.name, right.name),
      ) as Tool[],
      ...cacheHint,
    };
  });

  if (appServer.listResources && appServer.readResource) {
    server.setRequestHandler('resources/list', async (_request, context) => ({
      resources: await appServer.listResources!({
        principal: await resolvePrincipal(options.principal, context),
      }),
      ttlMs: 0,
      cacheScope: 'private',
    }));
    server.setRequestHandler('resources/read', async (request, context) => {
      try {
        return {
          contents: [
            await appServer.readResource!({
              uri: request.params.uri,
              principal: await resolvePrincipal(options.principal, context),
            }),
          ],
          ttlMs: 0,
          cacheScope: 'private',
        };
      } catch (error) {
        if (error instanceof McpAccessError)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            'MCP resource is not available.',
          );
        throw error;
      }
    });
  }

  server.setRequestHandler('tools/call', async (request, context) => {
    try {
      return (await appServer.callTool({
        name: request.params.name,
        arguments: request.params.arguments,
        principal: await resolvePrincipal(options.principal, context),
      })) as CallToolResult;
    } catch (error) {
      if (error instanceof McpAccessError) {
        const { code, retryable } = error.metadata;
        throw new ProtocolError(
          error.status === 404
            ? ProtocolErrorCode.InvalidParams
            : ProtocolErrorCode.InvalidRequest,
          error.message,
          {
            ...(typeof code === 'string' ? { code } : {}),
            ...(typeof retryable === 'boolean' ? { retryable } : {}),
          },
        );
      }
      throw error;
    }
  });

  return server;
}
