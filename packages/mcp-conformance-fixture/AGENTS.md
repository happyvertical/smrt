# @happyvertical/smrt-mcp-conformance-fixture

Private CI gate: runs the official `@modelcontextprotocol/conformance` suite
against a server generated from the Tier-1 runtime template
(`packages/core/src/generators/mcp-runtime-template.ts`). Never published.

## How it works

1. `src/fixture-objects.ts` registers two plain `@smrt()` objects with
   explicit `api`/`mcp`/`cli` config.
2. The spec calls `MCPGenerator.generateServer()` to bake a real single-file
   stdio server into `.generated-tmp/` (gitignored), then runs it via `tsx` —
   exactly the artifact downstream apps ship.
3. The conformance CLI only tests HTTP servers, so a per-request forwarder
   mirrors the generated server's `serverInfo`/capabilities onto a stateless
   `StreamableHTTPServerTransport`, proxying `tools/list` and `tools/call`
   through one stdio SDK `Client`. Results pass through verbatim; only the
   transport envelope is the forwarder's.
4. `conformance-baseline.yml` is the expected-failure baseline: unexpected
   failures fail CI, and so do stale entries (a baselined scenario that
   starts passing).

Sibling conformance harnesses: `packages/smrt-dev-mcp` (real server over
HTTP directly) and `packages/smrt-app-mcp` (HTTP tool API composed with the
app-cli stdio bridge).

## Gotchas

- **Requires built workspace deps**: the spawned server imports
  `@happyvertical/smrt-core` / `smrt-config` package exports (dist). Run
  `npx turbo build --filter=@happyvertical/smrt-core...` in a fresh worktree
  first.
- **The generated server never touches a database here**: conformance
  scenarios only call suite fixture tool names, and generated tool bodies
  connect lazily per call — so no schema bootstrap is needed.
- **Do not hand-edit `.generated-tmp/`**: it is regenerated every run and
  removed on cleanup.
- The template intentionally stays stdio-only (#1540 trust boundary); a
  native spec-compliant HTTP endpoint is #2147's scope. When the template
  moves to the MCP SDK v2 line, bump `SPEC_VERSION` here to `2026-07-28` and
  re-derive the baseline.
