# @happyvertical/smrt-app-mcp

Application-scoped MCP server wrapper for SMRT apps.

## Purpose

- Wraps `@happyvertical/smrt-core` MCP generation with app-level tool allow-lists.
- Filters unauthenticated tool visibility to public read-only tools.
- Provides workflow assertions so app servers can reject unsafe or incomplete tool calls before dispatch.

## Patterns

- Generate tools from core, then filter by allowed class-name prefixes.
- Treat list/get tools as read-only; mutating tools require authentication unless the app deliberately wraps them with stronger policy.
- Keep app policy outside generated tool schemas. The wrapper owns auth, allow-list, and workflow assertion behavior.
- Return 404 for tools outside the app allow-list so private generated tools are not enumerated by mistake.

## Gotchas

- Public tool patterns are still constrained by read-only detection.
- Workflow assertions run before generated tool dispatch and should be deterministic.
- This package is runtime app infrastructure, not the development MCP. Use `@happyvertical/smrt-dev-mcp` for agentic development knowledge, review, and architecture tooling.
- The HTTP surface here is a custom GET/POST tool API, not an MCP protocol transport; real MCP clients connect through the `@happyvertical/smrt-app-cli` stdio bridge today. `src/__tests__/mcp-conformance.spec.ts` runs the official MCP conformance suite against that full composition (`conformance-baseline.yml` holds expected failures; stale entries fail too). A native stateless Streamable HTTP endpoint is #2147.
