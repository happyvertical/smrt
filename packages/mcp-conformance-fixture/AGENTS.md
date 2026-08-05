# MCP conformance fixture

Private CI-only executable fixture for the Tier-1 server emitted by
`@happyvertical/smrt-core`'s MCP generator. Generate the server during the
test, exercise modern stdio negotiation directly, then run the pinned official
2026-07-28 server conformance suite through an HTTP adapter around the same
generated factory. Never publish this package or replace the generated source
with a handwritten lookalike.

The pinned upstream conformance CLI still brings the monolithic v1 SDK
transitively. That dependency is an explicit development-tool exception; no
shipped manifest or generated server may depend on `@modelcontextprotocol/sdk`.

```bash
pnpm test
pnpm typecheck
```
