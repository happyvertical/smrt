# Live cookbook exposure over ahead-of-time generation

Generate REST routes, web collection definitions and tool definitions for a
**declared installed superset**, using the existing explicit `smrt({ expose })`
preset option. Declaration-level `api`/`mcp`/`cli` restrictions still apply; this
runtime gate can only narrow them. Eager hosts migrate that superset before
serving; SQLite hosts can opt into the activation contract below. Installing a
package alone grants no cookbook access when the gate is on.
No gate installed preserves existing apps.

## Host integration

```ts
import {
  createCookbookRuntimeExposure,
  filterRuntimeCookbookSnapshot,
  filterRuntimeExposure,
  isRuntimeModelEnabled,
  notifyRuntimeExposureChanged,
  setRuntimeExposureGate,
  subscribeRuntimeExposure,
} from '@happyvertical/smrt-core/runtime-exposure';

const gate = createCookbookRuntimeExposure({
  catalog, // the SAME EngineCatalog as createCookbookEngine
  engineFor: ({ tenantId }) => store.isReadable(tenantId)
    ? store.engine(tenantId) : null,
  predicate: (_model, { tenantId }) => preferences.componentsEnabled(tenantId),
});
setRuntimeExposureGate(gate); // once, before accepting any request
```

`engineFor` is synchronous and called on **every check**, with a trusted tenant
from the host. It must return null or throw if the enabled set cannot be read;
never return a stale engine during a store failure. Engine snapshots are kept
current through the existing `subscribe` API. The adapter indexes membership
once per engine change: request work is a tenant lookup, Set membership and the
host predicate. The predicate is also synchronous, must return exactly true,
and is evaluated on each check. Missing tenant, missing/unknown qualified model,
missing engine, disposed gate and exceptions deny. `allowWithoutTenant: true`
is an explicit option for a single-user host that has no tenant concept.

A gate's engine subscriptions last until `gate.dispose()`; dispose replaced or
retired gate instances to release their engines. `setRuntimeExposureGate(undefined)`
removes the process opt-in. Gate slots are shared across copies through
`globalThis`, matching the registry's process-wide behavior. Do not replace the
global gate per request: its resolver selects the request's tenant.

