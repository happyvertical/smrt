# @happyvertical/smrt-app-mcp

App-runtime MCP server scaffolding for s-m-r-t apps. Provides:

- **Core** — `createMcpAppServer({ smrtOptions, serverInfo, allowedClassNames, publicToolPatterns?, toolListCache?, toolPolicy?, workflowAssertions?, workflowTools? })` returning `{ listTools, callTool }` wired to `@happyvertical/smrt-core/generators/mcp`.
- **SvelteKit adapters** (`./sveltekit`) — `mountMcpRoute` mounts a modern
  2026-07-28 stateless Streamable HTTP MCP endpoint. The REST-shaped
  `mountMcpToolsRoute` / `mountMcpCallRoute` aliases remain available for one
  release while applications migrate.

## One-call app route

Most applications need no server helper module. `mountMcpAppRoute` builds the
server from the app's own declared models, maps the request principal from the
SvelteKit session locals populated by `createSessionHandler`
(`@happyvertical/smrt-users/sveltekit`), and mounts the stateless endpoint:

```ts
// src/routes/api/mcp/+server.ts
import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { Item } from '$lib/objects/Item';
// The app's `createSmrtSvelteKitRuntime()` (@happyvertical/smrt-app-runtime/sveltekit).
import { runtime } from '$lib/server/smrt';

export const POST = mountMcpAppRoute({
  runtime,
  models: [Item],
  requiredScopes: ['items.read'],
  effects: ['read'],
});
```

- **Runtime** — `runtime` (any `McpAppRouteRuntime`; the s-m-r-t SvelteKit
  runtime satisfies it) supplies three bindings, each still overridable:
  `smrtOptions` defaults to `() => ({ db: runtime.databaseConfig() })` (under
  RLS, the request's transaction-bound database), `bindPrincipal` to
  `runtime.runAsPrincipal`, and `auth` to
  `createHostedMcpResourceAuth({ profile, runtime })` for the profile resolved
  on each request (after the origin check), so the module has no top-level
  `await`. It fails closed: a runtime missing a binding throws at mount; an
  unresolvable or unknown profile, or a hosted profile without its
  `SMRT_MCP_*` configuration, rejects the request (HTTP 500) before any
  dispatch rather than serving it without the profile's bearer adapter. An
  explicit
  `auth` (including `null`), `bindPrincipal` or `smrtOptions` is used as
  given. Without `runtime`, pass `smrtOptions` (and optionally `auth` and
  `bindPrincipal`) yourself, as before.

- **Allow-list** — exactly the `models` listed (registered `@smrt()`
  constructors; anything else throws at construction). Other registered
  models are never enumerated; direct calls to them return the unknown-tool
  error (404 semantics).
- **Principal** — `principalFromSessionLocals` reads only `locals.user.id`, the
  session-authorized `locals.tenantId`, and `locals.permissions` (as sorted
  `scopes`, `kind: 'human'`). Missing or malformed fields mean unauthenticated.
  URL-selected tenants, headers and bodies are never identity inputs. Override
  with `resolvePrincipal`.
- **Policy** — `requiredScopes` is required: every authenticated principal must
  be an accepted kind (`principalKinds`, default `['human']`) with an id, a
  tenant, and every listed scope, for every tool and resource. Unauthenticated
  callers keep the base rule (only `publicToolPatterns` read-only tools; none by
  default) and mutating tools always need a principal. A supplied `toolPolicy`
  or `resourcePolicy` is composed with this default and can only narrow it;
  for a wider policy, call `createMcpAppServer` and `mountMcpRoute` directly.
  Because the default is principal-aware, `tools/list` stays `private` even
  with a public-cache attestation. A scope applies uniformly to every
  published tool, so a read scope such as `items.read` must be paired with
  `effects: ['read']` (below) unless the app adds per-operation policy.
- **Effects** — `effects` (also on `createMcpAppServer`) limits the catalog to
  tools whose effect is listed: `'read'`, `'write'`, `'destructive'`, the
  WebMCP vocabulary. `mcpToolEffect` classifies with the existing read-only
  detection (canonical `readOnlyHint`, else the `_list`/`_get` name rule); any
  other tool is `destructive` unless it declares `destructiveHint: false`.
  Excluded tools are absent from `tools/list`, and a direct call gets the same
  unknown-tool error as a nonexistent name, so they cannot be enumerated.
  Omitted, every allow-listed tool is published (unchanged behaviour).
  Durable task lifecycle calls (`tasks/get`, `tasks/update`, `tasks/cancel`)
  re-apply the allow-list and `effects` filter to the task's originating
  action, the generated tool for the class (simple or qualified name) and
  method its job persists; a task whose action is excluded, or maps to no
  allow-listed generated tool, is answered exactly like an unknown task.
  `toolPolicy` is not re-applied to lifecycle calls: a task created by an
  application workflow does not record which workflow created it, and such
  workflows often front a policy-hidden generated task tool. Owner and tenant
  scoping apply to every lifecycle call. Principal-level authority is checked
  first, before the task store is touched: `createDefaultMcpAppServer` (and so
  `mountMcpAppRoute`) gates every lifecycle call on its principal scope policy
  — accepted kind, id, tenant and every `requiredScopes` entry, evaluated on
  the *effective* bound principal — so a bearer whose live permissions were
  revoked cannot read, resume (supply input to) or cancel an existing task;
  restoring the permission restores access. A custom `createMcpAppServer`
  supplies the same gate with `taskPrincipalPolicy({ principal })`; without
  it, a custom `toolPolicy` is not applied to lifecycle calls. A denial or a
  thrown predicate is answered as an unknown task.
- **Server** — `serverInfo` defaults to `{ name: 'smrt-app', version: '0.1.0' }`;
  every other `createMcpAppServer` option (`workflowTools`, `resources`,
  `workflowAssertions`, `toolListCache`, …) passes through. The handler's
  `server` property exposes the policy core. The same defaults are available
  without SvelteKit as `createDefaultMcpAppServer` from the root entry.

- **Origin check** — on by default (`checkOrigin`). Before bearer
  authentication, principal resolution or any dispatch, a request whose
  `Origin` is present but is not the request URL's own origin (exact scheme,
  host and port) or one of `trustedOrigins` — including `Origin: null` and
  sibling subdomains — gets HTTP 403 with the JSON-RPC error data
  `{ code: 'mcp_origin_denied', retryable: false }`, naming no origins. With
  no `Origin`, a `Sec-Fetch-Site` of `cross-site`/`same-site` is also
  refused. Clients that send no browser origin signals (server-side MCP
  clients, the `smrt-app-cli` bridge) are unaffected; a browser-hosted MCP
  client must be listed in `trustedOrigins`. Bearer requests are checked too:
  the token is not ambient authority, but the MCP Streamable HTTP transport
  requires origin validation and server-side remote clients send no `Origin`.
  "Own origin" is `event.url`, so behind a rewriting proxy configure the
  SvelteKit adapter's origin (adapter-node `ORIGIN`, or its
  `PROTOCOL_HEADER`/`HOST_HEADER`) or add the public origin to
  `trustedOrigins`; this package never reads `X-Forwarded-*`.
  `checkOrigin: false` opts out. `mountMcpRoute` accepts the same options,
  off unless set.

