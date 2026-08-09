# @happyvertical/smrt-app-mcp

App-runtime MCP server scaffolding for s-m-r-t apps. Provides:

- **Core** — `createMcpAppServer({ smrtOptions, serverInfo, allowedClassNames, publicToolPatterns?, toolListCache?, toolPolicy?, workflowAssertions? })` returning `{ listTools, callTool }` wired to `@happyvertical/smrt-core/generators/mcp`.
- **SvelteKit adapters** (`./sveltekit`) — `mountMcpRoute` mounts a modern
  2026-07-28 stateless Streamable HTTP MCP endpoint. The REST-shaped
  `mountMcpToolsRoute` / `mountMcpCallRoute` aliases remain available for one
  release while applications migrate.

For piping a deployed app's MCP surface to a local stdio MCP client, see `@happyvertical/smrt-app-cli` — the client-side runtime CLI exposes a `startMcpBridge()` default and a generic `smrt-mcp-bridge` bin.

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
// src/routes/api/mcp/+server.ts
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { mcpServer } from '$lib/server/mcp';
export const POST = mountMcpRoute(mcpServer);
```

`mountMcpRoute` is a modern-only, fetch-style Streamable HTTP endpoint. It
serves `server/discover`, `tools/list`, and `tools/call` with the SDK's
2026-07-28 envelope. It advertises the optional
`io.modelcontextprotocol/tasks` extension only when an allowed object enables
MCP tasks (`mcp: { tasks: [...] }`); task-aware clients can then call
`tasks/get`, `tasks/update`, and `tasks/cancel`. Application deployments must
run a `TaskRunner` for the `mcp-tasks` queue. Task lifecycle operations require
a stable authenticated principal id; include its `tenantId` in the principal
when the application uses tenant-scoped objects. Tool discovery is deterministically
ordered by name. Stock MCP clients send the required
`Mcp-Method` header (and `Mcp-Name` for `tools/call`); the mount validates them
against the JSON-RPC body and returns the protocol `HeaderMismatch` error
(`-32020`, HTTP 400) for a missing or mismatched header.

`tools/list` emits the required cache metadata with a one-day, `private`
default. Shared (`public`) caching is intentionally exceptional: set
`toolListCache: { cacheScope: 'public', publicCatalog: true }` only for a
reviewed catalog where every allowed tool is unauthenticated, read-only, and
global. The server verifies that shape (including the absence of tenant-scoped
tools and principal-aware policy) and falls back to `private` otherwise.

The route constructs a fresh protocol server for every HTTP request. It does
not issue or rely on `Mcp-Session-Id`, sticky load-balancer routing, or a held
SSE connection, so it is safe behind ordinary round-robin deployment. This
mount exposes no subscription capability; subscription requests are refused as
a JSON-RPC error before any SSE stream opens. Persist stateful workflow
progress in application objects, then pass their explicit s-m-r-t object id
back to the next tool call:

```ts
// `basket_create` returns an object with id "basket-123".
await client.callTool({
  name: 'basket_additem',
  arguments: { id: 'basket-123', productId: 'product-456' },
});
```

## Deprecated REST compatibility

For one release, applications that have not moved their route path can retain
the old handlers below. They are REST-shaped compatibility aliases, not an MCP
transport, and will be removed after the migration window. Direct calls to a
tool outside the app allow-list continue to receive the safe 404 behavior.

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
