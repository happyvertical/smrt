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

## Conventions

- Report cache tables are normal `@smrt()` tables. Runtime refresh must not create schema.
- Store report metadata under field `_meta.__report`; scanner and runtime decorators must stay aligned.
- Keep SQL generation portable. Use the SDK `buildAggregate()`/`bucketExpr()` helpers for time buckets and `$N` placeholders.
- Do not add a local aggregate SQL builder here; the implementation lives in `@happyvertical/sql`.
- Refresh runtime tables are schema-managed. Runtime refresh must fail clearly when `_smrt_report_runs`, `_smrt_report_watermarks`, or `_smrt_report_locks` have not been migrated.
- Incremental refresh requires a source watermark column (default `updatedAt`) and soft-delete column (default `deletedAt`); it recomputes affected groups and deletes empty report groups instead of applying aggregate deltas.
- Raw aggregate refreshes must explicitly filter `tenant_id`; the tenancy interceptor only protects normal collection reads.
- Scheduled/on-change refreshes enqueue `SmrtReportRefreshTask.run()` through `@happyvertical/smrt-jobs`; do not add a separate report queue.