Bearer authentication for hosted profiles is an `auth` option on both
`mountMcpRoute` and `mountMcpAppRoute`. When its source yields an adapter,
every request must carry a valid bearer token and the adapter's principal
replaces the session principal; `null` (the `local` profile) keeps the session
principal. Pass `bindPrincipal` (for example `runtime.runAsPrincipal` from
`@happyvertical/smrt-app-runtime/sveltekit`) so that, after bearer
authentication, the `smrtOptions` database thunk, task handling and tool
execution all run inside a context bound to that principal: under
`database-rls` the runtime opens a fresh RLS transaction publishing the bearer
user, tenant and its live membership permissions capped by the token's scopes,
instead of the anonymous (or a cookie user's) request transaction. The binder
hands dispatch the principal's effective scopes (`runAsPrincipal` passes the
token scopes still granted by live permissions), and the tool policy
authorizes with those, intersected with the token's: a revoked permission
denies the tool before dispatch even under `application` isolation, while the
principal keeps the tools its remaining permissions allow. A binder can never
widen scopes or change the principal's id or tenant. A binder
that fails before dispatch answers HTTP 403 with the safe
`mcp_tool_access_denied` error; the response is materialized inside the
binding. `createHostedMcpResourceAuth` from `./auth` builds that source from
`SMRT_MCP_RESOURCE`, `SMRT_MCP_ISSUER`, `SMRT_MCP_JWKS_URI` and
`SMRT_MCP_SCOPES`, caching one adapter and retrying a failed construction.

Set `allowAnonymous: true` only for an intentionally public endpoint. It lets
requests with no `Authorization` header reach the normal anonymous policy:
only declared public, read-only tools and `public: true` resources are visible.
It does not make protected tools or resources public, and any supplied bearer
is always authenticated first. A malformed, expired, revoked, or otherwise
invalid bearer returns the adapter's 401 challenge and never falls back to
anonymous or session access. `allowAnonymous` also ignores session locals and
custom principal resolvers for headerless requests; local-token adapters retain
their separate `sessionFallback` behavior.

