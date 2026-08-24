# @happyvertical/smrt-reports

Materialized aggregate report models for SMRT.

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

## Conventions

- Report cache tables are normal `@smrt()` tables. Runtime refresh must not create schema.
- Store report metadata under field `_meta.__report`; scanner and runtime decorators must stay aligned.
- Keep SQL generation portable. Use the SDK `buildAggregate()`/`bucketExpr()` helpers for time buckets and `$N` placeholders.
- Do not add a local aggregate SQL builder here; the implementation lives in `@happyvertical/sql`.
- Refresh runtime tables are schema-managed. Runtime refresh must fail clearly when `_smrt_report_runs`, `_smrt_report_watermarks`, or `_smrt_report_locks` have not been migrated.
- Incremental refresh requires a source watermark column (default `updatedAt`) and soft-delete column (default `deletedAt`); it recomputes affected groups and deletes empty report groups instead of applying aggregate deltas.
- Raw aggregate refreshes must explicitly filter `tenant_id`; the tenancy interceptor only protects normal collection reads.
- Scheduled/on-change refreshes enqueue `SmrtReportRefreshTask.run()` through `@happyvertical/smrt-jobs`; do not add a separate report queue.
