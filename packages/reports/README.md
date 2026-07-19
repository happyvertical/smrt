# @happyvertical/smrt-reports

Materialized, tenant-aware aggregate report models and refresh orchestration for SMRT.

## Installation

```bash
pnpm add @happyvertical/smrt-reports
```

## Main APIs

- `SmrtReport` for materialized report rows.
- Report, grouping, time-bucket, and aggregate decorators.
- Portable `ReportDefinition` to aggregate-spec compilation.
- Rebuild and incremental refresh with runs, watermarks, and locks.
- Cron and on-change scheduling through `@happyvertical/smrt-jobs`.

Report tables and `_smrt_report_*` runtime tables are schema-managed; refresh operations verify them and never create application schema at runtime.

## Validation

```bash
pnpm --filter @happyvertical/smrt-reports test
pnpm --filter @happyvertical/smrt-reports typecheck
```
