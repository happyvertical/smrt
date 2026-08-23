# @happyvertical/smrt-reports

Materialized aggregate reports for s-m-r-t. Define a report as a decorated class,
compile it to a portable aggregate query, and refresh its normal s-m-r-t table
manually, on a schedule, after source changes, or when a TTL expires.

Runtime refresh checks that its tables exist (existence only, not columns or
indexes) and fails clearly if they do not; it does not create report or system
tables. Include report models in normal manifest-driven migrations before
refreshing.

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

## Report adapter

The package also exports a transport-neutral adapter for report surfaces:

```ts
import {
  buildReportAdapterDescriptor,
  queryReportMaterializedRows,
  reportMaterializedRowKey,
} from '@happyvertical/smrt-reports';

const descriptor = await buildReportAdapterDescriptor(MonthlyRevenue, {
  tenantScope: 'current',
});
const result = await queryReportMaterializedRows(MonthlyRevenue, {
  version: 1,
  requestId: 'monthly-revenue-first-page',
  mode: 'rows',
  projection: ['id', 'customer_id', 'revenue'],
  page: { kind: 'offset', offset: 0, limit: 25 },
  sort: [{ field: 'id', direction: 'asc' }],
});
const rowKey = reportMaterializedRowKey(result.rows[0]);
```

`ReportAdapterDescriptor` is deterministic JSON with a stable resource id,
`id` as the identity field, typed report columns, a canonical `DataQuerySchema`,
and structural DataTable hints. The hints are deliberately not a `smrt-ui`
dependency. Consumers may map the descriptor to their own presentation layer.
The adapter exposes only persisted report columns and the primary key: transient,
system, and non-column fields are not surfaced. Sensitive/secret fields and
fields with a `readPermission` are excluded without a principal, so the
descriptor fails closed.

`queryReportMaterializedRows()` is the bounded read slice for already-materialized
rows. It supports projection, offset/limit paging (default limit 50), and
deterministic ordering by the stable `id` identity. Dimension/measure filters,
`WHERE`/`HAVING` mapping, facets, and caller-selected dimension/measure ordering
are intentionally not part of this adapter contract. Every returned row must
have a non-empty string `id`; use that value, never a display or page index, for
row identity.

When no collection is injected, reads resolve the registered report collection
through `ObjectRegistry`, allowing normal s-m-r-t collection interceptors to enforce
tenant filtering. `tenantScoped` and `tenantField` in the descriptor are true
only when the report is actually registered with tenant metadata; a scope string
alone is not an authority boundary. An injected collection is application-owned
and must provide the equivalent tenant boundary. Raw aggregate refreshes still
need explicit tenant predicates as described above.

The descriptor's `refresh` section declares mode, triggers, stale-read behavior,
and a permissioned, audited `refresh` action with `preview` and `apply` phases.
It does not perform a refresh, authorize a caller, write audit records, or track
run state. Those lifecycle responsibilities belong to the follow-up refresh
adapter in issue #2460. Generic collection reads remain read-only and report
unknown freshness; only a registered `SmrtReportCollection` can synchronously
refresh a stale read, and only when its TTL policy is positive and not manual.

## Development

```bash
pnpm --filter @happyvertical/smrt-reports test
pnpm --filter @happyvertical/smrt-reports typecheck
pnpm --filter @happyvertical/smrt-reports build
```

See [`AGENTS.md`](./AGENTS.md) for refresh, schema, and tenancy invariants.
