# Live cookbook exposure over ahead-of-time generation

Generate REST routes, web collection definitions and tool definitions for a
**declared installed superset**, using the existing explicit `smrt({ expose })`
preset option. Declaration-level `api`/`mcp`/`cli` restrictions still apply; this
runtime gate can only narrow them. Run normal migrations for that superset before
serving. Installing a package alone grants no cookbook access when the gate is on.
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

## Startup limitation and required lazy-activation design

This change does **not** defer imports, registrations or application migrations.
The public fixture benchmark is `node packages/core/scripts/benchmark-runtime-exposure.mjs`:
independent cold processes, two package identities, SQLite in memory, real
`migrateSmrtSchemas`, first REST response, table count and RSS. It compares the
same installed/migrated superset without/with gating. No package pruning or lazy
migration is claimed, and these fixture numbers do not predict the 34-package
product measurement.

One local run (Node 26.8.1, macOS, cold processes with warm filesystem caches):
baseline -> gated first response **178 -> 196 ms**, RSS **117.30 -> 118.44 MiB**,
**16 -> 16 tables** (two application tables in each). The disabled Estimates
response changed **200 -> 404**. This measures gating overhead and confirms the
startup/table cost is still eager; one run is not a performance distribution.


Why a per-package import callback would be incorrect:

1. `consumer-plugin/index.ts` writes static provider imports into `.smrt/register.js`;
   `vite-plugin/sveltekit-generator.ts` also statically imports app subclasses.
   Importing a subclass necessarily imports its provider. Removing registration
   afterward cannot undo import side effects, memory, or decorator registration.
2. The registry is process-wide while enablement is per tenant. A package enabled
   for one tenant stays imported and registered for all; request gates still
   must deny other tenants, and disabling cannot safely unload constructors.
3. Schema ownership is by physical table, not by package. STI siblings and
   same-name app replacements share tables and columns. Foreign keys need a
   dependency closure, including models outside the recipe's own package.
4. `migrateSmrtSchemas()` plans the registered schema set and has no public
   package/physical-table activation subset. Runtime collection initialization
   only verifies tables and must not become a migration side effect.

The needed design is an AOT data-only activation manifest: package/module lazy
loaders, effective replacement identities, full STI/table owners, and required
FK/module dependencies. A process coordinator must serialize first activation,
load that dependency closure, plan the **physical-table** schema subset with the
existing migration differ/tracker and transaction guarantees, then publish
readiness and the enabled cookbook atomically from the caller's perspective.
Failures must leave the model gated, retries reconcile committed DDL, and
concurrent tenant activations coalesce. Persistence/restart recovery and
PostgreSQL maintenance-window changes need explicit contracts. The startup floor
still includes the host, core, cookbook store and enabled dependency closure;
AOT route/definition metadata is unavoidable, but disabled constructors need not
be. This is a wider consumer-generation/migration contract change, not a safe
incidental package-local optimization. No lazy DDL was improvised here.

## Test design and evidence

All executable persistence cases below use in-process SQLite; no PostgreSQL,
DuckDB or packaged desktop performance is claimed. Gates themselves are
browser-safe pure predicates and subscriptions. No schema writes are added to a
request, so rollback/DDL atomicity is unchanged and lazy-migration cases remain
explicitly unimplemented.

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

Commands: each touched package's `pnpm turbo run build --filter=<name>...`,
`pnpm test`, `pnpm typecheck`; root `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict`. Existing tests remain unchanged in strength.

## Integration interactions

| Invariant | Positive / failure controls | Executor and level | Validation |
| --- | --- | --- | --- |
| Shared STI identity | Child-first registry, provider root or same-name app root; REST/MCP create the effective base only while enabled, disabling refuses and leaves rows unchanged | In-process SQLite; scanned A2 fixture; REST and MCP integration | core `pnpm test` |
| Held manifest tool | Enabled delete is durably held; disable or unreadable cookbook before owner decision refuses without deleting; terminal saved refusal cannot replay | In-process SQLite; mounted chat routes, real principal and approval ledger | chat `pnpm test` |
| Approval projection | Tenant owner and thread lists retain only the immutable public hold summary after disable; no args, recovery context, result or live model metadata | Same mounted routes | chat `pnpm test` |

STI shared collection discovery keeps the effective base selected by the CRUD
resolver; exposure resolves that same qualified base, including provider aliases
replaced by an app. Explicit subtype declarations keep their own identities.
Owner approvals re-enter `invokeManifestTool` with the original tenant and live
exposure. A refused saved effect uses the existing terminal `failed` ledger state
with `result.status: 'refused'` and a refused transcript outcome. Public approval
lists expose only the originally saved summary, never current model details.
