---
title: Application CLI
---

# Application CLI

`@happyvertical/smrt-app-cli` is the command-line interface that s-m-r-t
applications actually ship to their users. It is a small, distributable
client: it authenticates against a deployed application over a device-code
grant, discovers that application's commands at runtime over HTTP, and
invokes them as Bearer-authed REST calls. It has no dependency on a build
step, a local database, or the application's source — it is a thin client
that could run on a laptop that has never seen the app's repository.

> **Three different "CLI"s.** SMRT's docs and source use "CLI" for three
> distinct things. Keep them apart:
>
> | Package | What it is | Who runs it |
> | --- | --- | --- |
> | [`@happyvertical/smrt-cli`](https://github.com/happyvertical/smrt/tree/main/packages/cli) (`smrt`) | Framework developer/ops commands (`db:migrate`, `db:diff`, `init`, `export`, `doctor`) **and** a live, in-process `smrt <object>:<action>` admin CLI, auto-discovered from the manifest — e.g. `smrt product:list` | Framework contributors and app maintainers, on a machine with direct database access |
> | `@happyvertical/smrt-app-cli` (this page) | The branded CLI an application ships to its own users — `<app> <resource> <command>` | End users and operators of a deployed app, over HTTP, with no database access |
> | `CLIGenerator` (`@happyvertical/smrt-core/generators`) | An in-process, per-object admin CLI builder — a different implementation of the same idea as `smrt-cli`'s object commands | Nothing in the SMRT ecosystem currently consumes it — see [Code Generation](./core.md#code-generation) in the core guide |

`smrt-cli`'s object commands and `smrt-app-cli` are both live, correctly used
transports for the same underlying idea (run a command against a `@smrt()`
object) — see [Choosing a transport: local `smrt` vs.
`smrt-app-cli`](#choosing-a-transport-local-smrt-vs-smrt-app-cli) below. This
page covers `smrt-app-cli`. For framework development commands and the local
object CLI, see the
[`smrt-cli` README](https://github.com/happyvertical/smrt/tree/main/packages/cli/README.md).

## Quick start

A published app CLI is typically this small — willgriffin.dev's entire CLI is
19 lines on `createAppCli`:

```ts
#!/usr/bin/env node
import { createAppCli } from '@happyvertical/smrt-app-cli';

const cli = createAppCli({
  name: 'acme',
  defaultServerUrl: 'https://app.acme.test',
});

await cli.run(process.argv.slice(2));
```

`name` supplies the display name, the default `${NAME}_*` environment
variable prefix, and the default local config directory. Point a `package.json`
`bin` entry at this file and publish it; there is no code generation step.

The resulting CLI supports:

```text
acme auth login [--server <url>] [--no-open]
acme auth status
acme auth logout
acme resources [--json] [--debug]
acme mcp tools
acme mcp call <tool> [<json>]
acme <resource> <command> [id] [--flags...] [json-payload]
```

`<resource>` and `<command>` are not hardcoded — they are discovered from the
deployed application, as described below.

### Running without a published binary

The package also ships a configuration-driven `smrt-app` executable, so a
policy runner or operator can drive any app's CLI without maintaining a
branded wrapper:

```bash
SMRT_APP_NAME=acme \
SMRT_APP_ENV_PREFIX=ACME \
SMRT_APP_CONFIG_DIR=acme \
SMRT_APP_DEFAULT_SERVER_URL=https://app.acme.test \
pnpm dlx --package @happyvertical/smrt-app-cli@X.Y.Z \
  smrt-app -- auth status
```

Pin the exact published version in automation. `SMRT_APP_*` variables carry
only non-secret executable configuration; runtime credentials still flow
through the normal `${ENV_PREFIX}_TOKEN` / stored-config resolution.

## Choosing a transport: local `smrt` vs. `smrt-app-cli`

SMRT has two live, correctly-used ways to run a command against a `@smrt()`
object from a terminal. They are not competing implementations of the same
feature — they trade off differently and exist for different callers:

| | Local: `smrt <object>:<action>` | Remote: `smrt-app-cli` |
| --- | --- | --- |
| Package | `@happyvertical/smrt-cli` (the `smrt` bin) | `@happyvertical/smrt-app-cli` |
| Example | `smrt product:list`, `smrt product:get <id>` (lowercased class name, verbatim) | `<app> products list`, `<app> products get <id>` (the manifest's `collection` value — the pluralized class name by default, or a custom `tableName` override) |
| Discovery | In-process: `ObjectRegistry` + the built manifest (`findObjectCommand` → `getObjectCommandsLazy` → `generateObjectCommands`, `packages/cli/src/cli-generator.ts`) | Over HTTP: `GET /api/_resources` against a **running, deployed** application |
| Data access | Opens a real database connection directly, using `cli.database` from `smrt.config` (`getCollection()` and the custom-method path in `cli-generator.ts`) | Bearer-authed HTTP calls to the app's own API — never touches a database directly |
| Who runs it, and where | A developer or operator, on a machine with database credentials and the project's manifest built — a repo checkout, a deploy box, a migration runner | Anyone with an account on the deployed app, from any machine — no database access, no repo checkout, no build step |
| Auth | None built in — whoever can run the process has whatever access `cli.database` grants | Device-code login against the app's own auth (`TerminalAuthService`) |

Both read the same `@smrt({ cli })` config (see [below](#from-decorator-config-to-a-distributable-command))
to decide which commands to expose, so a command's availability is usually
symmetric — a command visible to one is normally visible to the other. The two
`cli` config knobs that break that symmetry deliberately, `http: false` and
`skipApiCheck: true`, exist for the **local** transport specifically — a
command that is meaningful to run in-process, on a machine with direct
database access, but that should not be reachable over HTTP by
`smrt-app-cli` at all (see [below](#from-decorator-config-to-a-distributable-command)
for the exact mechanics and a real example from `@happyvertical/smrt-jobs`).

If you are building the CLI an application ships to its own users or
operators — people who authenticate to the app but never touch its database —
that is `smrt-app-cli`, and the rest of this page is about it. If you are
scripting against a local checkout or a machine that already has database
access (CI, a migration box, a developer's laptop), `smrt <object>:<action>`
is usually the simpler tool; see the
[`smrt-cli` README](https://github.com/happyvertical/smrt/tree/main/packages/cli/README.md)
for its full command surface — this page does not re-document it.

## The login flow (device-code grant)

`auth login` uses the same device-code pattern as `gh auth login` or a smart
TV app: the terminal never sees the user's password, and the browser never
sees a token meant for a script.

1. The CLI `POST`s `/api/cli/auth/start`. The server (via
   `TerminalAuthService.createRequest()`, `@happyvertical/smrt-users`) creates a
   `UsersCliAuthRequest` row holding a short human-typeable `userCode`, a
   SHA-256 hash of a long secret `deviceCode` (the raw device code is never
   persisted), and an `expiresAt` (10 minutes by default). It returns the
   device code, user code, and a `verificationUrl`.
2. The CLI prints the code and opens the verification URL in a browser (or
   prints it for the user to open manually with `--no-open`).
3. The user signs in on the app as normal and approves the code. The server
   flips the request `pending → approved`, binds it to that user and tenant,
   and mints a session. Approval is idempotent (re-approving is a no-op) and
   throttled per user across a sliding window, so brute-forcing another
   user's short code is bounded.
4. The CLI polls `POST /api/cli/auth/token` with the device code on the
   interval the server suggested (2 seconds by default). Each successful
   exchange is single-use: the first poll after approval consumes the
   session and returns `{ status: 'approved', accessToken, tokenType: 'Bearer' }`;
   the request row then reads `consumed`. A poll before approval returns
   `{ status: 'pending' }`; after the TTL elapses without approval, `{ status:
   'expired' }`. The CLI treats 5xx/network failures during polling as
   transient and keeps polling until the window closes; a 410 or hard
   rejection stops it immediately.
5. The CLI stores the resulting bearer token locally, keyed by the exact
   issuer the server reported. Changing the configured server, or the
   server rotating its issuer, invalidates the stored token rather than
   silently reusing it against a different origin.

`auth status` calls `GET /api/cli/auth/session` with the stored token and
prints the resolved session; `auth logout` calls `DELETE
/api/cli/auth/session` and clears the local token even if that call fails.

## Discovery: `GET /api/_resources`

Everything after `auth` is generic. The CLI has no built-in notion of
"resources" — it asks the deployed app what commands exist.

### What the endpoint returns

`createResourceListHandler()` (`@happyvertical/smrt-users/sveltekit`) builds
the handler. It walks `ObjectRegistry` for every `@smrt()` class, and for
each one whose `@smrt({ cli })` config is not `false`:

- resolves which methods are exposed as commands from the class's
  `@smrt({ cli })` config (`resolveCliIncludedMethods`) — see
  [From decorator config to a distributable command](#from-decorator-config-to-a-distributable-command)
  below;
- binds each exposed method to the same URL shape the REST generator and
  generated SvelteKit routes use: an HTTP method, and path segments after
  `/api/<collection>[/<id>]/`;
- attaches the method's JSON Schema (for flag parsing) and any declared retry
  / optimistic-concurrency requirements.

The response shape (`ResourceListResponseBody`):

```ts
interface ResourceListResponseBody {
  user: { authenticated: boolean; id?: string };
  warnings: string[]; // methods that couldn't be exposed as commands, and why
  resources: Array<{
    slug: string; // first CLI positional, same as apiPath — the manifest's
    // `collection` value: pluralized class name by default, `tableName` if overridden
    className: string;
    apiPath: string; // URL segment, e.g. `products`
    label: string;
    commands: Array<{
      methodName: string; // source casing — the API's identity
      commandName: string; // kebab-case, what the user types
      kind: 'crud' | 'custom';
      scope: 'item' | 'collection';
      httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      pathSegments: string[];
      parameters?: Record<string, unknown>; // JSON Schema
    }>;
  }>;
  artifact?: DiscoveryConformanceArtifact; // versioned, integrity-checked copy
}
```

Every command a caller sees is also filtered through a `commandPolicy`
(default: deny anonymous, allow any authenticated caller) — this is capability
filtering, not row-level authorization; individual routes remain the
authority for "can this user act on this row."

### Mounting the route today

`GET /api/_resources` is **hand-mounted, not generated** — there is no Vite
plugin output for it yet (tracked separately, #2655). A consuming SvelteKit
app wires it up itself:

```ts
// src/routes/api/_resources/+server.ts
import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
import './smrt-register'; // trigger @smrt() decorator side effects

export const GET = createResourceListHandler({
  ensureRegistry: async () => {
    await import('./smrt-register');
  },
  commandPolicy: ({ command, session }) => session.user != null,
  kebabRoutes: true, // match the vite-plugin's `svelteKit.kebabRoutes` setting
});
```

`ensureRegistry` exists because a fresh request-handler process may not have
imported the app's `@smrt()` classes yet — without it, discovery can return
zero resources. `kebabRoutes` must match whatever the Vite plugin's
`svelteKit.kebabRoutes` option is set to, or the CLI will build URLs that
don't match the generated routes.

### Conformance artifact

The response's `artifact` field is a versioned, deterministically ordered,
integrity-hashed copy of the discovery payload (`sha256:<hex>` digest). The
CLI validates it before trusting the embedded payload
(`validateDiscoveryConformanceArtifact` from
`@happyvertical/smrt-users/app-contract`). A downstream app that wants to pin
a captured contract in its own tests can fetch `/api/_resources` and validate
the artifact the same way; see the
[`smrt-app-cli` README](https://github.com/happyvertical/smrt/tree/main/packages/app-cli/README.md#discovery-conformance-artifact)
for the full snippet.

## From decorator config to a distributable command

A method becomes a CLI command purely through decorator config — there is no
separate CLI-specific code to write.

```ts
@smrt({
  api: { include: ['list', 'get', 'create'] },
  cli: true, // CRUD only, intersected with what the API exposes
})
class Product extends SmrtObject { /* ... */ }
```

`cli` accepts:

| Value | Effect |
| --- | --- |
| `true` | Expose `list`/`get`/`create`/`update`/`delete`, intersected with the API's exposed actions |
| `false` | No CLI commands for this class at all |
| `{}` (object with no `include`) | Same as `true` — CRUD only |
| `{ include: [...] }` | Expose exactly these commands (CRUD names and/or custom method names), intersected with what the API exposes |
| `{ exclude: [...] }` | Drop specific commands from the otherwise-CRUD default or `include` list |
| `{ skipApiCheck: true }` | Skip the build-time check that every `include` entry is also API-exposed — for commands meant to run only through the local `smrt <object>:<action>` CLI (`@happyvertical/smrt-cli`), never over HTTP |
| `{ http: false }` | Keep the command available to the local `smrt <object>:<action>` CLI but exclude it from `GET /api/_resources`, so `smrt-app-cli` never advertises or invokes it over HTTP |

The API intersection exists because `smrt-app-cli` invokes commands over
HTTP: a method with no matching API route has nothing to call. The local
`smrt <object>:<action>` CLI (`@happyvertical/smrt-cli`, see [Choosing a
transport](#choosing-a-transport-local-smrt-vs-smrt-app-cli) above) has no
such requirement — it opens a database connection directly and calls the
collection method in-process — which is why `skipApiCheck` exists for
CLI-only, HTTP-less methods. A real example, `@happyvertical/smrt-jobs`'
`SmrtJobEvent` (`packages/jobs/src/smrt-job-event.ts`):

```typescript
@smrt({
  api: false, // no REST surface at all — reads go through tenant-aware
              // collection methods, not generated routes
  cli: { include: ['list', 'get'], http: false, skipApiCheck: true },
  mcp: false,
})
class SmrtJobEvent extends SmrtObject { /* ... */ }
```

`smrt smrtjobevent:list` works for an operator with database access;
`skipApiCheck` acknowledges there is no API route to check `include` against
(there is no API surface at all here), and `http: false` keeps it that way —
`smrt-app-cli` never sees `smrtjobevent` as a resource.

A command's parameters come straight from the method's JSON Schema. The CLI's
flag parser (`buildFlagParser` /
`classifySchema`, `@happyvertical/smrt-app-cli`) supports flat
`string`/`integer`/`number`/`boolean`/`enum` properties and single-level
arrays of scalars; anything with a nested object, `oneOf`/`anyOf`/`allOf`, or
`$ref` falls back to a positional JSON payload (`<cli> <resource> <command>
'{"...": "..."}'`) instead of guessing a flag shape.

```console
$ acme products list --limit 20 --where '{"status":"active"}'
$ acme products create --name Widget --price 1999
$ acme products update prod_123 --name "New name"
$ acme products delete prod_123
```

Item-scope commands (`scope: 'item'`) take the id as the first positional
argument after the command name; collection-scope commands do not.

## Extending the CLI

`extraCommands` adds app-specific commands that are dispatched **before**
built-ins and before resource-slug matching:

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

An extra command with the same name as a built-in (`auth`, `resources`,
`mcp`) wins but prints a one-line warning the first time it shadows one; an
extra command that collides with a discovered resource slug wins silently
(no discovery round-trip on every invocation to check), so namespace
app-specific commands defensively.

## MCP bridge

The same CLI can expose a deployed app's MCP surface to local stdio clients
(editors, AI tools):

```ts
await cli.startMcpBridge({ name: 'acme-mcp', version: '1.0.0' });
```

This pipes the app's REST-shaped `/api/mcp/tools` + `/api/mcp/call` endpoints
(both configurable, `toolsPath`/`callPath`) to a local `StdioServerTransport`.
Those endpoints, and the modern `mountMcpRoute` Streamable HTTP endpoint they
alias, are mounted with
[`@happyvertical/smrt-app-mcp`](https://github.com/happyvertical/smrt/tree/main/packages/smrt-app-mcp/README.md).
The package also ships a generic `smrt-mcp-bridge` binary that reads
`--env-prefix=…` from argv, for ad-hoc use without a package-specific entry
point. For registering an MCP client against a public deployment's OAuth
server, see [Remote MCP authorization](./architecture/remote-mcp-authorization.md).

## Configuration and local storage

- `name` sets the display name and the default `${NAME}_*` environment prefix
  (override with `envPrefix`); `configDir` overrides the local config
  namespace (default: lowercased `name`).
- Resolution order for the server URL and token: `${PREFIX}_SERVER_URL` /
  `${PREFIX}_TOKEN` environment variables, then the local config file
  (`~/.config/<configDir>/config.json`, overridable with
  `${PREFIX}_CLI_CONFIG`), then `defaultServerUrl`.
- `requireSecureServerUrl: true` rejects any effective server URL that is
  neither HTTPS nor loopback HTTP (`localhost` / `127.0.0.1` / `[::1]`) —
  the `smrt-app` executable always applies this policy.
- Bearer tokens are bound to the exact issuer the device-code flow returned
  and to the server selected at login; the CLI never reuses a token after
  either changes.

## `@happyvertical/smrt-app-mcp`: the sibling gap

`@happyvertical/smrt-app-mcp` — the SvelteKit adapter that mounts an app's HTTP
MCP surface (`createMcpAppServer`, `mountMcpRoute`) — has the same kind of
gap: no page in `docs/content/`, only its package README and `AGENTS.md`.
Its README is already thorough (tool policy, task extension, caching
contract); folding it into a proper guide page is a larger job than this
issue's scope and is left as a follow-up rather than done partially here.

## Public API reference

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

See the
[`smrt-app-cli` README](https://github.com/happyvertical/smrt/tree/main/packages/app-cli/README.md)
for the full export list and package-level development commands, and
[`AGENTS.md`](https://github.com/happyvertical/smrt/tree/main/packages/app-cli/AGENTS.md)
for maintainer-level invariants.
