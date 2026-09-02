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
- `runtime.profile` is the canonical infrastructure selector. Generated apps
  expose deterministic `app:*` operations and keep runtime state outside source.
- The production baseline uses adapter-node with separate web, task-worker, and
  schedule-worker processes. Its runtime image retains the generated manifest
  and operator CLI needed by `app:doctor`, `app:export`, and `app:import`.
- Deployed authentication, asset, and secret readiness is delegated to
  installed provider-owned probe modules; never replace it with truthy flags.
- Every supported local web writer (`app:start` or `pnpm dev`)
  acquires the same external writer lease. Logical imports and filesystem
  backups fail closed while any writer is alive; logical exports take one
  database transaction snapshot and include filesystem assets referenced by
  exported asset rows in a digest-verified, provider-neutral manifest. Imports
  stage and verify those assets before committing database rows.
  Direct production startup must set an explicit loopback `HOST`.
- Local `app:start` proves readiness against the loopback-only identity fields
  on the runtime health route using the canonical application ID, random
  process instance, and secret-safe runtime configuration identity; a
  different or stale server is never accepted as this app. Deployed health
  responses expose only generic status and profile.
- Directly used `@happyvertical/smrt-*` packages share one current release range.
- `@happyvertical/smrt-cli` is a direct dev dependency because scripts/docs use
  its binary. The template includes `@happyvertical/smrt-web` because the root
  Provider wires the generated read-only WebMCP definitions for every page.
- The generated MCP server resolves its imports from the scaffolded app, not
  from the CLI, so every specifier `generate-mcp` emits must be declared here.
  `@modelcontextprotocol/server` (plus its `/stdio` subpath),
  `@happyvertical/smrt-core`, and `@happyvertical/smrt-config` are always
  emitted and are always dependencies. `@happyvertical/smrt-jobs` (task actions)
  and `@happyvertical/smrt-tenancy` (tenant-scoped objects) are also declared
  for the default worker and tenant surfaces. Do not assume pnpm exposes the
  CLI's or core's transitive dependencies to the app root — its strict layout
  does not (#2297).
- `smrtConsumer()` explicitly consumes profiles, tenancy, and users manifests;
  `smrtPlugin()` scans `src/lib/objects`, generates Vite virtual definitions,
  SvelteKit routes, runtime registration, and knowledge artifacts.
- `pnpm db:migrate` builds first to refresh generated artifacts, then the
  migration wrapper holds the shared operation/writer exclusion for the full
  manifest-driven migration command. Do not restore deprecated `smrt db:setup`
  documentation or split the safety check from the migration process.

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
- The root Provider registers generated WebMCP read tools with the authenticated
  page session. Write/destructive effects require an explicit page-owned policy.
  Live browser collections remain opt-in per page and must seed from SSR
  `initialData` to avoid a duplicate first request.
- `RuntimeDiagnosticsWebMcp` owns exactly one additional read-only tool,
  `smrt.runtime.diagnostics.read`. It uses same-origin page-session fetch to the
  authored `/api/_runtime/diagnostics` route and aborts its registration on
  unmount. The route requires a direct active tenant membership plus either the
  owner role or the explicit `runtime_diagnostics.read` permission before any
  runtime projection/probe; it never calls principal-bound server tools.

## Tests

Tests live in package-level `__tests__/`, never under `template/`. Vitest's
global setup creates a temporary `.svelte-kit/tsconfig.json` stub and removes it
afterward; `copyTemplate()` filters the directory as defense in depth.
