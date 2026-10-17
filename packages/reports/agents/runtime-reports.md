# Runtime reports (#3711)

Reports the assistant (or any caller) defines at runtime from a user request.
A report is a **declarative spec stored as data**; there is no codegen, no new
table per report, and no SQL, expression, join or raw-identifier syntax in the
grammar. Declared (`@report`) reports are unchanged and remain the way to get a
**materialized** report.

## Files

| File | Role |
| --- | --- |
| `src/runtime-spec.ts` | `RuntimeReportSpec` grammar, strict parser, limits, canonical JSON, Web Crypto digest (browser-safe) |
| `src/runtime-spec-hash.ts` | `runtimeReportSpecHash()` (`node:crypto`, server only) |
| `src/runtime-plan.ts` | Column, operator, aggregate, coercion and cell rules shared by both runners (browser-safe) |
| `src/runtime-compiler.ts` | `compileRuntimeReportSpec()`, `describeRuntimeReportSource()`, `runRuntimeReport()` |
| `src/runtime-dimensions.ts` | Time and grouping hints in source descriptions (browser-safe) |
| `src/runtime-time.ts` | Time language: buckets and periods from words, against `now` (browser-safe) |
| `src/runtime-memory.ts` | `runRuntimeReportInMemory()`, `describeRuntimeReportMemorySource()` (browser-safe) |
| `src/spec.ts` | The `./spec` subpath: the browser-safe exports above |
| `src/runtime-server.ts` | Same-origin confirmation, principal-bound run/archive, chart loader |
| `src/runtime-report.ts` | `RuntimeReport` model (`runtime_reports`), `saveRuntimeReport()`, list/get/archive, `runStoredRuntimeReport()` |

Assistant tools live in `@happyvertical/smrt-chat` (`createRuntimeReportTools()`,
`src/runtime-report-tools.ts`).


Source definitions may set `fields` (an allow-list) and `excludeFields` (a deny-list).
Both use exact public model field names. Omitted `fields` retains all eligible
fields; `fields: []` exposes none. Exclusions win, and neither option bypasses
model sensitivity, field permissions, or tenant restrictions. Invalid lists and
unknown names reject the source with `unsupported_source`, including misspelled
exclusions. Descriptions, assistant tools, confirmation and saved-report runs
resolve this same policy on every invocation.

Standard timestamps have one public spelling: `createdAt` and `updatedAt`.
Snake-case `created_at`/`updated_at` remain physical SQL columns, not accepted
spec or configuration field names. Existing saved specs using those aliases must
be proposed again with canonical names and confirmed. Model restrictions on any
alias protect the whole physical column; host exclusions also cover aliases.

```typescript
{ id: 'incidents', className: 'Incident', collection: 'incidents',
  fields: ['id', 'title', 'createdAt', 'status'],
  excludeFields: ['signatureAssetId'] }
```
The example assumes `signatureAssetId` is a declared model field; exclusions
are validated even if an allow-list already omits that field.

## Spec

`version: 1`, `title`, optional `description`, `source` (a server-owned source
id), `dimensions[]` (`field`, `as?`, `bucket?`), `measures[]` (`fn`: `count`,
`countDistinct`, `sum`, `avg`, `min`, `max`; `field?`; `as?`), `filters[]`
(AND-ed; ops `eq ne gt gte lt lte in notIn contains isNull isNotNull`),
`having[]` (measure alias, numeric compare), `sort[]`, `limit` (1-1000, default
100) and a `chart` hint (`table|bar|line|pie|stat`, `x`, `y[]`). Unknown keys
at any level are rejected. Bounds (entries, string length, `in` list size,
alias charset, reserved words) are in `RUNTIME_REPORT_LIMITS`.

The parser normalizes defaults and derives aliases, so equal specs hash equally
(`runtimeReportSpecHash`). The hash is what a human confirmation binds to.
`runtimeReportSpecDigest` computes the same hex with Web Crypto for browsers
(async; needs a secure context).

## Browser grammar and in-memory runner (#4100)

