# SMRT SvelteKit App

This project uses SMRT objects to generate REST routes, CLI commands, MCP
tools, and agent/developer knowledge artifacts.

## Agent Workflow

- Treat `.smrt/smrt-knowledge.json` as generated local context.
- Regenerate knowledge by running the app build or dev server with
  `smrtPlugin()` enabled.
- Use `smrt knowledge:review-context --format markdown` or the
  `build-domain-review-context` MCP tool before reviewing SMRT object changes.
- Use `smrt knowledge:architecture-context --format markdown` or the
  `build-domain-architecture-context` MCP tool when planning new SMRT objects.
- Keep `CLAUDE.md` as the one-line `@AGENTS.md` shim.

## Package Guidance

- Load page data in `+page.server.ts` server loads that query collections
  directly (see `src/routes/+page.server.ts`); never fetch `/api/*` from
  `$effect`/`onMount` for initial page data.
- Declare `depends('smrt:<collection>')` in loads (route segment naming:
  `/api/items` → `smrt:items`) and call `invalidate('smrt:<collection>')`
  after mutations to refresh in place.
- Opt read-heavy SSR reads into the collection cache with
  `list({ cache: { ttl } })`; skip it for per-user data and admin editors
  (see README "Data loading").
- Keep SMRT object relationship metadata close to the `@smrt()` decorator.
- Use `knowledge: false` only for objects that should stay out of authored
  agent context while remaining in the runtime manifest.
- Use `knowledge: { tags, summary, risks }` for domain objects with important
  review or architecture constraints.
- Do not enable `/__smrt/knowledge` HTTP routes in production without explicit
  admin auth.
