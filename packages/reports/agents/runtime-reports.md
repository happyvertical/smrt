# Runtime reports (#3711)

Reports the assistant (or any caller) defines at runtime from a user request.
A report is a **declarative spec stored as data**; there is no codegen, no new
table per report, and no SQL, expression, join or raw-identifier syntax in the
grammar. Declared (`@report`) reports are unchanged and remain the way to get a
**materialized** report.

## Files

| File | Role |
| --- | --- |
| `src/runtime-spec.ts` | `RuntimeReportSpec` grammar, strict parser, limits, stable hash |
| `src/runtime-compiler.ts` | `compileRuntimeReportSpec()`, `describeRuntimeReportSource()`, `runRuntimeReport()` |
| `src/runtime-report.ts` | `RuntimeReport` model (`runtime_reports`), `saveRuntimeReport()`, list/get/archive, `runStoredRuntimeReport()` |

Assistant tools live in `@happyvertical/smrt-chat` (`createRuntimeReportTools()`,
`src/runtime-report-tools.ts`).

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

## Authority model

A spec carries **no authority**. Everything is decided at compile time from
inputs the caller cannot supply through the spec:

- **Sources.** `RuntimeReportCompileContext.sources` is a server allow-list of
  `{ id, className, collection }`. The spec names an id; unknown and
  not-offered answer identically (`unknown_source`). `authorizeSource` is the
  host's RBAC hook (the chat tools call `run.assertOperation(collection,
  'read')`) and runs before any field is enumerated.
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

## Storage and surface

`RuntimeReport` is `@TenantScoped({ mode: 'required' })` with `spec` (normalized
JSON text), `specHash`, denormalized `title`/`description`/`sourceId`,
`status` (`active|archived`) and `createdByUserId`. `validateBeforeSave()` parses
whatever was written and re-derives every denormalized column, so columns
cannot disagree with the spec. `getSpec()` throws if the JSON no longer matches
`specHash` (out-of-band edit). Generated REST exposes `list`/`get`/`create`
(MCP `list`/`get`); `create` is enabled so the permission catalog and Postgres
RLS bindings know the operation the confirmed save performs. It grants nothing
beyond storing a validated spec. Adopting apps need a `db:migrate` for the new
`runtime_reports` table; runtime never creates schema.

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

## Assistant flow (`@happyvertical/smrt-chat`)

`reports.runtime.sources` (field catalogue for the principal) ->
`reports.runtime.define` `phase: 'preview'` (validate, compile, bounded sample;
nothing stored) -> a human confirms -> `phase: 'apply'` with the previewed
`specHash` -> `reports.runtime.list` / `reports.runtime.run`. `apply` needs an
application-owned `RuntimeReportConfirmationHost.confirmSave()` that resolves
only after a person approved that exact spec; without a host the tools are
propose-only, and a model-supplied `confirmed` flag is ignored. Offer the tools
via the persona conversation `extraTools` seam; they use the same fail-closed
`allowedTools` gates, and `RuntimeReportError.status` (422/403/500) lets
`classifyToolError` return repairable spec problems to the model.

## Not done (needs #3708 or a design call)

- A `reports.runtime` recipe for `RuntimeReport` itself. `reports.materialized`
  (see `AGENTS.md`) covers declared reports only and its help points at the
  `reports.runtime.*` tools; `RuntimeReport` has no recipe of its own yet.
- A browser UI for the confirmation host and for rendering the chart hint.
- Archive/rename tools, scheduling a runtime report, exporting its rows.
