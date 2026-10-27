# @happyvertical/smrt-reports

Materialized aggregate report models and runtime report browser surfaces for SMRT.

## Browser surfaces (#3895)

`./svelte` publishes `SavedReports`, `ReportDetail`, `ReportResult`,
`ReportConfirmation`, and `ReportPicker`; visual chart renderers come from
`@happyvertical/smrt-ui/charts`. Keep runtime imports out of this subpath:
server report types are type-only imports. See [browser contract](agents/runtime-report-browser.md).
`pnpm typecheck` includes Svelte diagnostics and `pnpm test` includes browser
component tests. `./playground` supplies each screen's preview.

## Key Pieces

| Module | Purpose |
| --- | --- |
| `SmrtReport` | Abstract report row base with `refreshedAt`, `isStale()`, and manual `refresh()` |
| decorators | `@report`, grouping decorators, time buckets, and aggregate measure decorators |
| compiler | Pure `ReportDefinition -> AggregateSpec` compiler and ObjectRegistry adapter |
| aggregate | Compatibility re-export of the SDK aggregate query builder |
| refresh | Rebuild and incremental refresh engine with run tracking, watermarks, locks, and tenant scoping |
| state | Internal `_smrt_report_*` system models for runs, watermarks, locks, schedules, and refresh tasks |
| scheduler | Cron schedule runner, durable refresh job enqueueing, and `onChange` interceptor registration |
| adapter | Transport-neutral report descriptor, canonical materialized-row reads, and stable `id` row identity |
| lifecycle | Tenant-safe freshness, run, lock, failure, and manual refresh preview/apply surfaces |
| views | Policy-revalidated saved views, snapshot-bound exports, bounded job handoff, and artifact metadata validation |
| runtime reports | Declarative `RuntimeReportSpec` stored as data (`RuntimeReport`), compiled per principal with field-policy, RBAC and tenant checks; see [agents/runtime-reports.md](agents/runtime-reports.md) |

## Adapter contract

- `buildReportAdapterDescriptor()` returns deterministic, serializable metadata
  for a report surface: a stable resource id, typed persisted report columns,
  the canonical `DataQuerySchema`, and UI-neutral DataTable hints. It must not
  import `smrt-ui` or expose a report-domain class to the consumer.
- `queryReportMaterializedRows()` owns only the bounded read slice for rows that
  are already materialized. It supports projection, offset/limit paging,
  validated filters, deterministic multi-sort with an `id` tie-breaker, exact
  totals, and dimension facets. At source-query compilation,
  dimension and bucket filters compile to `WHERE`, aggregate-measure filters
  compile to `HAVING`, and mixed `OR`/`NOT` filter scopes fail closed.
- `id` is the only row identity. It must be a non-empty persisted string and is
  never replaced by a display index or page position.
- The descriptor is an exposure boundary. Sensitive/secret fields, fields with
  `readPermission`, and transient, system, or non-column fields fail closed and
  do not become public columns when no principal is available.
- `tenantScoped`/`tenantField` reflect actual registered tenant metadata. A
  `tenantScope` option only contributes to the stable resource id; it is not
  authorization. Pass the same `adapter` options to
  `queryReportMaterializedRows()` that were used to build the selected
  descriptor, so results and background tasks retain that stable resource id.
  The default query path resolves the registered collection via `ObjectRegistry`,
  so normal collection tenancy interceptors apply. An injected collection is
  application-owned and must preserve the same boundary.
- `refresh` is a declaration, not execution. It describes configured mode,
  triggers, positive-TTL stale-read behavior, and a permissioned/audited action
  with preview/apply phases. The adapter remains read-only, while
  `getReportLifecycle()` provides an explicit, tenant-safe lifecycle snapshot
  and `previewReportRefresh()` / `applyReportRefresh()` delegate authorization,
  audit, and queueing through an application action host. Only a registered
  `SmrtReportCollection` may synchronously refresh stale reads, when its TTL is
  positive and the report is not manual.
- `views` accepts no authority. Persisted views must be normalized again through
  the current descriptor before restoring them, so changed column policy or a
  changed report definition fails closed. Treat unversioned persisted layouts as
  legacy v0 and migrate them to v1 before normalization; unknown versions must
  fail rather than being inferred. Export snapshots retain the canonical
  query fingerprint, projection, sort, as-of/freshness state, exact row count,
  and the fixed principal/tenant/report-definition/field-policy inheritance
  contract. A snapshot needs an application-host-issued opaque binding and an
  explicit offset-page read plan: workers advance it from offset zero instead
  of reusing a visible page. Preview, apply, worker, and artifact-serving
  boundaries must call the validators, including the host's immutable-snapshot
  assertion; application hosts own authorization, audit records, durable
  storage, download tokens, and queue execution.

## Runtime reports (#3711)

A runtime report is data, not code: `parseRuntimeReportSpec()` accepts a closed
grammar (no SQL, expressions, joins, tables, or tenants), and
`compileRuntimeReportSpec()` resolves it against a server-owned source
allow-list (including optional `fields`/`excludeFields`), the ObjectRegistry field policy, the live principal's permissions,
and an explicit fail-closed tenant predicate. Stored `RuntimeReport` specs are
re-compiled for the running principal on every run, and result rows are never
persisted. Assistant tools are in `@happyvertical/smrt-chat`. The full
contract, authority model, and deferred work are in
[agents/runtime-reports.md](agents/runtime-reports.md).

