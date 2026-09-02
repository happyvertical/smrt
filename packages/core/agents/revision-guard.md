# Revision compare-and-swap guard (`src/revision-guard.ts`)

Every persisted `save()` pins its `UPDATE` to the revision the writer loaded,
and `claimRevision()` does the same without running domain hooks. Zero affected
rows raises `RUNTIME_REVISION_CONFLICT` rather than overwriting a newer row.

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
millisecond before it could slip past.

## Rules

- Never rebuild this predicate by hand; call `postgresRevisionCondition()`.
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
runs the whole battery against both `updated_at` column shapes in the
registered PostgreSQL suite (`pnpm --filter @happyvertical/smrt-core
test:postgres`). `src/__tests__/revision-guard.test.ts` covers the rendering
itself in the default suite.