`@happyvertical/smrt-reports/spec` imports no Node built-in and, of
smrt-core, only the import-free `@happyvertical/smrt-core/smrt-error` (the
root entry still reaches the registry's manifest loader), so a browser parses
specs with the server's own parser. `runRuntimeReportInMemory(spec,
rows, { sources, maxRows?, now? })` evaluates a parsed spec over rows the
caller already holds and returns the `RuntimeReportResult` shape (`specHash`
included). A `RuntimeReportMemorySource` is `{ id, label?, description?,
schema: [{ name, type, label?, format? }], fields?, excludeFields? }`: the same
allow/deny semantics as a server source, `_`-prefixed names and `tenantId`
never nameable, and a declared `deletedAt` soft-deletes.
`describeRuntimeReportMemorySource()` is the `reports.runtime.sources`
counterpart.

Both runners call `runtime-plan.ts` for columns, operator/aggregate rules and
value coercion, so errors carry the same codes and paths. SQL-shaped semantics:
comparisons and `IN`/`NOT IN` never match NULL, `contains` is case-sensitive,
groups without dimensions always yield one row, NULLs sort first ascending (as
SQLite), weeks start Monday, buckets are UTC. Result datetimes are ISO-8601
(PostgreSQL/DuckDB form; SQLite returns bucket TEXT). `runtime-memory-parity.test.ts`
runs a spec matrix through both runners on SQLite and requires identical results.

### Time and grouping hints

Both source descriptions carry `timeFields`, `defaultTimeField` (the natural
date "by month" buckets: an invoice's issue date, never `createdAt` when a
business date exists) and `dimensions` (fields worth grouping by, most useful
first), and each field a `dimension` kind (`time`, `category`, `relation`) when
it is one, plus its declared `enum`. A source definition may declare
`timeField` and `dimensions` (canonical names; unknown names are
`unsupported_source`, hidden ones are dropped for that principal). Otherwise
`runtime-dimensions.ts` derives them: a business date
(`@field({ ui: { format: 'date' } })`) else the first non-bookkeeping datetime;
closed text fields, booleans and foreign keys as groupings, never `id`, free
text or names marking plumbing (`…Hash`, `…Json`, `…Authority`, `external…`,
`historical…`). They are hints for choosing, not authority: a spec may still
group by any exposed field.

`parseRuntimeReportTime(text, now)` reads a request's time words ("by month",
"weekly", "over time", "last quarter by week") into a bucket, a period and
whether time came up; `resolveRuntimeReportTimeRange(phrase, now)` resolves
"last month", "this year", "last 90 days", "Q3", "December" to `[from, to)`
dates (UTC). Assistants resolve time with these rather than asking a model to
do date arithmetic.

**It is a browser preview and test runner, not an authority boundary.** It has
no registry field policy, principal, RBAC or tenant: whoever supplies the rows
has already decided they may be seen. Production reports compile on the server
for the live principal and save only through the confirmed `saveRuntimeReport()`.

## Authority model

A spec carries **no authority**. Everything is decided at compile time from
inputs the caller cannot supply through the spec:

- **Sources.** `RuntimeReportCompileContext.sources` is a server allow-list of
  `{ id, className, collection }`. The spec names an id; unknown and
  not-offered answer identically (`unknown_source`). `authorizeSource` is the
  host's RBAC hook (the chat tools call `run.assertOperation(collection,
  'read')`) and runs before any field is enumerated. A host should also narrow
  `sources` to those the principal may read before compiling (the chat tools do),
  because `authorizeSource` only runs for an id that is in the list: otherwise
  an RBAC refusal for a configured id and `unknown_source` for an absent one are
  different answers, and a caller can enumerate the configured source ids. `collection` is the
  permission-catalog collection **slug** (the `<collection>` of
  `<collection>.read`, for example `runtimereports`), or the registered model
  class, which resolves to that slug through the catalog's own helper. It is
  never a class name string: `Invoice` derives `Invoice.read`, which no
  catalog contains, so every read is denied and the source is silently not
  offered.
- **Field policy.** Names are resolved from the ObjectRegistry, never from the
  spec. Not nameable: `sensitive` / `sensitivity: sensitive|secret` fields,
  `readPermission` fields unless `context.permissions` holds that permission,
  `transient`, `json`/relationship fields, `_`-prefixed internals and the tenant
  column. A hidden field is reported exactly like an absent one
  (`unknown_field`), so the compiler is not an existence oracle.
- **Types.** `sum`/`avg` need numeric fields, `min`/`max` numeric or datetime,
  `bucket` needs datetime, `contains` needs text, id fields accept only UUIDs
  and equality-style ops. Values are coerced to the field type, then bound.
- **Tenancy.** Raw aggregates bypass collection interceptors, so the compiler
  adds the tenant predicate itself (same column resolution as refresh).
  Tenant-scoped source with no tenant in scope reads only NULL-tenant rows;
  there is no cross-tenant option and `withSystemContext()`/super-admin bypass
  are deliberately not honored. Sources without a tenant column are global by
  definition. `deletedAt` and STI-child discriminators are applied when the
  source has them.
- **SQL safety.** The plan is an `AggregateSpec` executed by the SDK
  `buildAggregate()`: identifiers are registry-derived and re-validated by the
  builder, values are `$N` parameters, and output aliases are prefixed `r_`
  inside the SQL so an alias can never shadow a source column.
- **Re-validation.** A stored report is re-parsed (hash-checked) and
  re-compiled against the **running** principal on every run, so policy changes
  apply immediately and a viewer without a permission cannot run a report saved
  by someone who had it.
- **Stored-report storage.** The tenancy interceptor filters by the AMBIENT
  tenant, while compilation uses the principal's tenant. The chat tools bind the
  two: they enter the principal's tenant context for `list`/`get`/`save` (as the
  data-surface guard does), refuse when an ambient tenant disagrees with the
  principal (on `apply`, before the human is asked to confirm, #3768), require
  a tenant for any stored-report use, and pass the principal
  tenant as an explicit owner filter (`getRuntimeReport`/`listRuntimeReports`
  accept `tenantId`) that still holds under a system context.

`listRuntimeReports` also accepts exact `createdByUserId` and `specHash`
predicates. They are ANDed with status and explicit/ambient tenant filters before
limiting results, so hosts can list a principal's saved reports or find a previous
save of the compiled normalized spec without retrieving other authors' reports.
These filters never replace authorization. See the
[list-filter contract and test matrix](runtime-report-list-filters.md).

## Storage and surface

`RuntimeReport` is `@TenantScoped({ mode: 'required' })` with `spec` (normalized
JSON text), `specHash`, denormalized `title`/`description`/`sourceId`,
`status` (`active|archived`) and `createdByUserId`. `validateBeforeSave()` parses
whatever was written and re-derives every denormalized column, so columns
cannot disagree with the spec. `getSpec()` throws if the JSON no longer matches
`specHash` (out-of-band edit). Adopting apps need a `db:migrate` for the new
`runtime_reports` table; runtime never creates schema. Existing deployments also
run `db:migrate` for the confirmation lookup index `idx_runtime_reports_confirm`
before enabling browser confirmation.

**Invariant: no row is inserted, and no spec/title/source/description/author is
changed, except through the confirmed save.** It is enforced in the model layer,
not by which surfaces exist. `validateBeforeSave()` refuses (`confirmation_required`,
403) every insert, and every update that changes those columns, unless the
instance carries a confirmation proof. The proof is a symbol-keyed constructor
option plus a module-private `WeakMap`; only `saveRuntimeReport()` can mint it,
and only when `confirmedSpecHash` equals the compiled plan's hash (the value
handed to the application's `RuntimeReportConfirmationHost`). It is single use
and tied to that exact spec hash. A REST body, a manifest tool call or
`new RuntimeReport({...}).save()` cannot carry it, so it is refused whatever
surface delivered it. A reused id on an insert is refused the same way, so it
cannot overwrite a stored spec. Archiving or unarchiving (a `status` change with
the stored columns untouched) is allowed for an authorised writer.

**Exposed operations** (these decide the permission catalog and RLS grants):

| Surface | Operations |
| --- | --- |
| REST (`api`) | `list`, `get`, `create`, `run`, `archive` |
| CLI | `list`, `get`, `run`, `archive` |
| MCP | `list`, `get`, `run`, `archive` |

The permission catalog therefore holds exactly `<collection>.read` and
`<collection>.create` for `RuntimeReport` (the collection slug is
`runtimereports`). `update` and `delete` exist on no surface, so they are not in
the catalog, not grantable to a role and not nameable in a persona's
`allowedTools`. REST `create` exists only so the catalog knows the operation the
confirmed save performs (`assertOperation(RuntimeReport, 'create')`); its body is
always refused by the invariant above. The generic manifest tool dispatcher in
`@happyvertical/smrt-chat` additionally never offers or runs a write operation on
`RuntimeReport` (`isRuntimeReportWriteOperation`), so the assistant persists a
report only through `reports.runtime.define` (apply).

**Result rows are never persisted.** A result computed for one principal must
not be served to another, so the table stores definitions only.

## Why not materialize

Declared reports materialize into a build-time `@smrt()` table and refresh
through the lock/watermark engine. Runtime schema creation is forbidden here, so
a runtime spec runs as a bounded live aggregate on the same `AggregateSpec`
compile target instead. Promoting a proven runtime spec to a declared,
materialized `@report` (codegen plus a migration) is a maintainer decision and
is tracked as a follow-up.

## Money

Money fields are integer minor units; `sum`/`min`/`max` keep the integer type and
the source field's `format` hint is carried onto the result column. Integer
results beyond the JavaScript safe range throw `invalid_result` rather than
losing precision. `avg` is decimal.

## Assistant and browser flow (#3878)

`reports.runtime.sources` describes fields available to the assistant principal.
`reports.runtime.define` with `phase: 'preview'` compiles and runs a bounded
sample. `phase: 'apply'` requires the preview's exact normalized `specHash`.
Without an in-process confirmation host it returns:

```ts
{ status: 'awaiting_confirmation', specHash, spec, sourceLabel, preview,
  confirmPath: '/api/_reports/runtime/confirm' }
