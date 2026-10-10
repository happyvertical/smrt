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

- Node `>=26.0.0`; pnpm `11.25.0` via `packageManager` and `engines`. Node 25+
  images ship no Corepack, so the Dockerfile installs a pinned copy.
- `runtime.profile` is the canonical infrastructure selector. Generated apps
  expose deterministic `app:*` operations and keep runtime state outside source.
- Every lifecycle script is a `smrt app <operation>` one-liner
  (`packages/cli/agents/app-commands.md`); the template ships no `scripts/`.
  Never reintroduce copied operator scripts: fix the CLI command instead.
- Server composition is `createSmrtSvelteKitRuntime()` from
  `@happyvertical/smrt-app-runtime/sveltekit`, built once in
  `src/lib/server/smrt.ts`, which holds only `runtime` and its options
  (provider readiness via `createProviderReadinessProbe`), so the web process
  never imports the CLI. The runtime takes the local writer lease by default,
  the `smrt()` plugin injects the generated registration, and each generated
  route embeds a prelude that imports `$lib/server/smrt` and resolves
  collections through its exported `runtime.getCollection()` (#3416). A legacy
  `getCollection`/`getSmrtConfig` export would take precedence (deprecated,
  honoured for one release): never re-add one, a register import, guard, or
  manifest hydration.
  Health, diagnostics, layout session, and owner setup routes mount that
  package's handlers.
- The production baseline uses adapter-node with separate web, task-worker, and
  schedule-worker processes. Workers import the build-compiled
  `.smrt/runtime/register.js` (#3117) before creating runners so app-defined
  jobs resolve the app's own objects. Its runtime image retains the generated manifest
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
- `@happyvertical/smrt-cli` is a direct dev dependency because every
  lifecycle script runs its binary; the runtime image keeps dev dependencies so
  workers and operator commands can. The template includes `@happyvertical/smrt-web` because the root
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
- `vite.config.ts` is `[sveltekit(), smrt()]`. The preset consumes exactly the
  packages in `smrt.config.ts` `consumer.packages` (profiles, tenancy, users),
  scans `src/lib/objects`, and generates Vite virtual definitions, SvelteKit
  routes, runtime registration, and knowledge artifacts. With a
  `smrt.cookbook.json` it also hosts the cookbook's package models over REST
  (core `build-knowledge.md`, "Package models over REST", #3749).
- `pnpm db:migrate` builds first to refresh generated artifacts, then the
  migration wrapper holds the shared operation/writer exclusion for the full
  manifest-driven migration command. Do not restore deprecated `smrt db:setup`
  documentation or split the safety check from the migration process.

## Application patterns

- `src/hooks.server.ts` re-exports the runtime's `handle`/`init`: URL tenant
  selection stays a separate candidate and only the verified session
  establishes tenant context. Never turn an untrusted header into authority.
- App code uses `runtime.getCollection()`/`runtime.classOptions()`, which are
  request-scoped (RLS transaction) and must never be retained.
- `Item` is the single example object and demonstrates optional tenant scope,
  a REST writable allowlist, shared CRUD action metadata, and the explicit
  collection registration required by generated CLI/MCP runtime commands.
- Initial data comes from `+page.server.ts`; loads declare
  `depends('smrt:items')`, mutations call `invalidate('smrt:items')`, and
  hand-written writes call `assertOperationPermission()` with the session's
  exact permission snapshot.
- The root layout is `AppShell` from `@happyvertical/smrt-svelte/app` with a
  small explicit `nav`; `/setup` and `/settings` mount that package's
  `OwnerSetupForm` and `ShellSettingsPage`. Generated REST routes do not imply
  page routes.
- AppShell's Provider registers generated WebMCP read tools with the
  authenticated page session. Write/destructive effects require an explicit
  page-owned policy.
  Live browser collections remain opt-in per page and must seed from SSR
  `initialData` to avoid a duplicate first request.
- AppShell's `runtimeDiagnostics` (on for signed-in sessions) owns exactly one
  additional read-only tool, `smrt.runtime.diagnostics.read`, which fetches the
  mounted `/api/_runtime/diagnostics` route as the page user. That route
  (`createRuntimeDiagnosticsHandler`) requires a direct active tenant membership
  plus the owner role or `runtime_diagnostics.read` before any projection or
  probe; it never calls principal-bound server tools.
- The opt-in `mcp-apps-template/` overlay is one
  `mountMcpAppRoute({ runtime })` route and
  `mountMcpProtectedResourceMetadataRoute({ runtime })` (#3491): the
  runtime supplies the request database, `runAsPrincipal` and, per request,
  the profile's bearer adapter (local owner tokens, hosted membership-backed
  principals). No `mcp.ts` helper or top-level `await`; `pnpm typecheck`
  checks it against the template. `__tests__/localMcpToken.test.ts` proves mint → real
  `smrt-mcp-bridge` stdio → route against the real runtime.
  `__tests__/mcpConsumerBundle.test.ts` (why `@happyvertical/smrt-chat` is a
  devDependency) Vite-SSR-builds `fixtures/mcp-chat-consumer/` with chat and
  smrt-agents inlined, runs it in plain Node, and requires one registry entry
  per inlined class and exactly the allow-listed tools on the route (#3490).

## Tests

Tests live in package-level `__tests__/`, never under `template/`. Vitest's
global setup creates a temporary `.svelte-kit/tsconfig.json` stub and removes it
afterward; `copyTemplate()` filters the directory as defense in depth.

`__tests__/support/` holds reusable, test-only helpers shared by the M5
runtime-profile proofs:

- `runtimeSurfaceParity.ts` canonicalizes the generated REST routes, OpenAPI
  operations, CLI commands, MCP tool schemas, WebMCP descriptors, and per-tool
  policy (effect, destructive/external annotations, approval, exposure, tenant
  scope) that one copied application emits under a given runtime profile.
  `canonicalizeRuntimeProfileSurfaces()` produces the bytes compared across
  profiles; `OPERATIONAL_DIAGNOSTIC_TOOL_NAME` names the single allowlisted
  operational exception (the #2577 diagnostic tool), which is authored rather
  than generated and is therefore excluded from the domain inventories.
- `runtimeFailureInjection.ts` holds narrowly scoped configuration/migration
  failure injection. It adds no production seam: it only supplies ordinary
  caller arguments (a runtime config object, the documented `prepareDatabase`
  callback).

`runtimeProfileParity.test.ts` asserts that the three profiles emit one
byte-identical domain surface; its committed snapshot is an API/policy contract
and must be reviewed as a diff, never regenerated blindly. The PostgreSQL
external-worker half lives in `runtimeProfileParity.postgres.optional.test.ts`
and runs through `pnpm test:postgres`, which forces sequential file execution
because the optional PostgreSQL suites share one disposable database.

## M5 browser gate

`e2e/` holds the milestone-M5 acceptance gate (#2579): a Playwright pass that
provisions a fresh copy of the generated app into a temporary root, runs its
own `app:setup` build/migrate/bootstrap, serves it on an ephemeral loopback
port, and drives WebMCP discovery, execution, authorization, consent, disposal,
and redaction in a real browser. The only fabricated thing is
`document.modelContext`, which no headless browser exposes; database,
collections, handlers, session, and every registration are the application's
own. Never add a mocked REST handler, an in-memory database, or DOM automation
presented as WebMCP execution.

- `@happyvertical/smrt-cli` is a devDependency **because the gate needs it**:
  the harness runs the app's own `smrt app setup` and `smrt app dev` from the
  linked CLI, and setup's `pnpm build` is `smrt app build`. The copied app
  deliberately never runs `pnpm install`, so `smrt` has to arrive through the
  linked `node_modules`. The harness pins the app's own `.bin` ahead of `PATH`
  and fails with a named error if the binary is missing, so a host-global
  `smrt` cannot make a local run pass where CI fails. Identity and state-root
  values it checks come from `@happyvertical/smrt-app-runtime`.
- `pnpm test:e2e` runs the browser half.
- `pnpm test:m5` runs the whole aggregate gate through
  `e2e/support/gate.mjs`, which requires a PostgreSQL service and fails when a
  required profile case is missing rather than merely absent from the log.
- Tracing, video, and screenshots stay off: onboarding carries a single-use
  bootstrap token in a URL.
- `m5-gate-summary.json` is the one file the gate writes inside the package;
  it is gitignored, overwritten every run, and is what CI uploads. Everything
  else it generates stays in a test-owned temporary root. Playwright's
  `outputDir` is `$TMPDIR/smrt-m5-artifacts`, emptied by
  `e2e/support/globalTeardown.ts`; `e2e/redaction.spec.ts` reads that path back
  from `testInfo.project.outputDir` and asserts it is outside the repository.
  The harness gives the copied app a real `node_modules` directory of
  individually symlinked entries rather than one symlink to this package's, so
  the served app's `node_modules/.vite` cache cannot land in the checkout.
  Scope directories (`@happyvertical/`) and `.bin/` are real directories of
  per-entry links too: the copy ships `pnpm-workspace.yaml` and setup runs
  `pnpm build` in it, so anything pnpm relinks must land in the copy, never in
  this package's `node_modules`. Never replace either loop with a
  whole-directory symlink.
- `e2e/` is outside `biome.json`'s include globs, as every package's `e2e/` is,
  so a green `Lint` job says nothing about this tree. `pnpm typecheck` covers
  the `.ts` files (`tsconfig.fixture.json` includes `e2e/**/*.ts`) but NOT
  `e2e/support/gate.mjs`, which no static analysis reaches. Its `emit()`
  vocabulary guard is the runtime backstop; edit it carefully and run
  `pnpm test:m5` after any change to it.

See [the M5 reference fixture gate](../../docs/content/m5-reference-fixture.md)
for what the milestone proves, what it does not, and the recovery commands.