`./spec` (#4100) is the browser-safe half: the grammar, `runtimeReportSpecDigest`
(Web Crypto twin of the server-only `runtimeReportSpecHash`) and
`runRuntimeReportInMemory()`, which evaluates a spec over caller-held rows with
the compiler's own rules (`runtime-plan.ts`). It is a preview and test runner,
never an authority boundary. `spec-entry.test.ts` fails if that entry reaches a
Node built-in or any package module but `@happyvertical/smrt-core/smrt-error`;
`runtime-memory-parity.test.ts` holds it to the SQL path. Source descriptions
carry time and grouping hints and `./spec` exports the time-language helpers
(`runtime-dimensions.ts`, `runtime-time.ts`); see the runtime contract.

## Recipes (#3719)

`src/recipes.ts` declares `reports.materialized` (`MaterializedReportsRecipe`),
emitted into the built `manifest.json` and `smrt-knowledge.json` `recipes`. It
brings only the internal refresh bookkeeping tables (runs, watermarks, locks,
schedules, refresh tasks); an app's own `@report` classes are not listed because
they belong to the app. Those tables have no REST or MCP surface, so the recipe
has no `nav`. It declares `runtime: 'server'` (SQL aggregation, jobs) and no
`surfaces`: materialized reports do not yet have a browser surface. Runtime
report browser components stay on the `./svelte` subpath, while
`RuntimeReportsRecipe` names their route, widget, and options-editor exports.

User-facing help is `src/materialized.recipe.md` (#3591). It explains how the
assistant reads declared reports (`data.discover`/`data.inspect` and
`reports.query`/`reports.refresh` from `@happyvertical/smrt-agents`) and how
runtime reports (`reports.runtime.*` in `@happyvertical/smrt-chat`) differ: live,
never stored, saved only after a person confirms. Keep that split accurate when
either tool set changes. `{field:...}` references need a `@field({ description })`
on `state.ts` so the glossary can explain them. `src/__tests__/recipes.test.ts`
runs the real scan, manifest and generation passes in memory and renders the help.
See [core recipes](../core/agents/recipes.md).

## Conventions

- Report cache tables are normal `@smrt()` tables. Runtime refresh must not create schema.
- Store report metadata under field `_meta.__report`; scanner and runtime decorators must stay aligned.
- Joins, row expressions and filtered measures (#3903) compile to the SDK's `AggregateSpec` (`fromAlias`, `joins`, `expr`, `filter`); expressions are literal data nodes because the scanner reads decorator arguments statically. Qualify every source column with `src` once a report joins (refresh filters do), put the tenant match in the join's `ON`, and keep joined reports on `rebuild`.
- Keep SQL generation portable. Use the SDK `buildAggregate()`/`bucketExpr()` helpers for time buckets and `$N` placeholders.
- Do not add a local aggregate SQL builder here; the implementation lives in `@happyvertical/sql`.
- Refresh runtime tables are schema-managed. Runtime refresh must fail clearly when `_smrt_report_runs`, `_smrt_report_watermarks`, or `_smrt_report_locks` have not been migrated.
- Incremental refresh requires a source watermark column (default `updatedAt`) and soft-delete column (default `deletedAt`); it recomputes affected groups and deletes empty report groups instead of applying aggregate deltas.
- Raw aggregate refreshes must explicitly filter `tenant_id`; the tenancy interceptor only protects normal collection reads.
- Scheduled/on-change refreshes enqueue `SmrtReportRefreshTask.run()` through `@happyvertical/smrt-jobs`; do not add a separate report queue.
- `SmrtReportCollection` is a framework collection base (core's `SMRT_COLLECTION_BASE_NAMES`): a report collection never owns its model's table, even when an app manifest attributes the two to different packages. `pnpm test:postgres` runs the `*.optional.test.ts` lane (#3110).

## Package registration

`src/__smrt-register__.ts` embeds the provider manifest during library builds.
Import it before model decorators, including model-bearing subpaths (`state`
and `scheduler`), so consumer SSR bundles retain reports-qualified identities.
The bundle gate executes these public entries in a fresh consumer process.
Audit #3525 found no other published domain model package missing its shim;
packages without one contain framework utilities or example/test decorators.

## Schedule lifecycle

`tenantFanout: 'discover'` resolves non-null tenants in the source and existing
materialization at execution time only for signed global scheduled maintenance.
Include materialized scopes so rebuilds clear groups after their last source
row is deleted; discovery does not change incremental watermark semantics. Empty discovery must not call
refresh with an empty tenant array, which would select the global slice.
Schedule provisioning preserves existing state. Hosts bind terminal job events
with `ReportScheduleRunner.bindTaskRunner()` and dispose the returned binding
on shutdown; see [scheduled refresh lifecycle](README.md#scheduled-refresh-lifecycle).

## Runtime server surfaces (#3878)

`runtime-server.ts` owns the framework-neutral confirmation handler, current
principal run/archive helpers and chart loader. Source allow-lists come from
`packages.reports.runtime.sources`; no configuration means no sources. Never
accept identity or source configuration from JSON. The RuntimeReport run/archive
methods reuse read/create grants through `operationPermissions`, including the
archive UPDATE RLS binding. `RuntimeReportsRecipe` declares nav, route and
`runtime-report-chart` surfaces, and server runtime. The chart loader receives
`reportPrincipal` only from authenticated host context. See
[runtime contract](agents/runtime-reports.md) and
[browser surfaces](agents/runtime-report-browser.md).
