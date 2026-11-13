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
import { PolicyError, type Principal } from './owner.ts';
import { authorizeCall, toolsFor } from './policy.ts';
import { type CallScope, LIVE_SCOPE } from './target.ts';

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

/**
 * Which copies one MCP endpoint serves. The /mcp route builds one server per
 * request-named scope (`?target=live|draft`, or `?scope=assistant`), so the
 * copy is fixed by the URL the client was configured with, never by state a
 * previous call left behind. Default: live.
 */
export type ScopeResolver = (
  principal: Principal,
) => CallScope | Promise<CallScope>;

export function createShellMcpServer(
  resolveScope: ScopeResolver = () => LIVE_SCOPE,
): McpAppServer {
  return {
    get serverInfo() {
      return shellMcpServer().serverInfo;
    },
    async getToolsListCacheHint() {
      return { ttlMs: 0, cacheScope: 'private' as const };
    },
    async listTools({ principal }) {
      const who = asPrincipal(principal);
      // A request without a principal lists nothing; the scope is only
      // resolved for someone who can see tools.
      const tools = await toolsFor(
        who,
        who ? await resolveScope(who) : LIVE_SCOPE,
      );
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
      let scope: CallScope = LIVE_SCOPE;
      try {
        scope = who ? await resolveScope(who) : LIVE_SCOPE;
        tool = await authorizeCall(who, name, scope);
      } catch (e) {
        denied(e);
      }
      const result = await dispatchTool(
        principal as McpAppPrincipal & { id: string },
        tool,
        args ?? {},
        scope,
      );
      // The host-only `pending` marker never goes to a client.
      const { pending: _pending, ...wire } = result;
      return wire as never;
    },
  };
}
