# smrt-core/schema paths

Module semantics for `src/schema/` — which `SchemaGenerator` entry point reaches
a real database, what each one emits, and the rules that keep them in step.
Package orientation, the cross-module invariants, and the traps that apply
before editing anything live in [../AGENTS.md](../AGENTS.md) — read that first;
it links the relevant runtime and generation contracts.

## Four entry points, two of which ship

`src/schema/generator.ts` exposes four index-emitting entry points. Their columns and indexes must agree for the same class.

| Entry point | Selected by | Status |
|---|---|---|
| `generateSTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateCTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateSTISchemaFromRegistry` | `src/testing/database.ts` (`getTestDatabase()`), `src/schema/utils.ts` (`generateSchema`; `ensureSchema` only as a fallback) | tests + runtime helpers |
| `generateSchemaFromRegistry` | the same two callers | tests + runtime helpers |

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

Since #2359 the two families share one set of index helpers and
`src/schema/schema-path-parity.test.ts` runs the same fixture manifest through
the manifest paths, through `ObjectRegistry.registerFromManifest()` + the
registry paths, and through `getAllSchemasAsDefinitions()`, asserting identical
column and index sets. Extend that fixture with every generator change; a
divergence is a bug in the generator, not an exception to add to the test.

### Index rules (#2359)

