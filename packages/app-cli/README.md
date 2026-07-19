# @happyvertical/smrt-app-cli

Reusable, application-branded CLI support for s-m-r-t apps. It combines resource
discovery, generated command invocation, device-code authentication, local
configuration, and an MCP stdio bridge without coupling the CLI to one app.

Use this package when a deployed s-m-r-t application should expose a branded
`<app> <resource> <command>` CLI. Use
[`@happyvertical/smrt-cli`](../cli/README.md) for framework development,
schema, and code-generation commands.

## Installation

```bash
pnpm add @happyvertical/smrt-app-cli
```

Node.js 24.18 or newer is required.

## Quick start

```ts
#!/usr/bin/env node
import { createAppCli } from '@happyvertical/smrt-app-cli';

const cli = createAppCli({
  name: 'acme',
  defaultServerUrl: 'https://app.acme.test',
});

await cli.run(process.argv.slice(2));
```

The resulting CLI includes:

```text
acme auth login [--server <url>] [--no-open]
acme auth status
acme auth logout
acme resources [--json] [--debug]
acme mcp
acme <resource> <command> [flags]
```

Resources and their commands are discovered from the app's `/_resources`
surface. JSON Schema becomes CLI flags, while unsupported schema shapes are
reported instead of silently guessed.

## Add an app-specific command

```ts
const cli = createAppCli({
  name: 'acme',
  extraCommands: [
    {
      name: 'doctor',
      description: 'Check the deployed app',
      async run(_args, context) {
        const health = await context.requestJson('/api/health');
        context.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
      },
    },
  ],
});
```

App-specific commands win over built-ins. Avoid names that may collide with a
discovered resource slug.

## MCP bridge

The same app CLI can expose the deployed application's MCP surface to local
stdio clients:

```ts
await cli.startMcpBridge({ name: 'acme-mcp', version: '1.0.0' });
```

The package also ships the generic `smrt-mcp-bridge` binary. The remote app
surface is typically mounted with
[`@happyvertical/smrt-app-mcp`](../smrt-app-mcp/README.md).

## Configuration and authentication

- `name` supplies the display name and default environment-variable prefix.
- `envPrefix` overrides that prefix; `configDir` overrides the local config
  namespace.
- `defaultServerUrl` is used only when neither environment nor stored config
  supplies a server.
- Device-code login distinguishes pending approval, expiry, transient network
  failure, and hard rejection.
- Tokens and server configuration stay in the app-specific local config path.

## Public API

| Export | Purpose |
| --- | --- |
| `createAppCli()` | Build the branded CLI and MCP bridge |
| `createMcpStdioBridge()` / `runMcpStdioBridge()` | Lower-level bridge control |
| `fetchResourceList()` | Fetch the deployed resource catalog |
| `invokeCommand()` | Invoke one generated resource command |
| `buildFlagParser()` | Convert supported JSON Schema to flags |
| `loadCliConfig()` / `saveCliConfig()` | Read and write namespaced CLI config |

## Development

```bash
pnpm --filter @happyvertical/smrt-app-cli test
pnpm --filter @happyvertical/smrt-app-cli typecheck
pnpm --filter @happyvertical/smrt-app-cli build
```

Maintainer patterns and authentication invariants are documented in
[`AGENTS.md`](./AGENTS.md).
