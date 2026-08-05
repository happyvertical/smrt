# @happyvertical/smrt-mcp-conformance-fixture

Private CI fixture for the MCP 2026-07-28 compatibility rail. The test
generates a Tier-1 server from `MCPGenerator`, negotiates it directly over
stdio with the exact scoped SDK v2 client, then runs the pinned official MCP
server conformance suite against the generated server factory.

```bash
pnpm --filter @happyvertical/smrt-mcp-conformance-fixture test
```

This package is not published and is not a production transport adapter. The
upstream conformance CLI's transitive monolithic v1 SDK is a development-only
exception; all direct dependencies and generated/runtime imports use exact
scoped v2 packages.
