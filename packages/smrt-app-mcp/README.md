# @happyvertical/smrt-app-mcp

App-runtime MCP server scaffolding for SMRT apps. Provides:

- **Core** — `createMcpAppServer({ smrtOptions, serverInfo, allowedClassNames, publicToolPatterns?, workflowAssertions? })` returning `{ listTools, callTool }` wired to `@happyvertical/smrt-core/generators/mcp`.
- **SvelteKit adapters** (`./sveltekit`) — `mountMcpToolsRoute` / `mountMcpCallRoute` for `/api/mcp/{tools,call}/+server.ts`.
- **Stdio bridge** — `runMcpStdioBridge` and a generic `smrt-mcp-bridge` bin that pipes a remote app's HTTP MCP endpoints into a local stdio MCP server.

```ts
// src/lib/server/mcp.ts
import { createMcpAppServer } from '@happyvertical/smrt-app-mcp';
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

```ts
// bin/my-app-mcp.ts
#!/usr/bin/env node
import { runMcpStdioBridge } from '@happyvertical/smrt-app-mcp/cli';
await runMcpStdioBridge({
  envPrefix: 'MY_APP',
  serverInfo: { name: 'my-app-mcp', version: '0.1.0' },
});
```

For one-off use without a custom bin entry, run the generic bridge:

```
smrt-mcp-bridge --env-prefix=MY_APP --name=my-app-mcp --version=0.1.0
```
