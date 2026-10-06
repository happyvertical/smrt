# @happyvertical/smrt-app-mcp

Application-scoped MCP server wrapper for SMRT apps. The core owns generated
tool policy; `./sveltekit` owns the stateless Streamable HTTP transport.

## Purpose

- Wraps `@happyvertical/smrt-core` MCP generation with app-level tool allow-lists.
- Filters unauthenticated tool visibility to public read-only tools.
- Applies an optional principal-aware policy consistently to discovery and calls.
- Provides workflow assertions so app servers can reject unsafe or incomplete tool calls before dispatch.
- Exposes an opt-in durable Tasks extension through `@happyvertical/smrt-jobs`.

## Patterns

- Generate tools from core scoped to the allow-list (`MCPConfig.classNames`),
  then filter by allowed class names: a duplicate tool name among registered
  classes the app never publishes must not fail its catalog or calls (#3490).
  `mountMcpAppRoute`/`createDefaultMcpAppServer` resolve each model
  constructor to its registry-qualified name, so a same-named class elsewhere
  never collides; a raw simple name two classes share fails closed.
- Treat list/get tools as read-only; mutating tools require authentication unless the app deliberately wraps them with stronger policy.
- Keep app policy outside generated tool schemas. The wrapper owns auth, allow-list, and workflow assertion behavior.
- Return 404 for tools outside the app allow-list so private generated tools are not enumerated by mistake.
- Trust only a principal supplied by the application adapter. This package
  does not implement an OAuth authorization server. The opt-in `./auth` entry
  validates JWT access tokens and requires an application-owned principal mapper.
- Mount `mountMcpRoute` as one modern `POST` endpoint. It creates a fresh
  protocol server per request, emits no session id, and refuses subscriptions.
- `mountMcpAppRoute` (`src/defaults.ts` + `./sveltekit`) is the one-call app
  route: explicit `models` allow-list, required `requiredScopes`, principal from
  session locals (`principalFromSessionLocals`). App policies compose with the
  default and may only narrow it. Its `Origin` check (default on; opt-in on
  `mountMcpRoute`) runs before auth and dispatch; no-`Origin` clients pass.
  `effects` filters the catalog by `mcpToolEffect` (excluded tools 404).
  `auth` swaps in bearer principals; `bindPrincipal` runs their dispatch in
  the app's principal context (RLS transaction), failing closed, and
  authorizes with the binder's narrowed (live) scopes; task lifecycle calls
  re-check the originating action against the allow-list and `effects`,
  after a principal-level `taskPrincipalPolicy` (defaults: scope policy);
  `mountMcpProtectedResourceMetadataRoute` serves only the advertised path.
- `createHostedMcpResourceAuth({ profile, runtime })`: locally, a runtime
  `verifyLocalMcpToken` yields the `sessionFallback` adapter
  (`createLocalMcpTokenAuth`): no `Authorization` header keeps the session
  principal; a presented bearer must verify (401, never cookie fallback); no
  metadata (404). Hosted, `runtime.resolveMcpPrincipal` is the default
  identity mapping; an explicit `resolvePrincipal` overrides it.
- Adapters stamp `principal.tenantBinding` for `bindPrincipal`: the local
  token adapter always `direct`; the JWT adapter the mapping's value or
  `direct-or-inherited`. Never derive it from request input. Both adapters
  read principals/mappings from own data only (`own-data.ts`): inherited
  values, accessors and poison keys deny.
- Keep tool catalogs private by default. Public caching requires an explicit
  attestation and a global, unauthenticated, read-only, non-tenant catalog with
  no principal-aware policy.

## Gotchas

- Public tool patterns are still constrained by read-only detection.
- Policy errors fail closed and expose only the shared safe denial envelope.
- Workflow assertions run before generated tool dispatch and should be deterministic.
- Tasks require a stable authenticated principal id, preserve its tenant boundary,
  and require the deployment to run a `TaskRunner` for the `mcp-tasks` queue.
- This package ships no stdio executable. Use `@happyvertical/smrt-app-cli` to
  bridge a deployed app endpoint to a local MCP client.
- `mountMcpToolsRoute` and `mountMcpCallRoute` are deprecated REST-shaped
  compatibility aliases, not MCP transports.
- This package is runtime app infrastructure, not the development MCP. Use `@happyvertical/smrt-dev-mcp` for agentic development knowledge, review, and architecture tooling.
