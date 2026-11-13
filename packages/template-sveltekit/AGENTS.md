# template-sveltekit

`smrt gnode create --template=sveltekit` scaffold; an alternative to `smrt-start`.

## Exports

- [Cookbook host](agents/cookbook-host.md).

- `getTemplatePath()` returns the template directory.
- `copyTemplate(destination, options)` copies authored files, substitutes the
  package name, and skips `.svelte-kit` and test-fixture directories.
- `templateInfo` describes the template's SvelteKit, SQLite, session, tenancy
  and permission foundation.

## Current generated-project contract

- `template/compose.yaml` carries the `x-happyvertical` deployment declaration
  (contract v1, `@happyvertical/smrt-config/deployment`). It is the source of
  `charts/smrt-app/fixtures/starter.json`: after changing its services or
  annotations run `node scripts/compose-contract-fixture.mjs --write` and
  commit the fixture; `compose-contract.test.mjs` fails on drift.

- Node `>=26.0.0`; pnpm `11.25.0` via `packageManager` and `engines`. Node 25+
  images ship no Corepack; the Dockerfile installs a pinned copy.
- `runtime.profile` is the canonical infrastructure selector. Generated apps
  expose deterministic `app:*` operations and keep runtime state out of source.
- Every lifecycle script is a `smrt app <operation>` one-liner
  (`packages/cli/agents/app-commands.md`); the template ships no `scripts/`.
  Never reintroduce copied operator scripts; fix the CLI command.
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
  Health, diagnostics, layout session and owner setup routes mount its handlers.
