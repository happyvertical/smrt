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
  subtotal = 0.0;
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
  @sum('subtotal') revenue = 0.0;
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
| `@groupBy(column?)` | Group by a source column, a joined column (`'wo.title'`), or `{ expr }` |
| `@minute()` through `@year()` | Bucket a source timestamp |
| `@sum()`, `@avg()`, `@min()`, `@max()` | Aggregate a source or joined column, or a row `{ expr }`, optionally `{ filter }`ed |
| `@count()` | Count rows or distinct values, optionally `{ filter }`ed |
| `@aggregate()` | Define a custom supported aggregate shape |

Every non-system report field must be a grouping key, time bucket, or aggregate.
Metadata is stored under the field's `_meta.__report` contract so scanner and
runtime compilation stay aligned.

## Joins, row expressions and filtered measures

A report can read a related model, compute a value from each row, and count
only the rows a condition holds for. Each compiles to the SQL aggregate API in
`@happyvertical/sql`; nothing is built as SQL text here.

```ts
@report({
  source: AttendanceSegment,
  // Many-to-one: AttendanceSegment.workRefId holds a WorkOrder id.
  joins: { wo: { source: WorkOrder, on: 'workRefId' } },
})
class LabourByWorkOrder extends SmrtReport {
  @groupBy() workRefId = '';
  @groupBy('wo.title') workOrder = '';
  @max('wo.estimatedHours') estimatedHours = 0;

  // A row expression: seconds from createdAt to claimedAt, averaged.
  @avg({ expr: { op: 'secondsBetween', later: { col: 'claimedAt' }, earlier: { col: 'createdAt' } } })
  avgResponseSeconds = 0;

  // A filtered count: one number rather than a two-row grouping.
  @count({ filter: { op: 'eq', left: { col: 'halted' }, right: { value: true } } })
  haltedSegments = 0;
}
```

- **Joins** are many-to-one, keyed `alias: { source, on, to?, type? }`. `on` is a
  field of the report source; `to` is the related field it points at (default
  `id`) and must identify one related row per tenant, or source rows repeat.
  `type` is `left` (default, keeps a source row whose related row is gone) or
  `inner`. Aliases are lower-case identifiers and not `src`. Reference a joined
  field as `alias.field` in `@groupBy`, the aggregate and bucket decorators,
  expressions and `where`.
- **Tenancy is built into the join.** When the related model is tenant-scoped the
  join also matches `tenant_id` between the two rows, so an id that points at
  another tenant's row never matches. A tenant-scoped join from a source with no
  tenant field is refused. Soft-deleted related rows never match.
- **Field policy follows the data.** A report column that reads a joined field
  marked sensitive or `readPermission`-gated is withheld from the adapter
  descriptor exactly as that field would be.
- **Expressions are data, written as literals** (the manifest scanner reads
  decorator arguments statically, so builder calls would be dropped): `{ col }`,
  `{ value }`, `add`/`sub`/`mul`/`div`, `secondsBetween`, `eq`/`ne`/`lt`/`lte`/
  `gt`/`gte`, `and`/`or`/`not`, `isNull`/`isNotNull` and `coalesce`. A `col`
  names a model field, never a SQL column. `div` returns NULL for a zero
  divisor. `expr` and `filter` work with `count`, `sum`, `avg`, `min` and `max`.
- **Joined reports refresh by rebuild only.** A change to a joined row does not
  move the source's watermark, so declaring `mode: 'incremental'` is refused and
  any trigger that asks for an incremental refresh (a schedule, `onChange`, a
  job) is run as a rebuild. List the joined models in `refresh.onChange` to
  rebuild when they change. Rows whose tenant is `NULL` (the global slice) do not
  match tenant-scoped related rows, because `NULL = NULL` is not true in SQL.
- **Saved views and snapshots notice definition changes.** A column's expression, filter and the joins it reads are part of its descriptor (`semantics`) and so of the report definition fingerprint; changing one invalidates stored views and export snapshots. Reports without joins or expressions keep their existing fingerprints.
- **No drilldown by joined or computed keys.** A row grouped by a joined column or
  a computed value cannot be bound back to source rows by a source column, so
  `buildReportDrilldownQuery()` refuses such reports.

The runtime-report grammar stays closed: runtime reports have no joins or
expressions.

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
  {
    collection: reports,
    // Preserve the resource identity of the descriptor selected above.
    adapter: { tenantScope: 'current' },
  },
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

