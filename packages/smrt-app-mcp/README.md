# @happyvertical/smrt-app-mcp

App-runtime MCP server scaffolding for s-m-r-t apps. Provides:

- **Core** — `createMcpAppServer({ smrtOptions, serverInfo, allowedClassNames, publicToolPatterns?, toolPolicy?, workflowAssertions? })` returning `{ listTools, callTool }` wired to `@happyvertical/smrt-core/generators/mcp`.
- **SvelteKit adapters** (`./sveltekit`) — `mountMcpToolsRoute` / `mountMcpCallRoute` for `/api/mcp/{tools,call}/+server.ts`.

For piping a deployed app's MCP surface to a local stdio MCP client, see `@happyvertical/smrt-app-cli` — the client-side runtime CLI exposes a `startMcpBridge()` default and a generic `smrt-mcp-bridge` bin.

For public deployments, follow the
[remote MCP authorization contract](../../docs/content/architecture/remote-mcp-authorization.md).
This package trusts the principal supplied by the application adapter; it does
not implement an OAuth authorization server or validate bearer tokens itself.

For public deployments, follow the
[remote MCP authorization contract](../../docs/content/architecture/remote-mcp-authorization.md).
This package trusts the principal supplied by the application adapter; it does
not implement an OAuth authorization server or validate bearer tokens itself.

```ts
// src/lib/server/mcp.ts
import { createMcpAppServer, McpAccessError } from '@happyvertical/smrt-app-mcp';
import { adminResources } from '$lib/admin/resources';
import { getDbConfig } from './db';

export const mcpServer = createMcpAppServer({
  smrtOptions: () => ({ db: getDbConfig() }),
  serverInfo: { name: 'my-app', version: '0.1.0' },
  allowedClassNames: adminResources.map((r) => r.className),
  publicToolPatterns: () =>
    (process.env.MY_APP_PUBLIC_MCP_TOOLS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  toolPolicy: ({ tool, principal }) => {
    if (!principal) return tool.name === 'application_get';
    if (principal.kind === 'human') return principal.roles?.includes('admin') ?? false;
    return principal.kind === 'service' && principal.scopes?.includes('mcp:applications') === true;
  },
  workflowAssertions: {
    application_update: (args, user) => {
      if (!user?.id) throw new McpAccessError(401, 'sign in first');
      args.approvedByUserId = user.id;
    },
  },
});
```

```ts
// src/routes/api/mcp/tools/+server.ts
import { mountMcpToolsRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { mcpServer } from '$lib/server/mcp';
export const GET = mountMcpToolsRoute(mcpServer);
```

```ts
// src/routes/api/mcp/call/+server.ts
import { mountMcpCallRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { mcpServer } from '$lib/server/mcp';
export const POST = mountMcpCallRoute(mcpServer);
```
`toolPolicy` is evaluated for every tool eligible under the allow-list and
base public/authenticated rule, on both discovery and a direct call. Return
`false` to hide the tool from discovery and deny a direct call with the safe,
non-retryable `mcp_tool_access_denied` code. Its HTTP response is the shared
structured failure envelope under `error` (`ok: false`, `code`, `message`,
`status`, `retryable`) and never includes tool, principal, scope, or
policy-error details. Policy errors also fail closed. The default remains unchanged:
unauthenticated callers only see/read tools selected by `publicToolPatterns`.

SvelteKit mounts resolve `event.locals.user` once as the principal for both
routes. Use `resolvePrincipal` when your app stores a human or scoped-service
principal elsewhere; `resolveUser` remains a legacy compatibility alias.
`resolveAuthenticated` is also retained as a deprecated legacy gate; when a
new `resolvePrincipal` is not supplied, it makes that same route principal
unauthenticated for both discovery and calls. If an older mount supplies only
`resolveAuthenticated: () => true` and no principal, discovery keeps its old
boolean behavior while calls remain user-less as before; migrate that mount to
`resolvePrincipal` for one identity across both routes.
