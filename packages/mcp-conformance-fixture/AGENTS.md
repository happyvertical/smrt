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

The fixture objects follow the framework's own conventions, because the
generated surface they produce is what the conformance suite inspects.
`ConformanceGadget.price` is therefore integer minor units (`= 0`, never
`= 0.0`) like every other money field (#2401) — the initializer literal is what
picks the column type, and a decimal one here would demonstrate the wrong rule.

```bash
pnpm test
pnpm typecheck
```
