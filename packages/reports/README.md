# @happyvertical/smrt-reports

Materialized aggregate reports for s-m-r-t. Define a report as a decorated class,
compile it to a portable aggregate query, and refresh its normal s-m-r-t table
manually, on a schedule, after source changes, or when a TTL expires.

Runtime refresh verifies schema but does not create report or system tables.
Include report models in normal manifest-driven migrations before refreshing.

## Installation

```bash
pnpm add @happyvertical/smrt-reports
```

## Define a report

```ts
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  groupBy,
  month,
  report,
  SmrtReport,
  SmrtReportCollection,
  sum,
} from '@happyvertical/smrt-reports';

@smrt()
class Invoice extends SmrtObject {
  customerId = '';
  issuedAt = new Date();
  totalAmount = 0.0;
  status = '';
}

@report({
  source: Invoice,
  where: { status: 'paid' },
  refresh: { manual: true },
})
@smrt()
class MonthlyRevenue extends SmrtReport {
  @groupBy('customerId') customerId = '';
  @month('issuedAt') issuedMonth = new Date();
  @sum('totalAmount') revenue = 0.0;
}

class MonthlyRevenueCollection extends SmrtReportCollection<MonthlyRevenue> {
  static readonly _itemClass = MonthlyRevenue;
}

const reports = await MonthlyRevenueCollection.create({ db: 'app.db' });
await reports.refresh();
const rows = await reports.list({ orderBy: 'issued_month DESC' });
```

## Decorators

| Decorator | Meaning |
| --- | --- |
| `@report({ source, ... })` | Declare the source and refresh policy |
| `@groupBy(column?)` | Group by a source column |
| `@minute()` through `@year()` | Bucket a source timestamp |
| `@sum()`, `@avg()`, `@min()`, `@max()` | Aggregate a source column |
| `@count()` | Count rows or distinct values |
| `@aggregate()` | Define a custom supported aggregate shape |

Every non-system report field must be a grouping key, time bucket, or aggregate.
Metadata is stored under the field's `_meta.__report` contract so scanner and
runtime compilation stay aligned.

## Refresh modes

- `rebuild` replaces the materialized result.
- `incremental` recomputes groups affected after a source watermark and removes
  groups that become empty.
- TTL-backed collections refresh before reads when the report is stale.
- `ReportScheduleRunner` and `registerReportRefreshInterceptor()` enqueue
  durable refresh jobs through [`smrt-jobs`](../jobs/README.md).

Incremental sources need watermark and soft-delete columns, normally
`updatedAt` and `deletedAt`. Tenant-scoped aggregate SQL explicitly filters
`tenant_id`; normal collection interceptors cannot secure a raw aggregate.

## Public entry points

The package exposes focused subpaths for consumers that want only the compiler,
decorators, refresh engine, scheduler, state models, or aggregate compatibility
helpers:

```text
@happyvertical/smrt-reports
@happyvertical/smrt-reports/compiler
@happyvertical/smrt-reports/decorators
@happyvertical/smrt-reports/refresh
@happyvertical/smrt-reports/scheduler
@happyvertical/smrt-reports/state
@happyvertical/smrt-reports/aggregate
```

## Development

```bash
pnpm --filter @happyvertical/smrt-reports test
pnpm --filter @happyvertical/smrt-reports typecheck
pnpm --filter @happyvertical/smrt-reports build
```

See [`AGENTS.md`](./AGENTS.md) for refresh, schema, and tenancy invariants.
