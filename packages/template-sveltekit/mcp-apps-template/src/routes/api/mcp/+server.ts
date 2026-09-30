import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';

import { mcpServer, resolveMcpPrincipal } from '$lib/server/mcp';

/** Stateless SDK-v2 Streamable HTTP MCP endpoint. */
export const POST = mountMcpRoute(mcpServer, { resolvePrincipal: resolveMcpPrincipal });
