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

- Generate tools from core, then filter by allowed class-name prefixes.
- Treat list/get tools as read-only; mutating tools require authentication unless the app deliberately wraps them with stronger policy.
- Keep app policy outside generated tool schemas. The wrapper owns auth, allow-list, and workflow assertion behavior.
- Return 404 for tools outside the app allow-list so private generated tools are not enumerated by mistake.
- Trust only a principal supplied by the application adapter. This package does
  not validate bearer tokens or implement an OAuth authorization server.
- Mount `mountMcpRoute` as one modern `POST` endpoint. It creates a fresh
  protocol server per request, emits no session id, and refuses subscriptions.
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
