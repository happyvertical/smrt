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
- Never improvise setup internals. Run `pnpm app:install`; use individual
  `app:*` commands only for recovery or explicit operator control.
- Recover an interrupted unclaimed owner invitation with `pnpm app:recover`,
  then `pnpm app:start` and `pnpm app:open`; never print or copy its token.
- Treat `smrt.config.ts` `runtime.profile` as the only infrastructure selector.
- Treat the private health route's configuration digest as an identity only;
  it must never contain or hash provider credentials.

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
- Keep data, assets, secrets, PID state, backups, and exports outside source.
  Never copy secrets into diagnostics, logs, exports, or agent prompts.
- Local onboarding creates real authorization records and stays loopback-only.

## Extension rules

- Keep object relationship metadata close to `@smrt()`.
- Add human-facing routes explicitly; generated REST routes do not create nav
  pages.
- The root layout includes `@happyvertical/smrt-web` and registers generated
  WebMCP read tools through Provider when the browser exposes `modelContext`.
  Keep the guard in place for SSR and seed live collections with SSR
  `initialData`.
- Do not enable knowledge HTTP routes in production without explicit admin auth.
- Run task and schedule workers as separate deployed processes. Extend the
  portability adapter instead of converting database files. Deployed provider
  readiness must come from installed modules that probe the real backing
  services; environment booleans are not readiness evidence.
- Every supported local web entry point (`app:start` or `pnpm dev`) holds the
  same writer lease. Direct production startup requires an explicit loopback
  `HOST`; prefer `app:start`. Stop the app before backup/import; never bypass
  or delete a live lease. Deployed imports require stopped web/workers plus
  explicit `SMRT_MAINTENANCE_MODE=true`.
- Logical export reads every model table in one transaction and explicitly
  reports that uploaded assets are excluded. Keep imports transactional and
  preserve their relationship-aware ordering/deferred-cycle contract.
