import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';

import { mcpServer, resolveMcpPrincipal } from '$lib/server/mcp';
import { hostedMcpAuth } from '$lib/server/mcp-hosted';

/** Stateless SDK-v2 Streamable HTTP MCP endpoint. */
const localRoute = mountMcpRoute(mcpServer, { resolvePrincipal: resolveMcpPrincipal });

export async function POST(event: Parameters<typeof localRoute>[0]) {
  const auth = hostedMcpAuth();
  if (!auth) return localRoute(event);
  const checked = await auth.authenticate(event.request);
  if (!checked.ok) return checked.response;
  return mountMcpRoute(mcpServer, { resolvePrincipal: () => checked.principal })(event);
}
