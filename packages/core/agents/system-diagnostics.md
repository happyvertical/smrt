# Runtime System Diagnostics

`SystemDiagnosticsReader` is the shared, adapter-agnostic read surface for
developer/runtime health tooling. It covers migrations, jobs, schedules,
dispatch, recent changes, and the persisted registry without booting an app or
materializing schema.

## Invariants

- Every issued statement is a fixed `SELECT`; the reader never runs DDL,
  migrations, writes, or adapter metadata commands.
- Aggregate totals are computed independently from bounded detail lists. Detail
  limits are clamped to 1–200 and must never change totals.
- Every result identifies a `runtime` / `live-db` observation, engine,
  connection source, timestamp, and trusted scope.
- `global` scope reads only `tenant_id IS NULL`. `tenant` scope includes that
  tenant plus global operational rows, except dispatch subscriptions, which are
  exact-tenant. `system` is an explicit trusted capability for an owning host;
  callers must never derive it from request input.
- Diagnostics project only operational fields. Do not select job arguments or
  results, schedule agent configuration or method arguments, dispatch payloads
  or metadata, or registry field/config/manifest blobs.
- Missing system tables degrade that category to `table-unavailable`; failures
  are returned as stable messages after secret, credential URL, and token
  redaction.

The development MCP is the first adapter. It supplies a trusted scope and owns
connection discovery and cleanup; the core reader does not open, cache, or close
database handles.

## Validation

`src/system-diagnostics.test.ts` uses seeded SQLite and audits every statement
issued by the reader. Keep cross-tenant fixtures, missing-table behavior,
redaction, and the aggregate-vs-detail-limit regression covered when extending
the surface.
