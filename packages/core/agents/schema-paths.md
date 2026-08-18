# smrt-core/schema paths

Module semantics for `src/schema/` — which `SchemaGenerator` entry point reaches
a real database, what each one emits, and the rules that keep them in step.
Package orientation, the cross-module invariants, and the traps that apply
before editing anything live in [../AGENTS.md](../AGENTS.md) — read that first;
its "Schema paths" section is the short form of everything below.

Written from the 2026-08-17 database-layer gap assessment (epic #2382). Symbol
names here are stable; the line numbers the assessment quotes are not, so trust
this call graph and re-grep before citing a location.

## Five entry points, two of which ship

`src/schema/generator.ts` exposes five index-emitting entry points. They do not
produce the same schema for the same class.

| Entry point | Selected by | Status |
|---|---|---|
| `generateSTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateCTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateSTISchemaFromRegistry` | `src/testing/database.ts` (`getTestDatabase()`), `src/schema/utils.ts` (`generateSchema`; `ensureSchema` only as a fallback) | tests + runtime helpers |
| `generateSchemaFromRegistry` | the same two callers | tests + runtime helpers |
| `generateSchema` (AST) | the `smrt:schema` virtual module, which has no consumer | dead (#2380) |

Production DDL takes the manifest route:

```
@smrt() class ─▶ scanner ─▶ manifest.json ─▶ generate{STI,CTI}SchemaFromManifest
              ─▶ registered `schema` ─▶ ObjectRegistry.getAllSchemasAsDefinitions()
                 ├─▶ smrt db:migrate | db:diff | db:status
                 │     (the CLI drives SchemaComparer + MigrationTracker directly)
                 └─▶ migrateSmrtSchemas() / getPendingSchemaStatements()
                       (src/migrations/orchestrate.ts — exported for programmatic
                        use; no in-repo caller outside its own tests)
```

The suite takes the registry route, and the registry route emits indexes the
manifest route does not — per-column foreign-key indexes, and STI partial FK
indexes filtered by `_meta_type`. Tests therefore run against a richer schema
than any deployment receives. `src/testing/database.ts`'s "Generate schema using
SchemaGenerator (same as migrations)" comment describes an intent, not the code.

The manifest STI path even populates a `fkColumnsByClass` map and never reads it
— only its registry counterpart iterates one — and the manifest CTI path has no
FK loop at all. Both manifest paths then skip the explicit
`@foreignKey(X, { indexed: true })` opt-in — the CTI one under a comment claiming
"FK columns and unique columns get their own indexes", which holds on the
registry paths and not on this one.

`src/schema/utils.ts` sits in between, and the two exports differ:

- `generateSchema()` (reached from `SmrtCollection.generateSchema()`) always
  rebuilds from the registry and writes the result back into the registry,
  replacing whatever the manifest registered for that class.
- `ensureSchema()` (reached from the deprecated `smrt db:setup`) is
  manifest-first: it takes `ObjectRegistry.getSchema()` plus the merged
  `getAllSchemasAsDefinitions()` table definition, and only falls back to
  `generateSchema()` when no schema is registered at all.

So a normal build keeps the manifest schema through `db:setup`, and a
registry-derived schema is a dev/test artifact. `smrt-content` shows what one
looks like: `packages/content/src/hooks.server.ts` `bootstrapSchema()` calls
`generateSchema()` for every registered class and then `ensureSchema()` from the
SvelteKit `handle` hook on any `/api/*` request, so that process holds
registry-derived schemas rather than the manifest ones. It reaches only that
package's own `vite dev` app — the library build excludes the file and the
package never exports it — but it is the shape to recognize. Check which route a
process actually took before trusting a reproduction.

## Why the drift stayed invisible

Every drift oracle compares a database with the same artifact that dropped the
index:

- `verifyPersistenceTable()` (`src/schema/table-verifier.ts`) calls
  `db.tableExists()` and nothing else. "Runtime verifies schema" has always meant
  existence-only — no column, type, constraint, or index comparison.
- `smrt doctor` never opens a database connection.
- `db:status` and `db:diff` diff the live database against
  `getAllSchemasAsDefinitions()`, i.e. the manifest projection.

An index the manifest never emitted is "in sync" by construction. That is how a
production database reached 164 unindexed `tenant_id` columns while `db:status`
reported no drift (#2356 → #2359). The assessment's other counts — 196/231
`@foreignKey` and 91/92 `@crossPackageRef` columns with no production index,
238/238 tables carrying a redundant index on the primary key, zero DB-level
foreign-key constraints on any engine — come from regenerating every package's
schema against a live database, so re-measure rather than quote them once the
epic's fixes land.

## Rules

### 1. Verify against the production path, not the test path

Any change to column or index emission goes on **all** paths that ship and is
proven by a path-parity test. #2359 adds that test under `src/schema/`; until it
lands, assert the parity yourself in the nearest generator test — a green suite
otherwise proves the registry paths only. Read the call graph before believing a
comment: "same as migrations" was wrong for years.

### 2. Every new query predicate ships with its index

Collection methods, poll loops, auth lookups, junction right-side filters, and
polymorphic owner lookups all count — or write down why the predicate does not
need one. For list workloads, EXPLAIN on a PostgreSQL snapshot; the measured
spread on the assessed workload was 21 ms → 0.1 ms.

### 3. Run the PostgreSQL lane

Anything touching numeric types, uuid casts, upsert conflict targets, timestamps,
or migrations runs the package's `test:postgres` script:

```bash
pnpm --filter @happyvertical/smrt-<pkg> test:postgres
```

core, cli, users, sales, marketing, analytics, and vitest carry the lane.
SQLite's type affinity accepts values PostgreSQL rejects — a money field declared
`number = 0` compiles to INTEGER and only fails on PG (#2361).

### 4. Read the built artifact, not the source

What a decorator produced is in `dist/manifest.json` and in regenerated schemas:
`integer` vs `decimal`, the actual index list, the actual conflict columns. When
the question is "how many tables/columns/indexes", regenerate and count across
every package; do not sample a few and extrapolate.

### 5. Index intent belongs on both the constraint and the read path

A conflict target is not automatically a unique index, and a unique index is not
automatically the index a read path uses. Custom `conflictColumns` replace the
`(slug, context)` index while `loadFromSlug`/`getId` still query slug+context;
STI drops `@field({ unique: true })`. Check the pair, not the declaration.

### 6. Multi-tenancy is a whole-path property

Every unique constraint and every conflict target on a tenant-scoped table
includes the tenant column — otherwise a second tenant's `save()` of the same
natural key updates the first tenant's row through `DO UPDATE SET` (#2360). And
every read path is interceptor-aware: hydration (`loadFromId`/`loadFromSlug`),
get-by-slug, vector search, and collection memory, not only `list()` (#2365).

### 7. Retry only transient errors

Classify through the cause chain (SQLSTATE), never on a message substring, and
never retry inside an aborted PostgreSQL transaction (`25P02`). Test the
contract end to end against a real database, not only the classifier (#2366).

### 8. Thread new decorator options through every config-rebuild site

A new `@smrt()` or `@field()` option that affects schema must reach the
`SchemaGeneratorConfig` type in `src/schema/generator.ts` and every site that
rebuilds that config — `src/schema/utils.ts` and `src/testing/database.ts` — or
it is silently dropped on the paths that rebuild it (#2357).

### 9. Delete or wire dead paths, and write docs to what the code does

Dead code that looks canonical misleads the next agent: the AST `generateSchema`
path, `SchemaOverrideSystem`, and the never-emitted `triggers: []` all read as
supported surfaces (#2380). Documentation follows the implementation, not the
intent — say "verifies the table exists" when that is what runs.

### 10. Untracked "known limitation" comments are bugs nobody will read

File the issue and link it from the comment. A `products` comment explaining why
a conflict-column change was refrained from sat there for months — and
misdescribed the failure mode the whole time.

### 11. Consumer repair scripts are signals

Downstream repair tooling (anytown's `db-repair-plan.ts` carried column-type
repairs, missing STI columns and indexes, and `tenant_id` backfills since April)
is the consumer-side record of framework gaps. Mine it during triage.

### 12. Try to falsify before filing, and treat operations as correctness

Re-verify a finding at source before it becomes an issue — one assessment
candidate claimed conflict indexes past two columns were narrowed to two
columns, when only the index *name* is shortened. And an index fix that ships
without a bounded-timeout, `CONCURRENTLY`-capable migrate path can take
production down on rollout (#2362).

### 13. Composite indexes are declared, not inferred (#2357)

The generated set only covers foreign keys, unique/conflict columns,
`updated_at`, the STI discriminator, `tenant_id`, and single columns opted in
with `@field({ indexed: true })`. A list workload's access path is composite,
so declare it:

```ts
@smrt({
  indexes: [
    { name: 'contents_tenant_id_publish_date_idx',
      columns: ['tenantId', 'publish_date'] },
  ],
})
```

`columns` takes field names or column names in access-path order — filter
columns first, sort column last. Declare columns, not a direction: PostgreSQL
scans a btree either way, so an ascending index also serves the matching
`ORDER BY ... DESC` as an ordered scan with no Sort node. `unique` and `where`
(partial index) are honoured.

`appendDeclaredIndexes()` runs on all five entry points, before
`ensureTenantIdIndex()`, so a declared composite leading with the tenant column
replaces the automatic standalone `tenant_id` index rather than duplicating it.
Unknown columns, malformed entries, and a name collision with a different index
all fail generation — a silently dropped index only surfaces later as a
production slowdown. Rule 8 above is why this works at runtime at all.

### 14. Relationship targets resolve to a class name on both paths

`@foreignKey`/`@oneToMany`/`@manyToMany` accept a class, a name string, or a
`() => Target` thunk. The decorator invokes the thunk and throws when the target
cannot be resolved (never `related: ''`); the scanner unwraps the same thunk
from raw source (never `related: '() => Target'`). An unresolved target silently
costs the relationship edge, `loadRelated()`, and the FK-derived index (#2379).
A thunk resolves at decoration time, so a target declared later in the same
module is still in its temporal dead zone — use the string form there.

### 15. A SQLite type change is a table rebuild (#2370)

SQLite has no `ALTER TABLE ... ALTER COLUMN ... TYPE`, so
`src/migrations/sqlite-rebuild.ts` answers a `type_upgrade` on SQLite with the
statement list SQLite's own docs prescribe: stage a new table under
`_smrt_rebuild_<table>`, copy, drop, rename, replay the indexes and triggers.
`SchemaComparer.compareTable` swaps that plan in for the differ's
"requires table recreation" placeholder, so `db:migrate` applies it inside the
normal atomic batch instead of exiting 1 forever.

Four properties of that module are load-bearing; keep them if you touch it:

- **The target shape comes from the live `sqlite_master` DDL**, retyping only
  the drifted columns. It is not regenerated from the manifest, so the rebuild
  never becomes an implicit `DROP COLUMN`, and it preserves table constraints,
  `CHECK`s, and `WITHOUT ROWID`/`STRICT`.
- **The rebuild is hoisted ahead of the table's other column changes.** Its
  staging DDL and copy list are captured at diff time, and the differ emits
  changes in manifest field order, so a new field declared above the retyped
  one would otherwise run `ALTER TABLE ... ADD COLUMN` first and have the
  rebuild silently drop it — both statements succeed and the batch commits.
  Rebuild first, then add columns to the rebuilt table.
- **The copy carries no `CAST`.** SQLite applies the destination column's
  affinity on insert — the same conversion a fresh table performs. An explicit
  cast is worse: non-numeric TEXT cast to REAL/INTEGER silently becomes `0`,
  and an ISO timestamp cast to NUMERIC-affinity `DATETIME` becomes its year.
- **It refuses when any table has a foreign key onto the target and
  `PRAGMA foreign_keys` is ON** (the SMRT adapter's default). `DROP TABLE`
  performs an implicit `DELETE FROM` that fires `ON DELETE CASCADE` on
  children, and `defer_foreign_keys` defers constraint *checks*, not FK
  *actions* — verified: the child rows go. The target's own self-reference
  counts, because the staging table copies that clause and becomes a child of
  the table being dropped (verified: a two-row self-referencing table finishes
  the rebuild holding one row). Such a column stays manual drift.
- **`PRAGMA legacy_alter_table` brackets the rename**, because SQLite ≥ 3.25
  re-parses the schema on `ALTER TABLE ... RENAME` and a view still pointing at
  the just-dropped table makes it fail outright. It is restored immediately
  after; a rolled-back batch leaves it set on that connection, which is inert
  here only because nothing else in SMRT renames a table.

All the drifted columns of one table share a single rebuild: the first change
carries the plan and the rest become `no change needed` comments that the CLI
classifies as no-ops.

## What the differ compares (#2369)

`SchemaComparer` (`src/migrations/differ.ts`) compares each manifest column's
type, then — unless the type itself is drifting — its nullability and default,
and always reports what it will not touch:

- **Strengthening** (`SET NOT NULL`, `SET DEFAULT`) is executable on
  PostgreSQL/DuckDB. `SET NOT NULL` is preceded by an `UPDATE … WHERE c IS NULL`
  backfill of the manifest default; without a default the live data is probed
  and, if NULLs exist, the change is reported (comment SQL + `advisory`) instead
  of emitting an ALTER that would abort the atomic batch.
- **Relaxing** (`DROP NOT NULL`, `DROP DEFAULT`) is a report-only advisory until
  the caller passes `relaxColumns` (`db:migrate --relax-columns`). The manifest
  can be under-specified (#2372 registration-order weakness), so a live column
  that is stricter than the manifest is never weakened silently.
- **Orphans** — DB columns absent from the manifest, DB tables no manifest
  declares (`SchemaDiff.orphan_tables`), and unclaimed `*_key` unique constraint
  indexes — are always reported. A NOT NULL orphan without a default is a
  `warning` advisory (every ORM insert fails on it); `includeDroppedColumns`
  (`--drop-columns`) drops it, `relaxColumns` relaxes it. Advisory-only changes
  carry no SQL, never reach the tracker, and do not fail `db:migrate`.
- **ADD COLUMN** is planned per engine: DuckDB rejects every inline constraint
  (add with `DEFAULT`, then `SET NOT NULL`, `CREATE UNIQUE INDEX`); SQLite
  rejects inline `UNIQUE` (separate `CREATE UNIQUE INDEX <table>_<col>_key`, the
  PostgreSQL constraint-index name, so the orphan sweep leaves it alone) and
  `NOT NULL` without a default on a populated table; PostgreSQL keeps constraints
  inline. DuckDB has no `ADD CONSTRAINT`, so the separate index is the only
  way to add uniqueness there; the bundled DuckDB 1.4.x resolves
  `ON CONFLICT (col)` through that index (the old #12684 limitation the DuckDB
  strategy's `requiresInlineUnique()` note describes no longer reproduces —
  the #2369 DuckDB test pins the upsert), older DuckDB builds may not. A required column with no default is enforced only on an empty table;
  on a populated one it is added nullable and the `NOT NULL` is reported as a
  manual follow-up on every engine.
- **SQLite** has no `ALTER COLUMN`: nullability/default alterations are manual
  (comment SQL → `db:migrate` exit 1). The #2370 rebuild (rule 15) consumes
  only `type_upgrade` placeholders today; extending it to rewrite constraints
  would lift this.
- Defaults compare through `canonicalizeDefault()`, which folds engine
  renderings (`'x'::text`, `CAST('t' AS BOOLEAN)`, `CURRENT_TIMESTAMP` vs
  `now()`) by manifest type; an unclassifiable rendering skips the comparison
  rather than risking a false positive that would churn every run. The
  round-trip test (create from each DDL strategy → compare → zero changes) in
  `src/migrations/__tests__/issue-2369-*.test.ts` guards this.

### 16. The `_smrt_` prefix does not mean "system table" (#2376)

`bootstrapSystemTables()` owns nine hand-written tables; ~25 more `_smrt_*`
tables belong to `@smrt()` models and are created by `db:migrate` (feature
flags, prompt overrides, subscription plans, report schedules, field policies,
jobs). Never classify by prefix — use `SYSTEM_TABLE_NAMES`
(`schema/system-table-shapes.ts`, derived from the DDL parse) plus
`FRAMEWORK_OPERATIONAL_TABLES` / `RETIRED_SYSTEM_TABLES` in `system/schema.ts`.
The change-feed writer skipped by prefix, so clients syncing those domain
tables through `_changes` never saw an update.

Editing `ALL_SYSTEM_TABLES` requires bumping `SMRT_SCHEMA_VERSION` *and*
appending to `SMRT_SCHEMA_DDL_CHECKSUMS` — the version gates the DDL replay, so
without a bump no existing database ever applies the change. A new **column**
additionally needs an `addColumnIfMissing()` entry in `system/compatibility.ts`
(`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table).
`system-schema-evolution.test.ts` enforces both, and asserts a legacy database
upgrades to exactly the shape a fresh install gets.

`_smrt_jobs` / `_smrt_job_events` are dual-owned: `db:migrate` creates them,
the compatibility pass reshapes them. On a fresh install bootstrap runs first,
so their pass is deferred — `ensureDeferredSystemTableCompatibility()` re-runs
until the tables exist, then stamps a `<version>+deferred-compat` marker. It
runs OUTSIDE the bootstrap lock and swallows its own failures: those statements
target tables the framework does not own, and inside the PostgreSQL transaction
one failure would roll back system-table creation with it. Only
`ensureBootstrapSystemTableCompatibility()` (the tables the DDL itself creates)
belongs inside the lock.

Reconciling `_smrt_jobs.task_id` uniqueness reads the live index catalog, which
is implemented for PostgreSQL and SQLite only; DuckDB and the JSON adapter keep
the redundant compat index rather than risk dropping the one that enforces the
upsert conflict target. When reading a PostgreSQL catalog array, cast it
(`attname::text`) and parse both shapes — a driver with no parser registered for
the array OID returns the raw `{a,b}` literal, and reading that as "no columns"
silently inverts an index-existence decision.
