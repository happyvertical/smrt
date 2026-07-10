# s-m-r-t SvelteKit app

This project uses s-m-r-t objects to generate REST routes, CLI commands, MCP
tools, WebMCP definitions, and agent/developer knowledge artifacts.

## Agent workflow

- Treat `.smrt/`, `src/routes/api/**/+server.ts`,
  `src/lib/server/smrt-register.ts`, and
  `src/lib/types/smrt-generated/` as generated.
- Regenerate them with `pnpm build` or `pnpm dev`; run `pnpm db:migrate` after
  object schema changes.
- Keep `CLAUDE.md` as the one-line `@AGENTS.md` shim.

## Data and authorization

- Load initial page data in `+page.server.ts`, return plain serializable rows,
  and never fetch initial `/api/*` data from `onMount` or `$effect`.
- Declare `depends('smrt:<collection>')` in loads and call
  `invalidate('smrt:<collection>')` after mutations.
- URL tenant selection lives in `selectedTenantId`/`selectedTenantSlug`; it is
  not authorization. Only the session-authorized `tenantId` may scope queries.
- Ignore untrusted tenant headers. Use `switchSessionTenant()` for
  membership-gated browser tenant changes.
- Use `assertOperationPermission()` for hand-written server mutations and pass
  the exact session permission snapshot when available.

## Extension rules

- Keep object relationship metadata close to `@smrt()`.
- Add human-facing routes explicitly; generated REST routes do not create nav
  pages.
- Add `@happyvertical/smrt-web` only when a dedicated page imports live browser
  data or registers WebMCP tools. Seed live collections with SSR `initialData`.
- Do not enable knowledge HTTP routes in production without explicit admin auth.
