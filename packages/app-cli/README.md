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

## Discovery conformance artifact

`createResourceListHandler()` includes an `artifact` beside the compatible
`user`, `warnings`, and `resources` response fields. The artifact has a stable
schema selector, version, canonical ordering, and a `sha256:<hex>` digest. The
CLI validates it before using its embedded discovery payload.

For a released downstream app, install the exact published
`@happyvertical/smrt-users` version and pin a captured artifact like this:

```ts
import {
  validateDiscoveryConformanceArtifact,
} from '@happyvertical/smrt-users/app-contract';

const response = await fetch('https://app.example/api/_resources');
const body = await response.json();
const artifact = validateDiscoveryConformanceArtifact(body.artifact);

console.log(artifact.schema, artifact.version, artifact.integrity.digest);
// Store all three selectors and the canonical JSON in your packaged-runtime test.
```

The result contract embedded in the artifact names the common `code`,
`message`, `details`, `retryable`, `correlationId`, `idempotencyKey`, and
`expectedVersion` metadata. `mcp tools` and `mcp call` print this as a JSON
success/error envelope. HTTP failures may use either a conventional top-level
metadata object or `{ error: metadata }`; both normalize to that same shape.
The stdio bridge carries it in MCP `_meta` under
`io.happyvertical/smrt`. It deliberately does not synthesize MCP
`structuredContent`.

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
- Device-flow responses identify their issuer. Tokens are keyed by that exact
  issuer and are not reused when the configured server changes.

For standards-based remote MCP OAuth registration, use
`registerMcpClient()` (Client ID Metadata Document first, executable RFC 7591
DCR fallback with `application_type`) and follow the
[remote MCP authorization guide](../../docs/content/architecture/remote-mcp-authorization.md).

## Public API

| Export | Purpose |
| --- | --- |
| `createAppCli()` | Build the branded CLI and MCP bridge |
| `createMcpStdioBridge()` / `runMcpStdioBridge()` | Lower-level bridge control |
| `fetchResourceList()` | Fetch the deployed resource catalog |
| `invokeCommand()` | Invoke one generated resource command |
| `buildFlagParser()` | Convert supported JSON Schema to flags |
| `loadCliConfig()` / `saveCliConfig()` | Read and write namespaced CLI config |
| `resolveMcpClientRegistration()` | Inspect the selected Client ID Metadata or DCR path |
| `registerMcpClient()` | Use Client ID Metadata or execute the DCR fallback |

## Development

```bash
pnpm --filter @happyvertical/smrt-app-cli test
pnpm --filter @happyvertical/smrt-app-cli typecheck
pnpm --filter @happyvertical/smrt-app-cli build
```

Maintainer patterns and authentication invariants are documented in
[`AGENTS.md`](./AGENTS.md).
