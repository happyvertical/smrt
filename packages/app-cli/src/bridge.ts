/**
 * Stdio MCP bridge — pipes a remote SMRT app's HTTP MCP surface
 * (`/api/mcp/tools` + `/api/mcp/call`) to a local stdio MCP server so that
 * editors and AI clients can connect to it.
 *
 * Apps wire this up by providing their own bin script:
 *
 * ```ts
 * #!/usr/bin/env node
 * import { runMcpStdioBridge } from '@happyvertical/smrt-app-mcp/cli';
 * await runMcpStdioBridge({
 *   envPrefix: 'WILLGRIFFIN',
 *   serverInfo: { name: 'willgriffin-mcp', version: '0.1.0' },
 * });
 * ```
 *
 * The package also ships a `smrt-mcp-bridge` bin (see `bin/smrt-mcp-bridge`)
 * that reads `--env-prefix=…` from argv for ad-hoc use without writing a
 * package-specific entry point.
 *
 * @packageDocumentation
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import { type CliConfigContext, requestJson } from './config.js';

/**
 * Configuration for the bridge.
 *
 * Combines the {@link CliConfigContext} (env var + config file resolution)
 * with the local MCP server identity the bridge advertises to clients.
 */
export interface McpStdioBridgeOptions extends CliConfigContext {
  /** MCP server identity advertised to local clients. */
  serverInfo: {
    name: string;
    version: string;
  };
  /** Override the tools endpoint path. Defaults to `/api/mcp/tools`. */
  toolsPath?: string;
  /** Override the call endpoint path. Defaults to `/api/mcp/call`. */
  callPath?: string;
  /**
   * Override fetch implementation (used by tests so we never hit the network).
   */
  fetch?: typeof fetch;
}

/**
 * Wire up the stdio server. Use `runMcpStdioBridge` for a one-call entry
 * point in `bin/` scripts; this lower-level form is exposed for tests.
 */
export function createMcpStdioBridge(options: McpStdioBridgeOptions): {
  server: Server;
  connect: () => Promise<void>;
} {
  const toolsPath = options.toolsPath ?? '/api/mcp/tools';
  const callPath = options.callPath ?? '/api/mcp/call';

  const server = new Server(options.serverInfo, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest): Promise<ListToolsResult> => {
      return requestJson<ListToolsResult>(
        options,
        toolsPath,
        { method: 'GET' },
        { fetch: options.fetch },
      );
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args = {} } = request.params;
      try {
        return await requestJson<CallToolResult>(
          options,
          callPath,
          {
            body: JSON.stringify({ arguments: args, name }),
            method: 'POST',
          },
          { fetch: options.fetch },
        );
      } catch (error) {
        return {
          content: [
            {
              text:
                error instanceof Error
                  ? error.message
                  : 'MCP tool call failed.',
              type: 'text',
            },
          ],
          isError: true,
        };
      }
    },
  );

  return {
    server,
    connect: () => server.connect(new StdioServerTransport()),
  };
}

/**
 * One-call entry point — instantiate the bridge and connect stdio. Returns
 * a `Promise<void>` that resolves once the transport disconnects.
 */
export async function runMcpStdioBridge(
  options: McpStdioBridgeOptions,
): Promise<void> {
  const { connect } = createMcpStdioBridge(options);
  await connect();
}
