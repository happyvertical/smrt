# template-sveltekit

Minimal SvelteKit project template used by `smrt gnode create --template=sveltekit`.
It is the ground-up alternative to `smrt-saas-starter`.

## Exports

- `getTemplatePath()` returns the template directory.
- `copyTemplate(destination, options)` copies authored files, substitutes the
  project package name, and skips `.svelte-kit` plus test-fixture directories.
- `templateInfo` describes the SvelteKit, SQLite, generated-interface, session,
  tenancy, and permission foundation.

## Current generated-project contract

- Node `>=24.18.0`; pnpm `10.34.4` via `packageManager` and `engines`.
- Directly used `@happyvertical/smrt-*` packages are pinned to `0.38.25`.
- `@happyvertical/smrt-cli` is a direct dev dependency because scripts/docs use
  its binary. `@happyvertical/smrt-web` stays opt-in until a page imports it.
- `smrtConsumer()` explicitly consumes profiles, tenancy, and users manifests;
  `smrtPlugin()` scans `src/lib/objects`, generates Vite virtual definitions,
  SvelteKit routes, runtime registration, and knowledge artifacts.
- `pnpm db:migrate` builds first to refresh generated artifacts, then runs the
  current manifest-driven migration command. Do not restore deprecated
  `smrt db:setup` documentation.

## Application patterns

- `src/hooks.server.ts` stores a URL-selected tenant candidate separately, then
  lets `createSessionHandler({ enterTenantContext: true })` establish the only
  authorized tenant context. Never turn an untrusted header into authority.
- `src/lib/server/smrt.ts` imports generated local registrations, loads the
  generated manifest metadata, and uses the public users request-scoped DB API.
- `Item` is the single example object and demonstrates optional tenant scope,
  a REST writable allowlist, shared CRUD action metadata, and the explicit
  collection registration required by generated CLI/MCP runtime commands.
- Initial data comes from `+page.server.ts`; loads declare
  `depends('smrt:items')`, mutations call `invalidate('smrt:items')`, and
  hand-written writes call `assertOperationPermission()` with the session's
  exact permission snapshot.
- The root layout uses Provider, the current smrt-ui ThemeProvider, AdminShell,
  and a small explicit TenantNav. Generated REST routes do not imply page routes.
- WebMCP and live browser data examples are opt-in per page and must seed live
  collections from SSR `initialData` to avoid a duplicate first request.

## Tests

Tests live in package-level `__tests__/`, never under `template/`. Vitest's
global setup creates a temporary `.svelte-kit/tsconfig.json` stub and removes it
afterward; `copyTemplate()` filters the directory as defense in depth.