Use qualified catalog model ids. Recipe models and explicit features are the
union of the currently enabled set; dependencies are expanded by the cookbook
engine's existing commands. Runtime registrations carry
`replacedQualifiedNames`, so enabling the provider model also enables the app's
same-name replacement. A host projecting plain AOT identities can pass
`replacements: modelReplacements(manifest)` (from core's manifest module) to the
factory to canonicalize provider/app ids without importing model constructors.

## Entry points and UI

- Runtime REST: pass the trusted `APIContext.tenantId`, or inspect `request` in a
  custom installed gate. Disabled CRUD/custom-action routes return 404 before
  collection lookup; sync-apply treats disabled targets as unknown objects.
- Generated SvelteKit: gate reads trusted `locals.tenantId` or
  `locals.tenantContext.tenantId`, before auth, JSON parsing, collection access
  or ETag evaluation. The gate gets `locals` for host-specific policy.
- `MCPGenerator`: trusted `MCPContext.tenantId`; `generateTools()` lists the
  live catalog, `handleToolCall()` rechecks it. `generateToolDefinitions()` is
  the AOT superset, exclusively for generation/storage. Names are assigned
  before filtering, so enable/disable cannot rename another tool.
- Generated single-file and modular MCP servers: host-selected
  `SMRT_MCP_TENANT_ID`, never tool arguments. Install the gate in the host's
  registration/bootstrap before `createServer()`. Both lists and calls recheck
  membership; task-enabled calls are checked before task creation. An installed
  gate makes the catalog cache private with zero TTL.
- CLI: trusted `CLIContext.tenantId`; lazy command listings filter the cached
  superset and every generated handler rechecks, including retained handlers.
- Assistant: smrt-chat's existing manifest tool loop filters each turn's
  offerings under the principal tenant and rechecks execution, including the
  injected executor path. Existing persona allow-lists and RBAC still apply.
  Custom host `extraTools`, browser tools and external turn drivers must use
  this gate themselves when they expose model operations.
- Screens/navigation: core does not mount UI. On every page load and every
  exposure change, pass `filterRuntimeExposure(collectionDefinitions,
  def => def.objectRef, { surface: 'screen', tenantId })` to the screen host,
  and `filterRuntimeCookbookSnapshot(engine.snapshot(), catalog, { tenantId })`
  to navigation. Direct screen URLs must call `isRuntimeModelEnabled` before
  rendering, returning 404 on false. Do not render the raw AOT definitions.
  These projections do not mutate the superset or the cookbook.

After a successful cookbook change, engine subscriptions invalidate tool
catalogs. For a preference change or an engine/store replacement, the host
calls `notifyRuntimeExposureChanged()` after publishing the new state (also on
store-read failure). `subscribeRuntimeExposure()` and
`MCPGenerator.onToolsListChanged()` let in-process protocol hosts forward this
as `server.sendToolListChanged()` and dispose the listener on close. Generated
servers do that automatically and advertise `tools.listChanged`. Notifications
contain no tenant information; clients re-list in their own tenant context.
A stateless HTTP adapter with no notification channel must add the transport's
subscription support to deliver notifications; the gate cannot open that channel.

## Opt-in SQLite lazy activation

`@happyvertical/smrt-core/activation` exports `createActivationCoordinator()` and
`activationClosure()`. `@happyvertical/smrt-core/activation/generate` exports
`generateActivationRegistration()` and `buildActivationManifest()` for build tools.
No opt-in means the existing eager registration/migration and gate behavior.

Enable `smrt({ lazyActivation: true, packages, expose: installedSuperset })`
through the public preset. Its `expose` is the explicit installed superset, not
the current cookbook. For the lower-level plugins, set
`smrtConsumer({ lazyActivation: true })` and
`smrtPlugin({ svelteKit: { enabled: true, lazyActivation: true } })`. Coordinated
producer/consumer plugins must agree. Both generated registration entry points
now export `activationManifest` and `activationLoaders`, with no static model
imports or eager calls to `registerAll()`. `.smrt/activation-manifest.json` is
data only: module specifiers and static import dependencies, qualified model
identities, effective same-name replacements, physical table owners (the full
STI family), and logical FK/cross-package-reference plus physical FK closure.
Routes and web/tool definitions remain the AOT superset and retain their gates.
App subclasses stay behind deferred module imports, including their providers.

The generator parses static imports/re-exports with the existing Oxc transformer;
it never evaluates provider code. A provider barrel is a conservative activation
unit: importing any of its declared modules includes its full manifest inventory
and static dependency closure. Splitting a provider into independently activatable
units requires genuinely independent published modules; a per-model callback
cannot undo a barrel's registration side effects. App source modules retain
individual loaders. An app model also activates its declared collection module;
collection receivers bind to the effective replacement identity, with existing
HTTP CLI action metadata retained. Route serializers are deferred until the gated handler calls
them, with their static model dependencies included in the activation graph.
Every required reference must be in the build manifest;
missing references/imports fail generation with their qualified identity. Provider
provenance must resolve to the same package context as the host; differing nested
peer copies are refused rather than registering the wrong constructor. Explicit
`.cjs` model modules are refused. Computed/dynamic model imports must not register
undeclared constructors; newly imported registrations outside the declared closure
fail activation before migration and remain refused on retry until regeneration
and restart. This contract is for a fixed build graph, not
package installation at runtime. Runtime table bindings that disagree with the AOT
physical names are refused; regenerate the graph with the host's bindings.

A host supplies its existing database, persisted cookbook store, tenant gate and
always-on models. Install the readiness gate **before accepting requests**, and
await boot instead of importing eager registration or migrating the full registry:

```ts
import { createActivationCoordinator } from '@happyvertical/smrt-core/activation';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import { activationManifest, activationLoaders } from './smrt-register.js';

const activation = createActivationCoordinator({
  scope: 'my-app:local-database', // stable singleton slot for this database
  packageName: '@my/app',
  db,
  manifest: activationManifest,
  loaders: activationLoaders,
  alwaysOn: hostModelIds, // auth, cookbook persistence and other host needs
  readEnabled: () => store.readEnabledModelUnion(), // ALL tenants, not current user
});
setRuntimeExposureGate(activation.gate(gate)); // gate from Host integration above
await activation.boot();
```

`readEnabled` must return qualified model identities after recipe requirements
have been expanded by the existing cookbook engine. It reads persisted state
on each boot attempt; an unreadable store rejects boot. Pass the generated effective
identity map as the cookbook gate's `replacements` when using AOT definitions:
`new Map(Object.entries(activationManifest.models).map(([id, m]) => [id, m.effective]))`.
Readiness and always-on membership grant no tenant access by themselves; the live
cookbook gate and host predicate still decide access on every request.

Before persisting/publishing a cookbook enable, `await activation.activate(ids)`
for the resulting enabled model set. Then commit and publish the new cookbook
through the host's existing store/engine update, notifying exposure subscribers.
The host must serialize its cookbook updates and publish only persisted state;
do not mutate the live engine first and leave it changed after a failed save.
If persisted state already names an unready model, the readiness gate keeps it
closed until activation/recovery succeeds. The coordinator owns schema/code
readiness, not cookbook persistence, permission grants or tenant state.

Pass the coordinator as `createCookbookToolService({ activation, ... })` in a
lazy host. `recipes.enable` and applying a template reuse `coveredModels` on the
private staged document, await activation after any required approval, recheck
live authority/preference and revision, then commit through the existing CAS
adapter. Migration failure returns `CookbookToolError` with `activation_failed`
and its migration error, leaving the persisted recipe disabled and retryable.
Successfully migrated tables survive a later preference/CAS refusal, but the
tenant gate stays closed. The data-only `CookbookTools` control identity bypasses
model readiness; its live owner, tenant, permission and preference checks remain.

Coordinators live in a `globalThis` process slot. Reusing a scope with the same
manifest/database handle returns the same coordinator; a conflicting configuration
or handle is refused. One process queue covers import, registry validation, diff,
tracker apply, and synchronous readiness publication, including concurrent requests
and tenants. Equal pending closures share one promise. Overlapping closures reuse
loaded modules and ready tables. Failed work never poisons the queue.

`migrateSmrtSchemas({ tables, requireComplete: true })` and
`getPendingSchemaStatements(db, { tables })` extend the existing public migration
orchestrator. `tables` uses the registry's existing physical-table/FK merge;
there is no package-filtered DDL and no collection-init DDL. All owners of a table
are loaded before diffing. Missing/extra physical tables or manual drift refuse
readiness; `requireComplete` refuses manual drift before applying any plan.
Activation uses unique migration names so rapid enables cannot collide with the
eager orchestrator's second-resolution default names. SQLite migration DDL and
tracking use the existing atomic transaction path. A failed batch rolls back and
stays gated; retry re-diffs against the real database without repeating successful
module loads. Imported code stays resident on failure. Node caches a rejected
module evaluation; fixing that module requires a corrected build/process restart,
whereas migration failures can be retried in the same process.

Restart calls `boot()` against the persisted union, imports that closure again in
the fresh process and reconciles existing tables through the differ/tracker.
Committed DDL without cookbook publication is harmless: the gate stays closed,
and retry/restart reuses it. Disabling removes tenant exposure only; it never
unloads constructors, drops tables, or deletes rows. Disabled tables from earlier
runs are retained and are outside later subset plans.

**Backend boundary:** lazy migration supports SQLite only. Coordinator creation
refuses PostgreSQL and DuckDB before imports or DDL, with an instruction to keep
eager registration and normal `migrateSmrtSchemas`. PostgreSQL maintenance-window
and concurrent-index contracts are unchanged; this feature claims no lazy support
for them. Hosts must opt in deliberately; the generic host template is not
silently switched to this database/store-specific bootstrap.

### Measurement

Activation generation loads OXC synchronously only when scanning a source module.
Importing the published core root or building the data-only activation manifest
does not load the native transformer. Compiled hosts can omit this build tool;
the existing synchronous generation API still requires it when called. A plain
Node process test refuses OXC resolution while importing those runtime surfaces.

`node packages/core/scripts/benchmark-activation.mjs --runs=3`, after `pnpm build`,
uses independent cold Node processes, warm filesystem caches, in-process SQLite,
real generated loaders, registry schema merge and migration differ/tracker. The
synthetic fixture has 34 modules, 204 physical tables, twelve business fields per
model, static module imports and cross-package FK dependencies. Boot's enabled
set is three modules; the next enable adds six tables. The measured boundary is
process spawn to **registry + migrations ready**, not first HTTP response. Only
the migration tracker system table is provisioned here; host/system bootstrap,
owner sign-in, UI, AI engines and desktop packaging are excluded.

Local Node 26.8.1/macOS run (three independent samples each):

| Mode | Cold readiness ms | Application tables | RSS MiB | Next enable ms |
| --- | --- | --- | --- | --- |
| Enabled subset | 195, 194, 193 | 18 | 123.36, 124.53, 121.84 | 9.02, 7.67, 9.15 |
| Full set | 273, 279, 271 | 204 | 178.19, 177.53, 177.30 | 0.03, 0.04, 0.03 (already ready) |

Real packages, after rebasing onto `606289dba64890c568528804ed3dac658e795610`:
`node packages/core/scripts/benchmark-activation.mjs --real --runs=3` scans all
34 recipe packages, 46 providers and 930 manifest entries. The subset selects
the seven yoga-studio template recipes and their requirements; both modes always
include `smrt-users:User`. Content's declared host `$lib` serializer is supplied
by forwarding to its existing implementation in the temporary host. No provider
or model is removed from the graph. Filesystem caches are warm; each sample is
a fresh Node 26.8.1 process with an in-memory SQLite database.

| Mode | Cold readiness ms | Total tables | Registered entries | RSS MiB | Enable education.catalog ms |
| --- | --- | --- | --- | --- | --- |
| Yoga-studio | 1434, 1459, 1383 | 221 | 477 | 382.69, 375.20, 380.83 | 1022.74, 959.43, 920.37 |
| All recipes | 3827, 3823, 3695 | 442 | 923 | 466.61, 455.77, 462.39 | 0.22, 0.20, 0.22 (already ready) |

Yoga's next enable really loads a new closure: 311 total tables and 675 registry
entries afterward, adding 90 tables/198 entries. Total table counts include the
migration tracker and domain `_smrt_` tables; excluding `_smrt_`/`sqlite_` names
gives 183/395 at boot. Registry counts include collection receivers. Coarse
provider modules and real reference dependencies explain the large closure; a
recipe is not assumed to equal one table or one independent import.

The initial malformed Expenses `PROFILE` identifier was corrected at all three
owning decorators to `@happyvertical/smrt-profiles:Profile`. A production-source
search across every package found no other identifier-form `crossPackageRef`.
SocialPost's stale `VideoContent` reference now names the registered `VideoShot`
identity (the old name is only a JavaScript export alias). Built-manifest
regressions cover both fixes. Legacy unqualified report ancestry resolves its
unique manifest owner before the shared framework-base filter, preventing an
invented commerce `SmrtReport` resource.

These observations measure registry and migration readiness, not the product's
historical 15.329 s/810.44 MiB/450-table first HTTP response. No packaged desktop,
HTTP, UI, inference or owner bootstrap performance improvement is claimed.

## Test design and evidence

All executable persistence cases below use in-process SQLite; no PostgreSQL,
DuckDB or packaged desktop performance is claimed. Gates themselves are
browser-safe pure predicates and subscriptions. Ordinary model requests do not migrate; explicit activation runs migrations
before readiness is published. The activation cases below exercise SQLite atomicity.

| Behavior/invariant | Reachable trigger and positive case | Negative/failure case | Actor/context and executor | Contract edge / level | Validation |
| --- | --- | --- | --- | --- | --- |
| Live REST | Same built handler: enable -> 200 | Disabled and disabled-again -> 404, before collection access | Owners A/B, two package identities, one SQLite handle | HTTP / integration | core test |
| Tools | Enable -> stable tools; successful call | Disabled list empty and retained name refused | Authenticated tenant MCP contexts, same SQLite | MCP definitions/calls / integration | core test |
| Notifications | Engine change invalidates subscribers; preference explicit invalidation | Unsubscribed listener not called | Process subscriber, no payload or DB | list_changed / unit + generated template checks | core test |
| Tenancy/fail closed | Tenant B can access enabled model | A cannot; missing tenant/identity/engine, unreadable store and throwing predicate deny | Host-owned engine resolver / no DB side effects | All surfaces / unit + integration | core test |
| AOT separation | Definition superset unchanged across enable/disable | Runtime listing cannot use it as authority | Generator / no DB needed | Generation / integration | core test |
| Same-name app | Provider feature enables app REST/MCP identity | Disabled app replacement stays hidden; unrelated identity denied | Existing scanned A2 app/provider, SQLite migrations | Registry, storage provenance / integration | core test |
| Collection tools | Collection resolves effective row identity | Closed/missing row identity denies | Qualified registry resolver | MCP/CLI/assistant / integration | package tests |
| Screens/nav | Projection includes enabled definitions/items | Disabled/predicate-off entries absent; input unchanged | Trusted browser/server tenant, no SQL | Host projection / unit | core test |
| Compatibility | No installed gate retains REST/MCP behavior | Static declaration restrictions still narrow gate | Existing apps / SQLite and existing suites | Public API / regression | core test |
| CLI stale cache | Cached definitions become visible after enable | Retained handler refuses after disable | Host tenant; executor spy before persistence | CLI / unit | CLI test |
| Assistant | Principal turn offers enabled tool | Disabled tool and disable-during-turn never execute | Existing authenticated SQLite principal fixture | AI offering/side-door execution / integration | chat test |

### Lazy activation evidence matrix

| Behavior/invariant | Reachable positive trigger | Failure/negative control | Actor/context; executor | Contract/runtime; level | Validation |
| --- | --- | --- | --- | --- | --- |
| Enabled startup union | Boot two tenants + host always-on | Disabled package has no constructor/table | Host reads persisted union; real SQLite | Activation bootstrap; integration | core test |
| Full physical closure | Enable Invoice -> cross-package Customer -> Profile/STI; app Customer contributes column | Unused model remains absent; unknown edge refuses | Two tenant gates; same SQLite handle | Registry/physical schema/AOT; integration | core test |
| Coalescing/serialization | Equal calls share promise; overlapping closures import/migrate once | Other tenant stays denied | Concurrent callers; one process queue + tracker transaction | SQLite; integration | core test |
| Failure/retry | Inject failure after earlier CREATE TABLE statements; retry succeeds | Entire application batch rolls back, gate stays shut | Transaction-bound SQLite executor; retained modules | Migration/readiness; integration | core test |
| Recovery | Independent Node processes read saved enablement and reuse existing SQLite tables | Disabled constructors stay unimported; retained rows survive | Host persisted union + SQLite file | Plain Node restart; process integration | core test |
| Data-only generation | Parse static module side effect; generated register import evaluates no models | Missing graph edges fail generation | Build-time generator and fresh Node process | Consumer + SvelteKit AOT; integration | core test |
| Compatibility/backend | No subset preserves eager migration; no gate preserves access | PG/DuckDB lazy request rejects before imports/DDL | Non-opt-in host / unsupported adapter | SQLite + backend refusal; regression | core test |

Commands: each touched package's `pnpm turbo run build --filter=<name>...`,
`pnpm test`, `pnpm typecheck`; root `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict`. Existing tests remain unchanged in strength.

## Integration interactions

| Invariant | Positive / failure controls | Executor and level | Validation |
| --- | --- | --- | --- |
| Shared STI identity | Child-first registry, provider root or same-name app root; REST/MCP create the effective base only while enabled, disabling refuses and leaves rows unchanged | In-process SQLite; scanned A2 fixture; REST and MCP integration | core `pnpm test` |
| Lazy STI readiness | Same scanned fixture with automatic test schema preparation disabled; only the STI physical table migrates; REST factory works without collection priming | SQLite, existing migration tracker, child-first discovery; provider and app-root cases | core `pnpm test` |
| Reference pickers | Existing Svelte screen source resolves effective app Customer, searches display label and gets custom fields after Invoice FK activation; preference off refuses retained source | Real screen source + AOT web metadata + REST, in-process SQLite | core `pnpm test` |
| Lazy recipe tools | MCP enable waits for closure then REST 200; migration rollback reports tool error, recipe stays disabled, retry works; CAS failure stays gated | Real coordinator, private cookbook engine and SQLite CAS adapter | core `pnpm test` |
| Durable tools/preference | Reopened owner authority disables after enable; approval binds template state; preference closing during activation refuses commit and completes consumed approval as failed | Existing app-runtime authority + SQLite ledger, same tool service | core `pnpm test` |
| Held manifest tool | Enabled delete is durably held; disable or unreadable cookbook before owner decision refuses without deleting; terminal saved refusal cannot replay | In-process SQLite; mounted chat routes, real principal and approval ledger | chat `pnpm test` |
| Approval projection | Tenant owner and thread lists retain only the immutable public hold summary after disable; no args, recovery context, result or live model metadata | Same mounted routes | chat `pnpm test` |

STI shared collection discovery keeps the effective base selected by the CRUD
resolver; exposure resolves that same qualified base, including provider aliases
replaced by an app. Explicit subtype declarations keep their own identities.
Owner approvals re-enter `invokeManifestTool` with the original tenant and live
exposure. A refused saved effect uses the existing terminal `failed` ledger state
with `result.status: 'refused'` and a refused transcript outcome. Public approval
lists expose only the originally saved summary, never current model details.

### Reuse check

MCP `review-smrt-project` covered core, Expenses and Social; `build-context`
searched architecture for cookbook model projection and activation. The intent
index and `rg` searches by `activate`, `activationCoordinator`, `coveredModels`,
`COOKBOOK_TOOLS_MODEL`, migration subset, model references and module imports
covered core, chat, smrt-ui, smrt-svelte and owning packages. No existing
activation coordinator or data-only activation graph fit this contract.

| New implementation file | Existing capabilities reused |
| --- | --- |
| `src/activation/manifest.ts` | Manifest qualified identities; physical FK/STI ownership semantics |
| `src/activation/generate.ts` | Manifest replacements, web collection/item resolver, framework-base filter, OXC module analysis, normal registration |
| `src/activation.ts` | Registry schema subset/merge, migration differ/tracker transactions, runtime exposure notifications/gate |
| `scripts/benchmark-activation.mjs` | Built recipe manifests, generated loaders, public coordinator and SQLite registry/migrations; existing Content serializer |
| `src/activation/{activation,generate}.test.ts` | Existing `manifestEntry`, `createConsumerWorkspace`, registry snapshot and SQLite fixtures |

Follow-up extends existing tools and tests; `coveredModels` projects staged
cookbook models. REST reuses the registry collection factory. Reference tests
reuse `createRecipeScreenReferences`/`screenReferenceTarget`/`screenRecordLabel`;
approvals reuse app-runtime's SQLite authority. No UI component, model, route,
approval ledger or parallel implementation was introduced.

### A3b validation checkpoint

Rebased onto `606289dba64890c568528804ed3dac658e795610`; the sole conflict was
the generated core knowledge page, retained from integration then regenerated.
`pnpm install` left the lockfile unchanged. Node 26.8.1, macOS; all persistence
tests in process, no containers. Full core: **506 files passed, 66 skipped;
6,884 tests passed, 513 skipped** (Vitest reports 7,401 total, including four
todo tests). Expenses: **10 files/144 tests passed, four files/129 optional tests
skipped**, plus **two UI files/15 tests passed**. Social: **two files/34 tests
passed**. All three full package typechecks pass (core includes test types;
Expenses/Social Svelte checks report zero errors/warnings). Full workspace build:
85 tasks passed; dependency-closure build: 47 tasks passed. Root lint, format,
strict knowledge freshness (zero errors/seven existing ingestion warnings), and
advisory policy pass. The plain-Node root gate passes with its existing Products
allowlist: 51 roots load, the one allowlisted root still fails. Optional PostgreSQL
service cases remain skipped; lazy migration on PostgreSQL/DuckDB is explicitly
refused, not advertised as tested support. No product HTTP/desktop benchmark or
external AI/provider execution is claimed.

Shared core files touched by A3b (paths relative to `packages/core`):
`AGENTS.md`, `package.json`, `agents/runtime-exposure.md`,
`agents/cookbook-tools.md`, `src/migrations/orchestrate.ts`,
`src/migrations/__tests__/orchestrate.test.ts`, `src/consumer-plugin/index.ts`,
`src/vite-plugin/index.ts`, `src/vite-plugin/sveltekit-generator.ts`,
`src/vite-plugin/sveltekit-route-coordinator.ts`, `src/vite-preset/index.ts`,
`src/runtime-exposure.ts`, `src/cookbook/tools.ts`, `src/cookbook/tools.test.ts`,
`src/generators/rest.ts`, `src/__tests__/same-name-app-subclass.test.ts`.
Outside core: Expenses' model/reference regression, Social's model/reference
regression and AGENTS target documentation; regenerated root component pages
for core and Social. The additive activation modules/tests and benchmark script
are listed in Reuse check above. No chat, UI or Svelte production files changed.

Deferred registration is valid plain JavaScript and strict TypeScript. Manifest
export names use dynamic Reflect lookups, preserving optional collection exports
and valid models with specialized constructor options. The existing callable
export check and registry remain the runtime boundary; no consumer typecheck
exclusion or generated-file patch is needed. The activation generator's strict
consumer fixture includes an empty same-name replacement with no collection
export, plus a provider with specialized options; process tests still boot and
recover the emitted JavaScript.

Deferred local app imports use emitted `.js` specifiers even when their source is
`.ts`; the existing source resolver maps them back for graph construction. This
keeps generated registration valid under ordinary strict NodeNext consumers,
without `allowImportingTsExtensions`. The strict consumer regression runs both
JavaScript and TypeScript same-name app replacements with optional collection
exports and specialized provider constructors. Built template hosts exercise the
same emitted imports through Vite and plain-Node server boot.

Host snapshot preparation reuses consumer-plugin's public `findInstalledPackageJson`
to bind dependency source provenance to the actual installed owning package. A
publisher checkout outside that package is not a host source, even when it happens
to exist on the build machine. Workspace-linked providers retain source digests.

PostgreSQL/PGlite refusal, migration lock prerequisites and validation: [PostgreSQL parity](postgres-parity.md).