- **Reference columns are always indexed.** `ensureReferenceColumnIndexes()`
  runs last on every path and gives each `@foreignKey`, `@crossPackageRef` and
  tenant column `<table>_<column>_idx` unless an UNQUALIFIED index (no `WHERE`,
  no JSON path) already leads with it — the `conflictColumns` unique index or an
  `indexed: true` opt-in, or the column's own inline UNIQUE. A partial
  `WHERE _meta_type = …` index does not count: base-class polymorphic queries
  carry no discriminator predicate. `indexed: true` on a reference column is
  redundant. Roll the index wave out to production with
  `smrt db:migrate --postgres-safe` (concurrent-index mode, #2362): a plain
  atomic batch takes SHARE/ACCESS EXCLUSIVE locks for ~230 index builds. STI FK indexes are plain, one per
  column, not per-class partial.
- **No index on the primary key.** `<table>_id_idx` is gone from every path,
  and `conflictColumns` equal to the PK column set emit no conflict index
  (`ON CONFLICT (id)` binds to the PK constraint). `SchemaComparer` drops the
  legacy non-unique single-column PK index from existing databases without
  `--drop-indexes` when the live table reports that column as its sole primary
  key (never a UNIQUE one — on PostgreSQL that may back a custom-named PRIMARY
  KEY constraint, and `DROP INDEX` on it would fail the atomic batch).
- **Slug loading keeps its index.** Custom `conflictColumns` replace the
  `(slug, context)` unique index; `loadFromSlug()`/`getId()`/`getSavedId()`
  still filter on slug/context, so a plain `<table>_slug_context_idx` is kept
  (additive; routing those lookups through the conflict key would change which
  row a slug resolves to). The tenant-led default key below counts as serving
  it (`servesSlugLookup()`): a tenant-scoped slug lookup carries the tenant
  predicate (#2365) and is served by the prefix, so no second index.
- **Tenant default keys** are `(tenant_id, slug, context)`, plus `_meta_type`
  for STI. `ManifestGenerator.normalizeConflictColumns()` and
  `ObjectRegistry.getConflictColumns()` share `src/schema/conflict-target.ts`:
  resolve tenant fields through the schema owner/STI root, report group/bucket
  columns through the report, and custom PKs through their key. Explicit
  `conflictColumns` remain unchanged. The manifest, schema, knowledge, and
  runtime must carry the same value.
  Names remain `<table>_slug_context_idx` / `_slug_context_meta_type_idx`, so
  migration replaces a same-name global unique with tenant-led columns. That
  prefix serves tenant and tenant-scoped slug reads; a legacy standalone tenant
  index is dropped only with `--drop-indexes`.
- **Optional NULL tenants** dedup through SDK null-aware upsert (PostgreSQL
  `IS NOT DISTINCT FROM` plus advisory lock; SQLite process lock), not the
  unique index: raw SQL can duplicate NULL-tenant keys. Raw global inserts need
  `WHERE NOT EXISTS` and a PostgreSQL advisory lock; an old global `ON CONFLICT`
  target no longer binds. Save serializes an unset tenant explicitly as NULL,
  because every conflict column must be present. PostgreSQL `NULLS NOT DISTINCT`
  remains a potential follow-up, not current enforcement.
- **Tenant-key rollout requires a maintenance window.** Old code/new indexes
  and new code/old indexes both fail new-object saves because conflict column
  sets must match exactly; persisted ID-based saves still work. Backfill legacy
  NULL tenants first or scoped ingestion creates separate rows and cannot see
  the old global ones. Cross-tenant natural-key dedup now creates one row per
  tenant. Deploy code and migrate together in atomic mode: each table drops
  and recreates its same-name unique index, holding ACCESS EXCLUSIVE locks
  (including against reads) until commit. Size `statementTimeout` for the
  largest table. A valid old subset unique guarantees the superset build;
  missing/nonunique old indexes may contain duplicates and need dedup first.
  Include the reference-index wave in that atomic window. `--postgres-safe` is
  suitable for an additive reference-index-only wave, but a key replacement
  leaves a per-table gap between drop/build and a failed build leaves no arbiter
  until rerun. There is no automatic DOWN; reverting code requires deliberately
  recreating its old indexes.

- **STI `@field({ unique: true })` is enforced through indexes** (the differ can
  add an index to an existing table, never a column constraint): a full
  `<table>_<col>_unique_idx` when the STI base declares it, one
  `<table>_<col>_<class>_unique_idx WHERE _meta_type = '<qualified>'` per class
  when only descendants do — uniqueness per concrete class, not across the
  subtree. DuckDB/JSON have no partial indexes, so the descendant-scoped shape
  (`isStiSubtypeUniqueIndex`) is not emitted there — degrading it to a full
  UNIQUE would constrain every subtype; the DDL strategy and the differ both
  skip it, while other partial indexes keep degrading to full ones as before. Remember the
  framework serializes an unset text field as `''`, so a unique optional text
  field must be `nullable: true` with a `null` initializer or every unset row
  collides.
- **Every class in an STI hierarchy carries the schema of the one shared
  table**, generated from the root base (`ManifestGenerator.generateSchemas()`
  resolves the root through `findSTIBaseInfo`), so a child never treats its own
  descendant-only unique field as base-declared.

`src/schema/utils.ts` sits in between, and the two exports differ:

- `generateSchema()` (reached from `SmrtCollection.generateSchema()`) always
  rebuilds from the registry and writes the result back into the registry,
  replacing whatever the manifest registered for that class.
- `ensureSchema()` (reached from the deprecated `smrt db:setup`) is
  manifest-first: it takes `ObjectRegistry.getSchema()` plus the merged
  `getAllSchemasAsDefinitions()` table definition, and only falls back to
  `generateSchema()` when no schema is registered at all.

## Verification

Extend `src/schema/schema-path-parity.test.ts` for every generator change;
manifest, registry, and merged migration schemas must agree. Inspect regenerated
`dist/manifest.json` and schemas across affected packages, not only decorators.
Runtime `verifyPersistenceTable()` checks table existence only. Database drift
checks compare with generated artifacts; they cannot detect an omission shared
by those artifacts. Use `smrt doctor --db` / `db:status --parity` for live parity.

Every new query predicate needs its index or an explicit reason none is needed.
Run `pnpm --filter @happyvertical/smrt-core test:postgres` for numeric types,
UUID casts, conflict targets, timestamps, or migrations. Schema-affecting options
must reach `SchemaGeneratorConfig` and both config rebuild sites:
`src/schema/utils.ts` and `src/testing/database.ts`.

Tenant uniqueness and conflict targets must include the tenant column; explicit
`conflictColumns` are author-owned and never rewritten. All reads, including
hydration, slug lookup, vector search, and memory, remain interceptor-aware.
Retry only transient errors classified through the cause chain; never retry an
aborted PostgreSQL transaction (`25P02`).

### Composite indexes are declared, not inferred (#2357)

The generated set only covers foreign keys, unique/conflict columns, the STI
discriminator, reference columns (#2359), default list ordering, and single columns opted in with `@field({ indexed: true })`. A list
workload's access path is composite, so declare it:

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

`appendDeclaredIndexes()` runs first on all four entry points, ahead of
`ensureDefaultListOrderingIndex()` (default ordering below) and `ensureReferenceColumnIndexes()`,
so a declared composite leading with the tenant column (or any reference column)
replaces the automatic standalone index rather than duplicating it.
Unknown columns, malformed entries, and a name collision with a different index
all fail generation — a silently dropped index only surfaces later as a
production slowdown. Keep both config rebuild sites aligned.

### Relationship targets resolve to a class name on both paths

`@foreignKey`/`@oneToMany`/`@manyToMany` accept a class, a name string, or a
`() => Target` thunk. The decorator invokes the thunk and throws when the target
cannot be resolved (never `related: ''`); the scanner unwraps the same thunk
from raw source (never `related: '() => Target'`). An unresolved target silently
costs the relationship edge, `loadRelated()`, and the FK-derived index (#2379).
A thunk resolves at decoration time, so a target declared later in the same
module is still in its temporal dead zone — use the string form there.

### A SQLite type change is a table rebuild (#2370)

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
  (comment SQL → `db:migrate` exit 1). The SQLite rebuild consumes
  only `type_upgrade` placeholders today; extending it to rewrite constraints
  would lift this.
- Defaults compare through `canonicalizeDefault()`, which folds engine
  renderings (`'x'::text`, `CAST('t' AS BOOLEAN)`, `CURRENT_TIMESTAMP` vs
  `now()`) by manifest type; an unclassifiable rendering skips the comparison
  rather than risking a false positive that would churn every run. The
  round-trip test (create from each DDL strategy → compare → zero changes) in
  `src/migrations/__tests__/issue-2369-*.test.ts` guards this.

### `schema.ddl` is a preview, not the table

`SchemaDefinition.ddl` / `manifest.json` `schema.ddl` is the engine-neutral
CREATE TABLE string from `SchemaGenerator.generateSQL()` with no engine: no
indexes, no triggers, abstract `REAL`/`JSON`/`UUID`/`TIMESTAMP`. It is kept for
backward compatibility only. Everything that needs an executable table renders
`columns` + `indexes` through `getDDLStrategy(engine)` — `db:migrate`
(`migrations/orchestrate.ts`), `MigrationGenerator` (default
`materializeStructuredSchema: true`; `false` is a deprecated opt-out),
`SchemaAggregator`, and `createIsolatedTestDbFromManifest` in smrt-vitest, the
last two via `src/schema/manifest-schema.ts` (`collectManifestTables` /
`renderCollectedManifestTable`). The cached string is merged in only for a
table whose contributors expose no structured columns (hand-authored
manifests); table constraints that exist only in the string are dropped with a
warning, as `db:migrate` drops them. Do not add a new consumer of the
string, and do not write a private CREATE INDEX renderer — the retired ones
dropped `where` and `jsonPath` (#2358). Every DDL strategy also spells out
`PRIMARY KEY NOT NULL`: SQLite lets a bare non-INTEGER PRIMARY KEY hold NULL.

### The merged table shape is registration-order independent (#2372)

`getAllSchemas()` and `getAllSchemasAsDefinitions()` fold every class that
shares a physical table — the whole STI hierarchy — into one shape. Both route
through `buildMergedTableSchemas()`, which groups contributors by table and
then merges them in a **deterministic** order: the STI base first, then
ancestors before descendants, then by qualified name.

The first contributor supplies fallback columns, `idType`, conflict columns,
cached DDL, and wins column conflicts. Keep base-first ordering even when a
child without manifest schema registers first.

Two invariants keep the two assembly paths agreeing:

- `createBaseColumns()` mirrors what `generateSchemaFromManifest` /
  `generateSTISchemaFromManifest` emit for the same table, so a table built
  from runtime field metadata alone has the same NOT NULL/DEFAULT shape as one
  built from a manifest. Note `_meta_type` is `TEXT NOT NULL` with **no**
  default, matching the generator.
- `fieldsToColumns()` reads `required`, `default`, and `description` from the
  top level *or* `_meta`. Registry fields normalize them into `_meta`
  (`manifest-field-merge.ts`), so reading only the top level silently dropped
  NOT NULL and DEFAULT for every registry-sourced field.

STI columns stay nullable regardless of the field's `required` flag
(`fieldsToColumns(fields, { stiUnionColumns: true })`): the table holds the
union of all subtypes' fields, so a column only one subtype declares is never
populated on a sibling's row. Declared defaults are still emitted. This matches
`generateSTISchemaFromManifest`, which sets `notNull: false` on every non-system
STI column.

When adding a class-level input to the merged shape, take it from the seeding
contributor rather than "whichever class arrives first", and cover it with a
child-first/base-first equality test.

### Default list ordering indexes

All four generators index `DEFAULT_LIST_ORDER_BY` (`created_at DESC, <pk> ASC`):
`ensureDefaultListOrderingIndex()` emits `(tenant column, created_at)` when
scoped, otherwise `(created_at)`. Resolve tenant columns by `referenceKind ===
'tenantId'`, not spelling. The tenant-leading pair also serves the reference
index requirement.

Only an unqualified, non-JSON-path index with the same leading columns suppresses
it. Append declared composites first, then default ordering, then reference
indexes. `(tenant_id, created_at, status)` replaces the default pair;
`(tenant_id, publish_date)` does not. Emit one plain index per STI table, since
base polymorphic reads lack `_meta_type` predicates.

Do not add direction or PK columns by inference: `IndexDefinition` has no
per-column directions, backward B-tree scans serve descending timestamps, and
the mixed-direction PK tie-break still needs incremental sorting within equal
timestamps.

### One conflict-target rule, applied on every producer

`save()` upserts on `ObjectRegistry.getConflictColumns()`; the schema must
carry exactly one unique index over those columns (or they must be the
primary key). Keep the derivation in `src/schema/conflict-target.ts` and let
every producer call it — the three manifest pipelines share
`ManifestGenerator.applyGenerationPasses()` since #2360 because
`ManifestBuilder` had silently skipped the report passes for months. When you
add a way for the key to vary (a new decorator option, a new class kind),
thread it through `getConflictColumns()`, `normalizeConflictColumns()` and the
generator's `resolveConflictTarget()` together, and extend the parity test's
"unique index == conflict target" assertion; a key the runtime uses and the
schema does not index is a hard PostgreSQL error (42P10) on the first save,
and a key the schema indexes without the tenant column is the silent
cross-tenant overwrite this rule exists for.

### Every generated index name is length-guarded before it leaves a path (#2374)

PostgreSQL truncates identifiers beyond 63 bytes; two generated names sharing
that prefix can make `CREATE INDEX IF NOT EXISTS` silently skip an index.

`schema/index-utils.ts` owns the guard, and it splits by who owns the name:

- **Generated index, trigger and PL/pgSQL function names** →
  `shortenIdentifier()`. Deterministic `<head>_<digest><suffix>`, digest taken
  over the **full** original so a shared prefix still yields distinct names, and
  a recognised suffix (`_idx`, `_unique_idx`, `_key`, `_pkey`) preserved.
- **Hand-declared `@smrt({ indexes: [{ name }] })`** → `assertIdentifierFits()`,
  a hard error in `validateDeclaredIndex()`. Renaming what a developer wrote is
  worse than refusing it, and `SchemaComparer` matches indexes **by name**
  first, so a 70-byte declaration could never match the 63-byte index
  PostgreSQL stored and `db:migrate` would emit `add_index` forever.
- **Table and column names** are not guarded: PostgreSQL truncates their
  declarations and references consistently. `smrt-users` tests intentionally
  long table names; collision risk remains with the author.

`enforceIdentifierLimits()` is the single call site per path, placed **after**
`ensureReferenceColumnIndexes()` — nothing may lengthen a name after it. Doing
the shortening at the end rather than at each `indexes.push()` is safe because
the digest covers the whole original name, so entries distinct before shortening
stay distinct after; the helper still throws if two ever collide. The migrate
leg's `withConflictIndex()` (`registry/schema-builder.ts`) and the PostgreSQL
trigger-function name call `shortenIdentifier()` directly, because they compose
a name outside the generator's index list. Note that an over-long *table* name
still yields in-limit, distinct *index* names, because the shortening runs over
the whole composed name.

The digest is FNV-1a, not `node:crypto`: `index-utils.ts` is re-exported from
`schema/utils.ts`, which exists to keep Node built-ins out of browser bundles.
It only has to be *stable* — a shortened name that changed between releases
would make every deployment drop and recreate the index — so the parity and
unit tests pin the literal output rather than recomputing it. Unpaired
surrogates are folded to U+FFFD before both counting and hashing, so the digest
is taken over exactly the bytes the driver transmits.

Existing databases migrate **by name swap, without a rebuild**: the live index
still carries the name PostgreSQL truncated it to, the manifest now carries the
shortened one, and the differ claims it by signature (columns + uniqueness +
predicate), emitting nothing — including under `includeDroppedIndexes`. See
`migrations/__tests__/index-drift.test.ts` and the PostgreSQL lane test
`schema/issue-2374-identifier-length-postgres.optional.test.ts`.

Out of scope, deliberately: constraint names PostgreSQL invents for itself. A
CTI table's inline `UNIQUE` produces an implicit `<table>_<column>_key`, which
can exceed 63 bytes even when the table and column each fit. SMRT never names
it, and PostgreSQL disambiguates its own truncations by appending a counter
rather than collapsing them, so there is no silent-collision hazard there.

### The `_smrt_` prefix does not mean "system table" (#2376)

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

## Same-package referential integrity uses two matching rails

`@foreignKey(Target)` emits a physical database constraint when the target is
in the same package and applies the same action through `SmrtObject.delete()`
in `src/cascade.ts`. A shared delete-action resolver keeps both paths aligned;
the established generated `ON UPDATE CASCADE` default remains unchanged:

| Reference | Default when `onDelete` is absent |
|---|---|
| Column is part of the referencing class's `conflictColumns`, and is not a `@tenantId()` field | `CASCADE` |
| Polymorphic `(metaType, metaId)` association row | `CASCADE` |
| Ordinary same-package reference | `NO ACTION` — deletion is refused while references remain |
| Every `@tenantId()` field | Excluded from physical constraints and delete cascades |

The natural-key rule is what cleans junction rows up without any per-package
annotation: a junction declares
`@smrt({ conflictColumns: ['content_id', 'asset_id', 'relationship'] })`, so the
row is *identified* by the content and cannot outlive it. An ordinary child
(`Order.customerId`) is keyed by `(slug, context)` and therefore defaults to
immediate `NO ACTION` unless it opts in explicitly.

**`@tenantId()` is excluded even though it lands in `conflictColumns`.**
#2360 leads every tenant-scoped class's *default* natural key with the
tenant column, so without this exclusion, deleting one `Tenant` row would
recursively CASCADE through every tenant-scoped table in the schema that has
not declared its own `conflictColumns` — the overwhelming majority. The
tenant column scopes ownership; it does not identify the row the way a
junction's foreign key does. Detected via the `__tenancy.isTenantIdField`
marker on `FieldMeta` (`smrt-core` reads it structurally so it never depends
on `smrt-tenancy`). `@tenantId()` exposes no `onDelete` option today, so
this cannot currently be overridden per field.

`@crossPackageRef()` remains runtime-only: it registers relationship loading
and indexes but deliberately emits no physical constraint, avoiding circular
package DDL. Tenant markers follow the same non-constraint rule because a
tenant is a scope, not an ownership edge.

Same-package archival identifiers may explicitly use `@foreignKey(Target, {
constraint: false })`: preserve relationship loading and indexing, but omit
physical constraints, schema dependencies, and application cascade/preflight
so the identifier survives parent deletion. Document the retention reason at
the field; ordinary references remain constrained.

For a same-package relationship whose semantics are portable but whose physical
constraint shape is not, `@foreignKey(Target, { constraint: { engines: [...] } })`
is the public exception. The allowlist scopes physical DDL and dependency
planning only. Relationship metadata, UUID representation, derived indexes, and
the application delete rail remain canonical on every engine. Empty or unknown
engine lists fail closed; unannotated unsupported DuckDB cycles and actions keep
their actionable refusal.

Every schema creation entry point uses the same deterministic dependency
planner. Parents are created before children. SQLite keeps cycle constraints
inline because it can create them safely. PostgreSQL creates mutually dependent
tables first and adds their named constraints afterward. DuckDB refuses cycles,
self-references, `CASCADE`, and `SET NULL` with an actionable error because its
current ALTER/constraint support cannot enforce those shapes safely.

Rollback drops children before parents, removes deferred PostgreSQL cycle
constraints first, and defers SQLite checks while dropping populated cycles.
Aggregation that filters a parent also removes a retained child's physical FK.
PostgreSQL deferred constraint adds are idempotent. Generated `ON UPDATE
CASCADE` remains the default; DuckDB/JSON must refuse unsupported actions
rather than silently stripping them.

For existing tables, PostgreSQL checks the exact child table/column against the
exact referenced table/column before adding a constraint as `NOT VALID` and
then validating it. The probe uses distinct child/parent aliases and, when both
manifest columns are UUIDs, bases its guarded casts on both live column types:
matching live types compare directly, while a legacy text side is shape-checked
before casting. This keeps a self-reference or malformed legacy value from
invalidating the query. An orphan stops migration with detector SQL and an
executable repair suggestion: nullable FKs are cleared, while required FKs
require an explicit operator decision to reassign the reference or deliberately
remove a child row after preserving its required data. A probe failure is
surfaced as a database/framework error, never misreported as orphan data.
SQLite requires a deliberate table rebuild; DuckDB reports the unsupported ALTER
path. Neither engine treats an unsupported constraint addition as a successful
no-op.

### Pre-R11 `text` ids converge to `uuid` before any FK statement (#2608)

PostgreSQL FK columns must have matching physical types. Legacy text IDs may
meet newer native UUID references; neither SQLite (text UUID by design) nor
DuckDB (no in-place type rewrite) emits this convergence.

**The runtime guard fails closed.** `SchemaManager.ensurePostgresForeignKey()`
reads both live column types and refuses to emit `ADD CONSTRAINT` when they
disagree, naming both columns, both live types, and the repair. It deliberately
skips the orphan probe in that case: across mismatched types the probe answers
a question about casted values, not about the constraint being refused, and it
has to run again after the columns converge anyway.

**The differ converges the columns.** `planUuidConvergence()`
(`src/schema/uuid-convergence.ts`) groups every manifest relationship that
declares UUID on both sides into connected components and converges a component
only when the live database already proves the target shape — at least one
member is native `uuid`. A component that is `text` on *every* side is the
tolerated pre-R11 deployment and is left alone; its foreign keys are
type-compatible today, and the R11 uuid/text equivalence in
`migrations/differ.ts` keeps it out of the column diff.

Converge entire relationship components, including siblings and self-references;
an unreferenced legacy text ID retains its UUID/text equivalence tolerance.

The planner never coerces data. Before emitting anything it probes each column
it would rewrite for values that are not uuid-shaped (the same `~*` canonical
pattern the orphan probe uses) and refuses the whole component — with the count
and a sample value — if any exist, if the probe cannot run, if a member carries
some third physical type, or if a live foreign key still constrains a column
that must change. `@happyvertical/sql` introspection does not expose live
PostgreSQL constraint names, so SMRT cannot drop and re-add those constraints
for you: drop them deliberately, rerun the migration to converge, and let SMRT
re-add the manifest constraints.

Refusals are reported, not silent. Each one becomes a warning advisory with no
executable SQL, so it reaches `unactionableChanges` / `hasManualDrift` and
`db:status` shows **blocked: incompatible column types** instead of *pending*.
The same check runs per relationship in `compareForeignKeys`, so a foreign key
whose live types will still disagree after this run's conversions is reported
blocked rather than emitted as pending DDL that cannot succeed.

The planner also inspects tables the manifest no longer declares. A live
foreign key from an orphan table onto a column that must convert still blocks
`ALTER COLUMN … TYPE`, so the differ introspects every existing table — not
only the manifest ones — whenever there is at least one conversion candidate,
and reports the dependency instead of emitting DDL PostgreSQL would reject. An
already-converged database has no candidates and pays nothing.

Ordering is a contract. Conversions carry `SchemaChange.phase =
'pre_foreign_key'`, and the orchestrator emits them **before every CREATE TABLE
and every foreign-key statement in the batch**. Both halves matter:
`planForeignKeyCreation()` only defers the constraints inside a mutual cycle,
so an acyclic new child table keeps its foreign key *inline in `CREATE TABLE`*
— a brand-new `uuid` child pointing at a legacy `text` parent fails exactly
like an existing one, before the parent could be converted. Conversions only
ever rewrite columns that already exist, so leading the batch is always safe. A
live `DEFAULT` on a converting column is dropped first (PostgreSQL refuses
`ALTER COLUMN … TYPE` when the default cannot be cast); the ordinary default
comparison re-establishes the manifest default on the next run.

There are **two** batch builders and both order on that marker:
`collectStatementsFromDiff()` in `migrations/orchestrate.ts` (used by
`getPendingSchemaStatements` / `migrateSmrtSchemas`) and the tracker batch
`db:migrate` assembles by hand in `@happyvertical/smrt-cli`
(`commands/utilities.ts`). `partitionSchemaChanges()` carries
`SchemaChange.phase` onto `MigrationAction.phase` so the CLI can partition the
same way, in both the applied batch and the `--dry-run` preview. If you add a
third consumer, order it the same way.

Convergence entries carry the manifest column definition. Every `type_upgrade`
consumer reads `SchemaChange.column` — `partitionSchemaChanges()` in
`@happyvertical/smrt-cli` skips an entry without one — so a conversion missing
it would drop out of the `db:migrate` batch while `compareForeignKeys()` still
assumed the converged type. Refused convergences carry the same column plus an
advisory and no SQL, and the CLI routes them to the report-only advisories
rather than to manual interventions or the tracker.

The uuid wording is gated on the manifest. Both the runtime guard and the
status planner reach their incompatible-type branch for *any* mismatched pair,
not only uuid/text. A `USING …::uuid` repair is suggested only when the
manifest declares UUID on both sides **and** a live side is actually `text`;
otherwise the diagnostic names the two live types and asks the operator to
align them deliberately.

The conversion is one-time and idempotent: once the column is native `uuid`,
the component is uniformly UUID and the planner emits nothing.

### Application cascade invariants (`src/cascade.ts`)

- Rebuild the registry-derived plan on every delete; manifests register lazily.
  Caching requires invalidation across every registration path.
- Plan from `getResolvedQualifiedName()`. Every registered polymorphic
  association class participates, since its runtime target can be any class;
  `CascadePlan.isEmpty` requires no such class anywhere and no typed references.
  Only an empty plan skips the transaction.
- Cascades are set-based: child hooks/interceptors and change-feed tombstones do
  not run. Only the explicitly deleted object runs its lifecycle. RESTRICT
  checks precede mutations; the parent DELETE and cascades share one transaction
  where supported, so deeper refusals roll back.
- Derived `_smrt_embeddings` / `_smrt_contexts` cleanup matches IDs AND
  `ownerClassCandidates()` (qualified and simple STI member names), never IDs
  alone: unrelated text-ID classes can collide. Cleanup failures are logged,
  not raised, because these tables may not exist in older databases.
- Never cascade append-only `_smrt_changes`, `_smrt_ai_usage`, `_smrt_signals`,
  or dispatch logs; deleting change tombstones would break sync.

### Retention (`src/system/retention.ts`)

`runRetentionSweep(db, policy)` runs four built-ins in fixed order, then
`registerRetentionTask()` contributions. A failed task records its result and
continues; a missing table is `unavailable`. The `globalThis` registry avoids
split registrations under duplicate core resolution; package tasks exist only
after importing the package. CLI prune optionally imports jobs/users.

Defaults are opt-out: changes 30 days, AI usage 90 days, completed dispatch 30
days/failed dispatch 90 days, contexts by `expires_at`. `smrt.configure({
retention })` tunes built-ins; contributed tasks own their defaults/options.
Jobs defaults are 7 days terminal, 30 failed, 30 events via
`registerJobRetentionTasks()` or runner `retention.jobs`; expired credentials
have no extra window. Disable a table/task with `false` or the whole policy with
`enabled: false`; CLI `--skip` and runner configuration expose these controls.
Task names use package prefixes (`jobs-records`, `users-sessions`).

Core does not schedule sweeps. TaskRunner runs every six hours, first one
interval after start; `retention: false` opts out. `smrt db:prune` supports cron.
Every prune counts then deletes using the same predicate; `rowCount` is not
portable. The two statements deliberately are not transactional, so counts are
approximate under concurrency. Overlapping change/AI-usage bounds exclude rows
already counted, including dry runs.

Retention indexes belong in system DDL and its versioned replay:
`_smrt_contexts(expires_at)`, `_smrt_ai_usage(tenant_id, created_at)`, and dispatch
`(status, processed_at)` / `(status, updated_at)`. Jobs `(status, completed_at)`
belongs in `ensureJobsSystemTableCompatibility()` on each collection initialize,
since decorated jobs tables do not exist at bootstrap.

Expiry remains prune-side for object/collection `recall()`/`recallAll()`;
`LearningMemory` separately filters it at read time.

## Supported generation surfaces

The four entry points above are the supported generator paths. The unused AST
`generateSchema(objectDef)`, `smrt:schema` / `@happyvertical/smrt-virt-schema`
virtual modules, and project-specific `SchemaOverrideSystem` were removed.

Keep published `SchemaDefinition.triggers`, `TriggerDefinition`, and the DDL
strategies' trigger renderers: they support hand-authored new-table schemas.
Generated `@smrt()` schemas always emit `triggers: []`; no decorator populates
it, `save()` maintains `updated_at`, and the differ never retrofits triggers.
Adding live trigger generation requires a migration rollout design.
`_smrt_signals` and database-persisted registry APIs are retired; see
`RETIRED_SYSTEM_TABLES` in `src/system/schema.ts`.

## PostgreSQL migration execution

`MigrationTracker.applyAll({ atomic: true })` sets local lock/statement timeouts
before any DDL. `postgresSafe: true` commits non-index DDL atomically, then runs
indexes CONCURRENTLY on `db.acquireSession()` so settings and DDL share a
connection. This mode is not atomic. Unfinished indexes are `failed`, not
`running`; `[smrt: concurrent-index phase 1 committed]` in `error_message`
allows reruns to resume index work without replaying committed DDL. Inspect
`pg_index.indisvalid` and drop INVALID indexes before rebuild (`pg_indexes`
alone cannot detect them). Operational commands: `packages/cli/AGENTS.md`.
