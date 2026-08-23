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
  buildReportDrilldownQuery,
  queryReportMaterializedRows,
  reportMaterializedRowKey,
  splitReportFilterScopes,
} from '@happyvertical/smrt-reports';

const descriptor = await buildReportAdapterDescriptor(MonthlyRevenue, {
  tenantScope: 'current',
});
const reports = await MonthlyRevenueCollection.create({ db: 'app.db' });
const result = await queryReportMaterializedRows(
  MonthlyRevenue,
  {
    version: 1,
    requestId: 'monthly-revenue-first-page',
    mode: 'rows',
    projection: ['id', 'customer_id', 'revenue'],
    filter: {
      kind: 'all',
      filters: [
        {
          kind: 'condition',
          field: 'customer_id',
          operator: 'eq',
          value: 'customer-42',
        },
        {
          kind: 'condition',
          field: 'revenue',
          operator: 'gte',
          value: 1000,
        },
      ],
    },
    page: { kind: 'offset', offset: 0, limit: 25 },
    sort: [{ field: 'revenue', direction: 'desc' }],
  },
  { collection: reports },
);
const rowKey = reportMaterializedRowKey(result.rows[0]);
const drilldown = await buildReportDrilldownQuery(MonthlyRevenue, result.rows[0]);
```

`ReportAdapterDescriptor` is deterministic JSON with a stable resource id,
`id` as the identity field, typed report columns, a canonical `DataQuerySchema`,
and structural DataTable hints. The hints are deliberately not a `smrt-ui`
dependency. Consumers may map the descriptor to their own presentation layer.
The adapter exposes only persisted report columns and the primary key: transient,
system, and non-column fields are not surfaced. Sensitive/secret fields and
fields with a `readPermission` are excluded without a principal, so the
descriptor fails closed.

The `dataTable.columns` entries carry neutral `headerPath`, `valueFormat`,
alignment, role, and responsive hints. Grouping fields, time buckets, and
aggregate measures receive deterministic multi-level header ancestry; a
consumer can override any column by stable id with
`buildReportAdapterDescriptor(..., { dataTable: { columns: { ... } } })`.
`valueFormat` is an instruction for the rendering boundary only: rows returned
by `queryReportMaterializedRows()` retain their raw JSON-safe values for
sorting, exports, and agents. Use `dataTable.structuralRows` for a computed
summary, subtotal, aggregate, or footer. Each is marked `selection: 'excluded'`
and `actions: 'excluded'`, and must be passed to the consumer table's structural
row surface rather than its selectable data rows.

`queryReportMaterializedRows()` is the bounded read slice for already-materialized
rows. It supports projection, offset/limit paging (default limit 50),
deterministic multi-sort (with `id` as the final tie-break), typed filters, and
database-backed dimension facets. A descriptor marks group/time fields as
`filterScope: 'where'` and aggregate measures as `filterScope: 'having'`; use
`splitReportFilterScopes()` when constructing a live source query. An AND may
combine the two scopes, but an OR or NOT cannot mix them, because moving either
side across a source `WHERE`/`HAVING` boundary would change its meaning.

The materialized collection executes the normalized, allowlisted predicate as
parameterized SQL and applies it identically to rows, totals, and facets. It
never accepts raw SQL, source field paths, tenant ids, or principal ids.
The descriptor's `queryExecution` contract declares three delivery choices:
`visible` (the default) returns rows for an already-authorized surface,
`silent` returns the same bounded result while making no visible-surface change,
and `background` delegates a normalized, authority-free task to the application's
`enqueueBackgroundQuery` host. A background result is only a queue handle, never
materialized rows. The host retains the authenticated principal, tenant, report
definition, field policy, database, and eventual job execution; none can be
supplied in a query request or background task.
`buildReportDrilldownQuery()` carries only the row's declared groups/buckets
and a fixed inheritance contract for the current principal, tenant, report
definition, and field policy; an authenticated source adapter must enforce that
contract before it reads source records. Time buckets remain declarative so the
source adapter keeps the report's database/timezone semantics. Every returned
row must have a non-empty string `id`; use that value, never a display or page
index, for row identity.

When no collection is injected, reads resolve the registered report collection
through `ObjectRegistry`, allowing normal s-m-r-t collection interceptors to enforce
tenant filtering. `tenantScoped` and `tenantField` in the descriptor are true
only when the report is actually registered with tenant metadata; a scope string
alone is not an authority boundary. An injected collection is application-owned
and must provide the equivalent tenant boundary. Raw aggregate refreshes still
need explicit tenant predicates as described above.

The descriptor's `refresh` section declares mode, triggers, stale-read behavior,
and a permissioned, audited `refresh` action with `preview` and `apply` phases.
The adapter itself stays read-only. Call `getReportLifecycle()` for a tenant-safe
snapshot of current, stale, refreshing, lock-skipped, or failed materialization
state; it redacts lock owners, raw errors, and tenant-fanout identifiers. Pass a
`lifecycle` option to `queryReportMaterializedRows()` only when a consumer needs
that context; the result then distinguishes a current, stale, or read-triggered
refresh. `previewReportRefresh()` and `applyReportRefresh()` require an
application action host to authorize and audit the caller before a durable
report-refresh job is queued. Only a registered `SmrtReportCollection` can
synchronously refresh a stale read, and only when its TTL policy is positive and
not manual.

### Saved views and snapshot exports

`normalizeReportSavedView()` and `restoreReportSavedView()` provide the
serializable view boundary. A storage host owns the saved view's tenant and
owner; on every restore it must pass the stored payload through the current
descriptor. That reapplies field, projection, sorting, grouping, and definition
policy, so a stale view cannot reveal a field that is no longer allowed.
`migrateReportSavedView()` upgrades the original unversioned (or explicit v0)
layout to v1 before that current-policy validation; unsupported future versions
fail clearly rather than being guessed.

Build an export from a completed materialized-row read with
`createReportExportSnapshot()`, supplying an opaque binding from the
application's immutable materialization-snapshot host, then call
`createReportExportRequest()`. The snapshot fixes the canonical query
fingerprint, normalized projection and sort, exact row count, `asOf`,
`refreshedAt`, stale state, and definition fingerprint. Every request also
contains a deterministic offset-page read plan; a renderer begins at offset zero
and advances by its validated page size until the exact bounded row count is
reached. Use `createReportExportPageRequest()` for each page; it preserves the
frozen query semantics while replacing only visible pagination.

Every request is bounded by rows, bytes, and deadline; exports over the
foreground row limit become an authority-free background handoff. Use
`previewReportExport()` and `applyReportExport()` with the same application
action host for human and agent callers. The host authorizes and audits the
fixed `reports.export` action; exports containing personal, sensitive, or secret
columns require explicit confirmation.

Preview, apply, and every worker call `validateReportExportExecution()`, which
requires the host to prove that the opaque binding still resolves to the exact
immutable materialization snapshot under its current principal, tenant, report
definition, and field policy. If it cannot, the operation fails rather than
relabelling newer rows with an old `asOf`. Artifact metadata has no URL or
download token; before serving it, call `validateReportExportArtifact()` to
reject expiry, definition drift, and out-of-bounds progress, then apply the
host's current authorization and snapshot validation again.

## Development

```bash
pnpm --filter @happyvertical/smrt-reports test
pnpm --filter @happyvertical/smrt-reports typecheck
pnpm --filter @happyvertical/smrt-reports build
```

See [`AGENTS.md`](./AGENTS.md) for refresh, schema, and tenancy invariants.