Materialized query results normalize hydrated values against their declared
column types. Objects in scalar columns become JSON text; JSON columns retain
structured values. Date-only and timezone-less timestamps use UTC, matching
SQLite storage, and temporal facet buckets follow the same rule. Strings over
4096 characters are shortened with `truncated` and a warning, except row IDs:
identities are never rewritten, and unsupported IDs fail validation. Unsafe bigint
values fail instead of silently losing precision.

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
When a consumer selects a descriptor with `ReportAdapterOptions`, pass those
same options through the query's `adapter` option so returned and background
task resource ids stay aligned with the selected descriptor.
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
report-refresh job is queued. Manual refresh hosts must also return a versioned,
non-secret `executionAuthority` binding. Each worker process registers the named
host with `registerReportRefreshExecutionAuthorityHost()`; the task checks the
persisted tenant binding, resolves current membership and permission, and records
an allowed or denied execution audit immediately before refresh. Every enqueue
path also receives a `DurableJobPayloadSigner`, and every worker registers it
with `registerReportRefreshJobIntegritySigner()`. This authenticates the task
target, trigger, tenant scope, authority reference, and payload across storage;
the signing key is never persisted. Scheduled and on-change maintenance jobs
remain system-authority jobs and do not carry an initiating user, but their job
payloads use the same integrity boundary. Only a registered `SmrtReportCollection` can
synchronously refresh a stale read, and only when its TTL policy is positive and
not manual.

### Scheduled refresh lifecycle

Declare `refresh: { schedule: '*/5 * * * *', tenantFanout: 'discover' }`
on a tenant-scoped report to discover distinct non-null source tenants each
scheduled run. Include scopes still present in the materialized table so a
the next rebuild removes stale groups for tenants losing their final source row.
Discovery preserves the configured refresh mode. Incremental reports still need
a `fullRebuildSchedule` to catch hard deletions that do not advance a source
watermark. Provision schedules with `ensureReportRefreshSchedules({ db,
reports })`; no discovered scopes means no work, and discovery never refreshes
the global slice.
The worker uses the registered source/report tenant columns and its supplied
maintenance executor. Discovery does not grant database privileges or widen a
tenant-bound or manual job. Keep `tenantFanout: true` with explicit `tenantIds`
when the host owns a fixed tenant list.

Initialize a `ReportScheduleRunner` and a jobs `TaskRunner` against the migrated
database, then call `const unbind = schedules.bindTaskRunner(tasks)` before
starting them. This connects terminal job events to schedule counters, freeing
the concurrency slot after success or failure. Repeated binding is idempotent;
call `unbind()` on shutdown. Listen for `runner:error` to detect failed counter
updates. Persisted failure messages use the jobs package redaction policy.
Durable payload signing and execution-time authority checks remain
required; completion accounting uses the signed schedule identity.

Repeated schedule provisioning inserts missing identities and preserves existing
history, next-run time, running count, and operator settings. A different cron,
mode, or tenant scope identifies a different schedule; explicitly disable obsolete
schedules when changing those settings.

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

## Runtime reports

A report can also be defined at runtime as data. `RuntimeReportSpec` is a closed,
versioned structure (source id, dimensions, measures, filters, having, sort,
chart hint) with no free-form query text. `compileRuntimeReportSpec()` checks it
against a server-owned source allow-list, field policy (sensitive and
permission-gated fields are not nameable), the caller's permissions, and tenant
isolation, then targets the same aggregate plan as declared reports.
`RuntimeReport` stores validated specs per tenant, and a stored spec is
re-compiled for the running user on every run. Result rows are not stored. A row
can only be inserted, or have its spec changed, through `saveRuntimeReport()`
with the spec hash a human confirmed; the model layer refuses every other write. The
chat package offers matching assistant tools that propose a spec, preview it,
and save only after a human confirms. See
[`agents/runtime-reports.md`](./agents/runtime-reports.md).

## Browser components

`@happyvertical/smrt-reports/svelte` exports saved-report and detail screens,
a confirmation card, a report/measure picker, and a shared-chart result view.
They accept a principal-scoped browser transport and show an unavailable state
when no server is supplied. See the [browser integration contract](./agents/runtime-report-browser.md)
for route-host identity and capability props, confirmation wiring, recipe
surfaces, and playground previews.

## Development

```bash
pnpm --filter @happyvertical/smrt-reports test
pnpm --filter @happyvertical/smrt-reports typecheck
pnpm --filter @happyvertical/smrt-reports build
```

See [`AGENTS.md`](./AGENTS.md) for refresh, schema, and tenancy invariants.