`mountMcpAppRoute({ runtime })` and
`mountMcpProtectedResourceMetadataRoute({ runtime })` build it for you, one
shared adapter per runtime and profile:

```ts
// api/mcp/+server.ts
export const POST = mountMcpAppRoute({
  runtime, models: [Item], requiredScopes: ['items.read'], effects: ['read'],
});
// .well-known/oauth-protected-resource/api/mcp/+server.ts
export const GET = mountMcpProtectedResourceMetadataRoute({ runtime });
```

The hand-wired equivalent, still supported (and the way to pass
`resolvePrincipal` to override the hosted identity mapping), is:

```ts
import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
const { profile } = await runtime.resolvedRuntime();
const auth = createHostedMcpResourceAuth({ profile, runtime });
export const POST = mountMcpAppRoute({
  models: [Item], requiredScopes: ['items.read'], effects: ['read'],
  smrtOptions: () => ({ db: runtime.databaseConfig() }),
  auth, bindPrincipal: runtime.runAsPrincipal,
});
export const GET = mountMcpProtectedResourceMetadataRoute(auth);
```

`createHostedMcpResourceAuth`'s `runtime` option takes any object with the
optional `verifyLocalMcpToken(token)` and `resolveMcpPrincipal(identity)`
methods; the s-m-r-t SvelteKit runtime has both.

- **Local profile.** With `verifyLocalMcpToken`, the source yields the
  `createLocalMcpTokenAuth` adapter for owner-minted tokens
  (`smrt app token --scopes items.read`). A request with no `Authorization`
  header keeps the session principal, exactly as before. A presented bearer
  must verify: an unknown, revoked or expired token is a bare 401
  (`WWW-Authenticate: Bearer error="invalid_token"`) and never falls back to
  the cookie. The origin check still runs first. Without the runtime the
  source yields `null`, as before.
- **Hosted profiles.** Without `resolvePrincipal`, the runtime's
  membership-backed `resolveMcpPrincipal` maps the verified issuer/subject to
  a user linked through `oidc_identities` with exactly one active tenant
  membership, and denies anything else. Pass `resolvePrincipal` when users
  belong to several tenants.

`mountMcpProtectedResourceMetadataRoute` serves the RFC 9728 document only at
the adapter's advertised `metadataUrl` path. It returns 404 for any other
path, and in the `local` profile (no adapter, or the local token adapter). It
does not implement an OAuth authorization server.

For piping a deployed app's MCP surface to a local stdio MCP client, see `@happyvertical/smrt-app-cli` — the client-side runtime CLI exposes a `startMcpBridge()` default and a generic `smrt-mcp-bridge` bin.

For public deployments, follow the
[remote MCP authorization contract](../../docs/content/architecture/remote-mcp-authorization.md).
The server trusts the principal supplied by the application adapter. Validate
bearer tokens at an application gateway or with the server-only `./auth` JWT
adapter, then resolve fresh application membership and tenant authority on every
request. The OAuth issuer remains operator-owned; this package does not implement
an OAuth authorization server.

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

`workflowTools` composes explicitly declared application workflows into this
same catalog. Every workflow must declare its canonical `effect`,
`idempotent`, and `openWorld` values; title, icons, and a portable UI resource
association are host presentation metadata only. The configured `toolPolicy`
and `workflowAssertions` run for both discovery and direct calls before the
workflow handler receives the trusted principal and arguments.
Authored names must be lowercase snake_case strings of at most 64 characters;
input and output schemas must both have object roots. Invalid declarations fail
at server construction. Ordinary handler exceptions return a generic `isError`
result with text and structured error data; internal exception details are not
exposed. Intentional `McpAccessError` denials retain the transport's access-error
contract.

```ts
workflowTools: [{
  name: 'application_prepare',
  description: 'Prepare an application for human review',
  title: 'Prepare application',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  outputSchema: { type: 'object', properties: { prepared: { type: 'boolean' } } },
  effect: 'write', idempotent: true, openWorld: false,
  ui: { resourceUri: 'ui://application/prepare.html', visibility: ['app'] },
  async execute({ arguments: args, principal }) {
    return { content: [{ type: 'text', text: 'Prepared for review.' }], structuredContent: { prepared: true } };
  },
}],
```

The resulting descriptor preserves `_meta.ui.resourceUri` and optional
`_meta.ui.visibility` through SDK-v2 `tools/list`, while ordinary clients retain the text and structured result.
The resource implementation itself is staged separately; metadata neither
loads a resource nor grants an application permission.

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

