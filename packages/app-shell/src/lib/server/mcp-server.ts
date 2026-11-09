// The merged MCP server the /mcp route mounts: an `McpAppServer` whose catalog
// is the shell's tools plus the app's tools, with every list and call going
// through policy.ts. `tools/list` is never cached by clients (the catalog
// changes with each definition change).
import {
  McpAccessError,
  type McpAppPrincipal,
  type McpAppServer,
} from '@happyvertical/smrt-app-mcp';
import { dispatchTool, shellMcpServer } from './catalog.ts';
import { PolicyError } from './owner.ts';
import { authorizeCall, toolsFor } from './policy.ts';

function asPrincipal(p: McpAppPrincipal | null | undefined) {
  return p?.id && p.tenantId
    ? { id: p.id, tenantId: p.tenantId, scopes: p.scopes }
    : null;
}

function denied(error: unknown): never {
  if (error instanceof PolicyError)
    throw new McpAccessError(
      error.status === 401 ? 401 : error.status,
      error.message,
    );
  throw error;
}

export function createShellMcpServer(): McpAppServer {
  return {
    get serverInfo() {
      return shellMcpServer().serverInfo;
    },
    async getToolsListCacheHint() {
      return { ttlMs: 0, cacheScope: 'private' as const };
    },
    async listTools({ principal }) {
      const tools = await toolsFor(asPrincipal(principal));
      return tools.map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        ...(annotations ? { annotations } : {}),
      })) as never;
    },
    async callTool({ name, arguments: args, principal }) {
      const who = asPrincipal(principal);
      let tool: Awaited<ReturnType<typeof authorizeCall>>;
      try {
        tool = await authorizeCall(who, name);
      } catch (e) {
        denied(e);
      }
      const result = await dispatchTool(
        principal as McpAppPrincipal & { id: string },
        tool,
        args ?? {},
      );
      return result as never;
    },
  };
}