```

Nothing is saved by that response, and model-supplied consent is ignored. The
browser shows the proposal and only a person's approval posts `{ spec, specHash }`
to `createRuntimeReportConfirmHandler()`. The handler checks same origin, the
verified session user and tenant, `runtimereports.create`, the normalized hash,
and compilation under the **confirming** principal's current permissions.
Another principal may approve the same public spec only under their own
permissions and tenant; a hash is data, not a transferable authorization token.

The template mounts `POST /api/_reports/runtime/confirm`. Hosts pass the verified
principal and the request's database (including the RLS transaction), never
body-supplied identity. Success is `201 { id, specHash, title }`; a retry of an
active definition with the same principal/hash returns the same response with
200. Compilation happens again even on retries. Concurrent approvals use core's
transactional `runOnce` claim, keyed by tenant, principal and normalized spec.
A failed write rolls back the claim; an audit
callback failure returns a generic 500 and a retry finds the already saved row.
No result rows are stored in the idempotency record. After archiving, approving
the same definition returns 409 `report_archived`; restore it through the archive
action before retrying.

Errors are JSON `{ code, message }`: 401 without a session; 403 for cross-origin,
missing permission, mismatched ambient tenant, or an active retry invalidated by
current source/field access; 409 for an archived retry; 422 for a malformed new
spec or `spec_hash_mismatch`; generic 500 for unexpected provider failures. There is
no cross-tenant or system bypass. Configure an optional `audit` callback on the
factory to receive confirmed principal/hash/report identity and whether reused.

For CLI and other in-process hosts, `RuntimeReportConfirmationHost.confirmSave()`
remains available: it must resolve only after a person approves that exact hash.
The single-use model proof is unchanged in both paths. The assistant tools use
the persona's fail-closed `allowedTools` gates.

## Server configuration and actions

Configure `packages.reports.runtime.sources` in `smrt.config.ts`:

```ts
packages: {
  reports: { runtime: { sources: [
    { id: 'invoices', className: '@acme/app:Invoice', collection: 'invoices', label: 'Invoices' }
  ] } }
}
```

An absent source list exposes nothing. A source's `collection` is a catalog slug
and requires `<collection>.read`; the server narrows the allow-list before
compiling. Give the assistant the same server-owned source definitions. The
confirm factory can instead take explicit `{ sources, audit? }` options.

`POST /api/runtimereports/:id/run` takes no body and returns
`{ action: 'run', result: RuntimeReportResult }`. Its CLI/MCP counterparts call
the same model action. It requires `runtimereports.read`, reloads the definition
in the principal's tenant, and recompiles on every call. Tenant peers can run
shared reports; use `createdByUserId` for an Only mine list filter. Missing and
foreign-tenant ids return 404; revoked source/field access returns 403; archived
reports return 409 `report_archived`; invalid results return 422. Rows stay
ephemeral and integer money stays in minor units.

`POST /api/runtimereports/:id/archive` takes `{ archived: boolean }` and returns
`{ action: 'archive', result: { id, status } }`. It requires
`runtimereports.create`, changes status only, and
repeating the same state does not write again. `operationPermissions` metadata
aliases run to read and archive to create consistently across generated routes,
CLI/MCP guards and the permission catalog. The archive alias adds SELECT and
UPDATE SQL-policy bindings to create: the authorized action must look up the
same-tenant row before changing its status. Adopted PostgreSQL RLS policies must
be regenerated. Neither `.run`, `.archive`, `.update` nor `.delete` becomes a
new grantable permission for this model.

`loadRuntimeReportChart(options, context)` is the server loader for the dependent
browser recipe widget. Options are `{ reportId, measure, dimension? }`; the host
supplies `context.reportPrincipal` from its authenticated request and optionally
`currency`. It runs afresh as the viewer and returns structural chart data:
`{ points: [{label, value}], format, currency?, href }`. The loader has no
smrt-svelte dependency and receives no authority from widget options.

## Recipe UI

`reports.runtime` declares the RuntimeReport model, Reports navigation, the
`/reports` routes and `runtime-report-chart` widget. The widget options are only
`{ reportId, measure, dimension? }`; the authenticated server host supplies the
loader's `reportPrincipal`. Static hosts render the Reports route unavailable.
Rename, scheduling and manual report construction remain deferred.
