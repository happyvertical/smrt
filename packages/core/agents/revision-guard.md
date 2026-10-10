# Revision compare-and-swap guard (`src/revision-guard.ts`, `src/unchanged-indexed.ts`)

Every persisted `save()` pins its `UPDATE` to the revision the writer loaded;
`claimRevision()` does the same without running domain hooks, and
`delete({ expectedUpdatedAt })` binds the same predicate into its final
`DELETE`. Zero affected rows raises `RUNTIME_REVISION_CONFLICT` rather than
overwriting or removing a newer row.

## Why the predicate is not an equality (#2620)

The guard used to compare `updated_at` to `loadedRevision.toISOString()`. On
PostgreSQL a JavaScript `Date` is two lossy conversions away from the stored
value, so that predicate matched no row at all in two common situations — and
the object then conflicted on *every* later save, permanently, rather than
losing a race:

- **Precision.** `updated_at` is a microsecond column. Any row last written by
  raw SQL — `updated_at = CURRENT_TIMESTAMP` / `now()`, including SMRT's own
  migration backfills — carries a sub-millisecond tail a `Date` cannot hold.
- **Process timezone.** Schemas created before the `TIMESTAMPTZ` mapping still
  hold `updated_at` as `timestamp WITHOUT time zone`, and `pg` hydrates that
  type in the process zone, so on a non-UTC host `toISOString()` renders a wall
  clock the row never held. The same columns are written under three different
  conventions — `pg` serializes a bound `Date` in the process zone,
  `claimRevision()` writes a UTC ISO string, and raw `CURRENT_TIMESTAMP` writes
  in the *server* zone — so no single rendering can match every row.

## What the predicate does instead

`postgresRevisionCondition()` builds
`date_trunc('milliseconds', updated_at) IN (…)` over both wall-clock renderings
of the revision, the process-zone one and the UTC one, each tagged `+00` so a
`timestamptz` comparison honours it and a `timestamp` comparison discards it —
the predicate therefore does not depend on the *session* TimeZone either. On a
UTC process the two renderings coincide and the condition is single-valued.

Lost-race semantics are preserved: a concurrent writer advances `updated_at` to
roughly "now", so it must land on the loaded revision — or, on a non-UTC
process only, on that revision shifted by the whole UTC offset — to the
millisecond before it could slip past. Collapsing that second rendering so the
predicate is single-valued on every process is tracked as #2623.

## Rules

- Never rebuild this predicate by hand; call `postgresRevisionCondition()`.
  Every guarded write — `save()`, `claimRevision()`, and the guarded `DELETE` —
  goes through `SmrtObject.revisionPredicate()` so no path is left on the exact
  equality.
- The condition is PostgreSQL-only. Embedded engines take the process-local
  compare/upsert fallback (`usesEmbeddedRevisionFallback`), and remote LibSQL
  stores ISO text whose exact equality round-trips losslessly.
- Custom write paths must go through `save()`, `save({ expectedUpdatedAt })`,
  or `claimRevision()` rather than bypassing the CAS ordering contract.
- The driver-layer half — `pg` hydrating and serializing `timestamp` columns in
  the process zone — is tracked as happyvertical/sdk#1223. The guard
  deliberately assumes neither hydration convention, so a UTC-hydration fix
  there cannot break it.

## Coverage

`src/__tests__/issue-2620-revision-guard-precision-postgres.optional.test.ts`
runs the whole battery — guarded save, `save({ expectedUpdatedAt })`,
`claimRevision()`, guarded delete, and their still-conflicts counterparts —
against both `updated_at` column shapes in the registered PostgreSQL suite (`pnpm --filter @happyvertical/smrt-core
test:postgres`). `src/__tests__/revision-guard.test.ts` covers the rendering
itself in the default suite.

## Unchanged indexed columns on referenced DuckDB rows (#3737)

Native DuckDB rewrites a row (delete + insert) when an *indexed* column is
assigned, even to its current value, and a foreign key that still references
the row then rejects the statement. `save()` serializes the whole model, so
toggling one plain field of a referenced parent used to assign `slug`,
`context`, `tenant_id` and `created_at` unchanged and fail. Unchanged indexed
columns are therefore left out of the write:

- **Where.** Only native DuckDB (`isNativeDuckDb()`), and only the three
  existing-row writers: the embedded revision write in `save()`
  (`writeEmbeddedRevisionRow`), a new object's natural-key save that adopts an
  existing row (`writeNaturalKeyUpsert`), and `claimRevision()`, which assigns
  only `updated_at`. SQLite and PostgreSQL keep writing exactly what they
  wrote, because they handle an unchanged key harmlessly.
- **Which columns.** `collectIndexedColumns()`: primary key, `unique`, foreign
  keys, every declared index column (partial and JSON-path included), plus the
  runtime keys `slug`, `context`, `tenant_id`, the conflict columns and the
  ownership columns, for the class and its STI base. Over-inclusive is
  harmless: a column is only skipped when it is also *proven* unchanged. An
  index created outside the registry schema (a hand-written migration) is not
  known and keeps being assigned.
- **Proof of "unchanged".** The stored row is read under the embedded write
  queue after its `updated_at` matched the loaded revision (or, for an adopted
  row, as read for the owner check), through `getCanonicalPersistedRow()` so
  native UUIDs are text. `storedValueEquals()` then compares by column type:
  text exactly, UUIDs case-insensitively, timestamps as instants (a string
  must carry its zone), JSON structurally, booleans and numbers by value;
  `null`/`undefined` match each other, never `''`. Binary values, unzoned
  timestamp strings and anything of a different type are *not* equal. Any
  doubt means "assign it as before". `id` and `updated_at` are always written.
- **How.** The adapter's `upsert` cannot restrict its `DO UPDATE SET`, and its
  generic `update()` neither quotes column names (a column named `order` is a
  syntax error) nor binds dates and structures. So the remaining columns go
  through one id-targeted `UPDATE` that core renders itself
  (`buildDuckDbIdUpdate`): every identifier quoted, values bound as the DuckDB
  `upsert` binds them (`NULL` literals, `''` as `CAST(? AS TEXT)`, ISO dates,
  `CAST(? AS JSON)` text). The revision was already verified in-process, so the
  statement carries no revision predicate. When nothing is provably unchanged
  the plain `upsert` runs as before.
- **A changed indexed column is still assigned** and DuckDB still refuses it
  for a referenced parent (a real key change). Tenant isolation is untouched:
  `beforeSave` interceptors and the natural-key owner check run before the
  write, and a differing `tenant_id` is never "unchanged".

Coverage: `src/__tests__/unchanged-indexed.test.ts` (the pure decisions),
`src/__tests__/issue-3737-unchanged-indexed.optional.test.ts` (SQLite, DuckDB
and, with `SMRT_TEST_POSTGRES_URL`, PostgreSQL against a real referencing
child), and `packages/tenancy/src/__tests__/issue-3737-referenced-parent-duckdb.test.ts`
(the real tenant stack).