- The production baseline uses adapter-node with separate web, task-worker and
  schedule-worker processes. Workers import the build-compiled
  `.smrt/runtime/register.js` (#3117) before creating runners so app-defined
  jobs resolve the app's own objects. The runtime image retains the generated
  manifest and operator CLI that `app:doctor`, `app:export` and `app:import` need.
- Deployed authentication, asset and secret readiness is delegated to installed
  provider-owned probe modules; never replace it with truthy flags.
- Every supported local web writer (`app:start` or `pnpm dev`) acquires the
  same external writer lease. Logical imports and filesystem backups fail
  closed while any writer is alive; logical exports take one database
  transaction snapshot and include filesystem assets referenced by exported
  asset rows in a digest-verified, provider-neutral manifest. Imports stage and
  verify those assets before committing rows. Direct production startup must
  set an explicit loopback `HOST`.
- Local `app:start` proves readiness against the loopback-only identity fields
  on the runtime health route using the canonical application ID, random
  process instance, and secret-safe runtime configuration identity; a
  different or stale server is never accepted as this app. Deployed health
  responses expose only generic status and profile.
- Directly used `@happyvertical/smrt-*` packages share one current release range.
- `@happyvertical/smrt-cli` is a direct dev dependency because every lifecycle
  script runs its binary; the runtime image keeps dev dependencies for workers
  and operator commands. `@happyvertical/smrt-web` is included because the root
  Provider wires the generated read-only WebMCP definitions for every page.
- The generated MCP server resolves its imports from the scaffolded app, not
  the CLI, so every specifier `generate-mcp` emits must be declared here:
  `@modelcontextprotocol/server` (and `/stdio`), `@happyvertical/smrt-core` and
  `@happyvertical/smrt-config` always, plus `@happyvertical/smrt-jobs` and
  `@happyvertical/smrt-tenancy` for the default worker and tenant surfaces.
  pnpm's strict layout does not expose the CLI's or core's transitive
  dependencies to the app root (#2297).
- `vite.config.ts` is `[sveltekit(), smrt()]`. The preset consumes exactly the
  packages in `smrt.config.ts` `consumer.packages` (profiles, tenancy, users, reports),
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
- Commerce is optional and never a template dependency.
  `src/lib/server/commerce.ts` (`bootstrapCommerceTenant`) calls
  `ensureCommerceTenant()` only when the app has installed
  `@happyvertical/smrt-commerce` (resolved from its own `node_modules`, with a
  variable import specifier), passing `smrt.cookbook.json` when present. `/setup`
  runs it from `onOwnerClaimed`, after the claim created the tenant, and logs a
  failure because the runtime ignores hook errors. Any other
  tenant-creation path an app adds should call it too (#4009).
- App code uses `runtime.getCollection()`/`runtime.classOptions()`, which are
  request-scoped (RLS transaction) and must never be retained.
- A new app registers no object and opens on an empty home page (no Note, no
  `notes.*` permissions, no migration). The Note example lives outside the
  generated app in `examples/notes/` (an `src/`-shaped tree: the object and a
  `/notes` page) and is not built or registered by default; it demonstrates
  required tenant scope, a REST writable allowlist, shared CRUD action
  metadata, and the explicit collection registration generated CLI/MCP runtime
  commands need. Never move it back under `template/`; tests get it from the
  reference fixture (`copyRuntimeProfileReference()`).
- The example page loads data in `+page.server.ts`; loads declare
  `depends('smrt:notes')`, mutations call `invalidate('smrt:notes')`, and
  hand-written writes call `assertOperationPermission()` with the session's
  exact permission snapshot.
- The root layout is `AppShell` from `@happyvertical/smrt-svelte/app` with a
  small explicit `nav`; `/setup` and `/settings` mount that package's
  `OwnerSetupForm` and `ShellSettingsPage`. Generated REST routes do not imply
  page routes. Settings is a section menu: `/settings` lists the sections and
  each is its own page (`/settings/[section=settingsSection]` for the built-in
  Appearance, Account, Layout and Shortcuts, via the `isShellSettingsSection`
  param matcher; host sections get a static route beside it).
- Inference and Prompts are host sections (`/settings/inference`,
  `/settings/prompts`) mounting `InferenceSettingsPanel` and
  `PromptSettingsPanel`. `consumer.packages` lists their packages (smrt-inference,
  -prompts, -preferences, -secrets) so their tables exist on first start.
  `settings-registry.ts` (imported by `smrt.ts` first) registers the
  `inference` preference kind and the `inference.*` / `prompts.customize`
  permissions the owner role is seeded with. `settings.ts` holds the session
  (writes need the permission in its snapshot) and builds smrt-inference's
  `createInferenceSettingsHost` and `createInferenceSettingsController` (shared
  with the app shell; the route is thin); `installInferenceOverrides` registers
  the resolver. Owner-only `saveKey` stores keys via the controller;
  `masterKeyProvider` is `runtime.secretMasterKey()` (local: created; env wins).
- Session user and sign-out: `+layout.server.ts` (`createSessionLayoutLoad()`)
  returns `session.user` (`{ id, email, name? }` only, never the record or
  tokens). The root layout passes it as AppShell `user` with `onSignOut` from
  `src/lib/sign-out.ts` (same-origin `POST /sign-out`, then `invalidateAll()`
  and `goto('/')`); the settings page passes the same helper.
  `src/routes/sign-out/+server.ts` mounts `createSignOutHandler(runtime)` (POST
  only; same-origin only; 204, or 303 to `/` for an HTML form post). The layout
  enables `phoneTabBar` and sets `chrome={!page.route.id?.startsWith('/setup')}`
  so `/setup` renders only the chrome-free `OwnerSetupForm` card.
- The example Notes page is built from smrt-ui primitives only (`Button`, `Card`,
  `Form`, `FormGroup`, `Input`, `Textarea`, `EmptyState`): no raw `<form>`,
  `<input>`, or `<button>`, token spacing, and a "Start your first note" empty
  state. The root layout passes only live AppShell props (no `subtitle`,
  `tenantLabel`, or `appPanelDocs`) and gives each nav item a shell icon name.
  `app.html` carries `viewport-fit=cover`, `color-scheme`, light and dark
  `theme-color`, and `static/favicon.svg`.
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

`e2e/` holds the milestone-M5 acceptance gate (#2579), run against a fresh copy
of the generated app with its own database, handlers and registrations. Rules
for the harness, `pnpm test:e2e`, `pnpm test:m5` and its artifacts:
[agents/m5-browser-gate.md](agents/m5-browser-gate.md).
