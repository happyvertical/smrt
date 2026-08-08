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
  const server = new Server(appServer.serverInfo, {
    capabilities: { tools: {} },
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