The route constructs a fresh protocol server for every HTTP request. It relies
on no transport session state, sticky load-balancer routing, or held event
stream, so it is safe behind ordinary round-robin deployment. This
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

Applications that have not moved their route path can retain the deprecated
handlers below while they migrate. They are REST-shaped compatibility aliases,
not an MCP transport. Direct calls to a tool outside the app allow-list
continue to receive the safe 404 behavior.

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

## Prebuilt MCP Apps resources

Declare portable HTML resources alongside workflow tools. A URI must contain
its explicit version as a path segment; tool `ui.resourceUri` references must
resolve to a declared resource. The server snapshots UTF-8 bytes, a SHA-256
digest and portable MIME `text/html;profile=mcp-app` at construction time. It
never compiles source or inserts principal data into templates.

```ts
const server = createMcpAppServer({
  smrtOptions: () => ({ db }),
  serverInfo: { name: 'application', version: '1' },
  allowedClassNames: [],
  resources: [{
    uri: 'ui://application/v1/view.html',
    version: 'v1',
    name: 'Application view',
    html: prebuiltHtml,
  }],
  workflowTools: [viewWorkflow], // ui.resourceUri points at the declaration
  resourcePolicy: ({ principal }) =>
    principal?.id === ownerId && principal?.tenantId === activeTenantId,
});
```

Resources are private by default and require a stable principal id plus an explicit
`resourcePolicy`; an omitted policy denies both listing and reads. Only an
explicit `public: true` declaration permits anonymous reads of a static
artifact. `resourcePolicy` runs afresh for both catalog and direct reads; errors
fail closed. Every associated tool must also pass the ordinary tool policy.
Unknown and denied URIs return the same error. The resource policy owns tenant
and owner restrictions; static templates contain no candidate records, tokens
or sessions. Retrieve changing data through authorized tools instead.

Optional `metadata` carries extension JSON into catalog/read `_meta`, with a
64 KiB and 16-level limit. Non-JSON values, accessors, cycles and reserved `ui`
or `com.happyvertical.smrt/resource` keys are rejected. Metadata grants no access.

The raw HTML budget is 100 KiB. CSP connection, resource, frame and base origins
default to empty lists; permissions default to none. Origins must be exact HTTPS
origins (WSS is additionally accepted for connections). Unknown CSP/permission
fields are rejected. Bundle assets inline or use literal absolute references to
explicitly declared resource/frame origins. Relative asset references,
CSS imports/escapes and alternate image/source functions, base/object/embed/meta tags, srcset and srcdoc are rejected
by the conservative static validation profile. HTML is parsed before validation;
script raw text and inert comments are not CSS. Decoded attribute URLs must still
match declared origins. Raster data images are permitted.
Dynamic JavaScript networking requires host CSP enforcement; declarations are
not a JavaScript sandbox. Host rendering and enforcement remain M4/M8 gates.

`mountMcpRoute` exposes native `resources/list` and `resources/read`, with
private, zero-TTL results and no subscriptions or HTTP sessions. Missing UI
capabilities do not remove ordinary text/structured tool results. The app CLI
bridge now defaults to this modern `/api/mcp` endpoint; use explicit
`transport: 'legacy-rest'` (or the generic bin's `--legacy-rest`) only during a
migration from `/api/mcp/tools` and `/api/mcp/call`. The modern bridge uses SDK v2,
re-resolves credentials per request, refuses redirects, and forwards resource
and tool metadata without inventing UI or extension capabilities.

Generated tool allow-lists use the generator-owned original class identity, even
when the advertised name is a canonical alias. Core generates tools only for the
allow-listed classes, so a duplicate tool name among registered classes the app
does not publish (a consumed package's models, say) cannot fail `tools/list` or
`tools/call`; a duplicate within the allow-list still fails closed. The
model-based routes (`mountMcpAppRoute`, `createDefaultMcpAppServer`) allow-list
each constructor's registry-qualified name, so an app model that shares a
simple name with another registered class gets its own tools; a raw
`allowedClassNames` simple name that two classes share is refused. Guards keyed by either the alias
or original tool name run before both direct and task dispatch. Authored workflows
retain their explicit names and effect policy; catalogs containing authored
workflows keep private cache scope because they have no generated tenant identity.

## Remote JWT authorization

The server-only `@happyvertical/smrt-app-mcp/auth` entry exports
`createMcpResourceAuth` for protected-resource metadata, bearer challenges and
JWT verification against a configured existing issuer. A required application
callback rechecks actor and active tenant membership per request. See the
[remote authorization contract](../../docs/content/architecture/remote-mcp-authorization.md)
for route wiring, local/hosted profiles and the explicit JWT revocation limits.
