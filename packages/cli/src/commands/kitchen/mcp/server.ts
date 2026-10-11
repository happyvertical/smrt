/**
 * `smrt kitchen mcp` (#3752): the Kitchen tools served over stdio. stdout
 * carries the protocol only; everything else goes to stderr.
 */

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { cliVersion } from '../../cookbook/shared.js';
import {
  KITCHEN_TOOLS,
  KitchenSession,
  type KitchenToolsOptions,
} from './tools.js';

export const SERVER_NAME = 'smrt-kitchen';

/** The tool catalog changes only with a release. */
const CATALOG_CACHE_HINT = {
  ttlMs: 86_400_000,
  cacheScope: 'private' as const,
};

/** Build the MCP server; one {@link KitchenSession} (plans, catalog) per server. */
export function createKitchenMcpServer(options: KitchenToolsOptions): {
  server: Server;
  session: KitchenSession;
} {
  const session = new KitchenSession(options);
  const server = new Server(
    { name: SERVER_NAME, version: cliVersion() },
    {
      capabilities: { tools: {} },
      cacheHints: { 'tools/list': CATALOG_CACHE_HINT },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: KITCHEN_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      outputSchema: tool.outputSchema as never,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    const result = await session.call(name, args ?? {});
    return {
      content: [{ type: 'text', text: result.text }],
      structuredContent: result.data,
      ...(result.data.ok ? {} : { isError: true }),
    };
  });

  return { server, session };
}

/** Serve on this process's stdio until the host closes it or the process is stopped. */
export async function runKitchenMcp(
  options: KitchenToolsOptions,
): Promise<void> {
  const handle = serveStdio(() => createKitchenMcpServer(options).server, {
    onerror: (error) => console.error(`[${SERVER_NAME}] ${error.message}`),
  });
  await new Promise<void>((resolve) => {
    const done = () => {
      void handle.close().finally(resolve);
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}
