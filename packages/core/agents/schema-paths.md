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

The suite takes the registry route. Before #2359 the registry route emitted
indexes the manifest route did not — per-column foreign-key indexes, and STI
partial FK indexes filtered by `_meta_type` — so tests ran against a richer
schema than any deployment received, the manifest STI path populated a
`fkColumnsByClass` map it never read, and the manifest CTI path had no FK loop
at all. `src/testing/database.ts`'s "same as migrations" comment described an
intent, not the code.

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
- **Tenant-scoped tables key per tenant (#2360).** A tenant-scoped class with
  no explicit `conflictColumns` upserts on, and indexes,
  `(tenant_id, slug, context)` — `(tenant_id, slug, context, _meta_type)` for
  an STI hierarchy — resolved by one rule on both paths:
  `ManifestGenerator.normalizeConflictColumns()` materializes it into
  `decoratorConfig.conflictColumns` for the manifest paths (so the manifest,
  the schema, `smrt-knowledge.json` and the runtime read one value), and
  `ObjectRegistry.getConflictColumns()` derives the same value at runtime from
  the schema owner's `tenantScoped` config (`ObjectRegistry.getTenantColumn()`;
  an STI child resolves through its root; a `@report` class through its
  group/bucket columns; a custom primary key through that key). Explicit
  `conflictColumns` are never rewritten. `src/schema/conflict-target.ts` holds
  the shared helpers. Consequences: the index NAME stays
  `<table>_slug_context_idx` / `_slug_context_meta_type_idx`, so the differ
  swaps the columns of an existing global unique in place by name (a superset
  key — creating it cannot fail on existing rows); the tenant-led key also
  serves the tenant column, so `<table>_tenant_id_idx` is no longer emitted
  for those tables (an existing one is an orphan the differ drops only with
  `--drop-indexes`); NULL-tenant rows (`mode: 'optional'` outside a tenant
  context) dedup among themselves through the SDK's null-aware upsert
  (`IS NOT DISTINCT FROM` under a PostgreSQL advisory lock / an in-process
  lock on SQLite) — application-enforced now, where the old global index was
  database-enforced: the tenant-led index treats NULLs as distinct, so raw SQL
  can insert two global rows with one slug, and a raw
  `ON CONFLICT (slug, context…)` against such a table no longer binds (use
  `WHERE NOT EXISTS`, plus an advisory lock on PostgreSQL). Emitting
  `NULLS NOT DISTINCT` on PostgreSQL ≥ 15 (the SDK already detects it) would
  restore the database arbiter — a follow-up. The `save()` path serializes an
  unset tenant field as an explicit `NULL` whatever its registered type,
  because the SDK rejects an upsert whose conflict column is missing from the
  row.
- **Rolling the tenant-led key out (#2360).** There is no mixed-version state:
  new code against the old index fails every NEW-object create on a
  tenant-scoped default-key table (PostgreSQL 42P10, SQLite "ON CONFLICT
  clause does not match…"), and old code against the new index fails the same
  way, because the conflict target must match the unique index's column set
  exactly; only persisted objects (upsert on `id`) keep saving. Deploy the code
  and run `smrt db:migrate` in the same maintenance step. The plan is one
  `DROP INDEX` + `CREATE UNIQUE INDEX` per table under the SAME name (a
  superset key, so the build cannot fail when the old same-name index was a
  valid UNIQUE over the subset key; a #1165-class table whose old index was
  non-unique or missing may hold duplicates that a superset UNIQUE rejects —
  `db:diff` shows which tables' old index is non-unique or missing; dedupe
  those rows before migrating). Atomic mode swaps every table in one
  transaction: `DROP INDEX` takes ACCESS EXCLUSIVE and holds it until commit,
  which blocks ALL access to those tables — reads included — for the batch;
  size `statementTimeout` for the largest tenant-scoped table. That is the
  maintenance window this rollout requires anyway (no mixed-version state), so
  run this wave — the #2359 index wave included — in atomic mode inside it;
  the "roll out with `--postgres-safe`" advice above applies to a #2359-only
  wave, because `--postgres-safe` runs the two statements sequentially per
  table, so each table has NO conflict index between them and a failed rebuild
  leaves it without one until the re-run. The recreate has no automatic
  DOWN: reverting the code means re-creating the old index by hand. And
  legacy NULL-tenant rows fork rather than get adopted — a tenant-context save
  whose slug matches a `(NULL, slug, ctx)` row now inserts `(tenant, slug,
  ctx)` beside it, and that tenant no longer sees the legacy row — so backfill
  `tenant_id` (anytown: `SET tenant_id = context::uuid`) BEFORE this release.
  Ingestion that relied on natural-key dedup across tenants now inserts one
  row per tenant (release note).
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
proven by the path-parity test (`src/schema/schema-path-parity.test.ts`, #2359)
— extend its fixture; a green suite otherwise proves the registry paths only.
Read the call graph before believing a comment: "same as migrations" was wrong
for years.

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
automatically the index a read path uses. Custom `conflictColumns` used to
replace the `(slug, context)` index while `loadFromSlug`/`getId` still queried
slug+context, and STI dropped `@field({ unique: true })` — both fixed in #2359,
see "Index rules" above. Check the pair, not the declaration.

### 6. Multi-tenancy is a whole-path property

Every unique constraint and every conflict target on a tenant-scoped table
includes the tenant column — otherwise a second tenant's `save()` of the same
natural key updates the first tenant's row through `DO UPDATE SET` (#2360; the
default key now does, see "Index rules" — an explicit `conflictColumns` that
omits the tenant column is the class author's own key and is not rewritten).
And every read path is interceptor-aware: hydration
(`loadFromId`/`loadFromSlug`), get-by-slug, vector search, and collection
memory, not only `list()` (#2365).

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

The generated set only covers foreign keys, unique/conflict columns, the STI
discriminator, reference columns (#2359), the default list ordering (rule 18
below), and single columns opted in with `@field({ indexed: true })`. A list
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

`appendDeclaredIndexes()` runs first on all five entry points, ahead of
`ensureDefaultListOrderingIndex()` (rule 18) and `ensureReferenceColumnIndexes()`,
so a declared composite leading with the tenant column (or any reference column)
replaces the automatic standalone index rather than duplicating it.
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

### 16. `schema.ddl` is a preview, not the table

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

### 17. The merged table shape is registration-order independent (#2372)

`getAllSchemas()` and `getAllSchemasAsDefinitions()` fold every class that
shares a physical table — the whole STI hierarchy — into one shape. Both route
through `buildMergedTableSchemas()`, which groups contributors by table and
then merges them in a **deterministic** order: the STI base first, then
ancestors before descendants, then by qualified name.

That order matters because the first contributor seeds the table: it supplies
the fallback base columns, the `idType`, the conflict columns and the cached
DDL, and its columns win every merge conflict. When registration order decided
it, an STI child that carries no manifest `schema` — the external- and
consumer-manifest case — seeded the table from bare fallback columns and the
base class's richer ones were skipped when it registered later, yielding
`context TEXT` instead of `context TEXT NOT NULL DEFAULT ''` and timestamps
with no NOT NULL/DEFAULT. The shipped content manifest lists `Article` before
`Content`, so the losing order was the one that shipped, and the differ
compares types only, so the weak fresh-create was never repaired.

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

### 18. The generator owns the index for its own default ordering (#2363)

Every generated list surface — REST, MCP, the SvelteKit list route — pages with
`ORDER BY created_at DESC, <pk> ASC` (`DEFAULT_LIST_ORDER_BY`, #2367), and
until #2363 no schema path indexed `created_at` (the dead AST path indexed
`updated_at`), so the framework's own default page was a sequential scan plus a
top-N sort. `ensureDefaultListOrderingIndex()` now runs on all five paths and
emits:

- `(<tenant column>, created_at)` on a tenant-scoped table — the tenancy
  interceptor puts `tenant_id = ?` in front of every list, so the tenant column
  leads and `created_at` orders within it. This composite **replaces** the
  standalone tenant index from #2359: a B-tree serves every prefix of its
  column list, so `ensureDefaultListOrderingIndex()` is called first and
  `ensureReferenceColumnIndexes()` then sees the column as already served. The
  tenant column is found by `referenceKind === 'tenantId'`, never by the
  `tenant_id` spelling — `@smrt({ tenantScoped: { field } })` renames it.
- `(created_at)` otherwise.

Three deliberate omissions, so nobody "fixes" them later:

- **No `DESC`.** `IndexDefinition` carries no per-column direction and
  PostgreSQL scans a B-tree backwards just as cheaply.
- **No primary-key tiebreak column.** The default order mixes directions
  (`created_at DESC, id ASC`), so no single-direction index satisfies the whole
  key; the leading columns already turn a full sort into an index scan plus an
  incremental sort over rows sharing a timestamp.
- **Not scoped per STI subtype.** `(_meta_type, created_at)` would serve a
  child collection's list but not the base class's polymorphic one, which
  carries no discriminator predicate — the same reasoning that keeps STI
  reference indexes plain (#2359). One unqualified index per shared table.

An existing UNQUALIFIED index that already leads with the same columns
suppresses it — a partial or JSON-path index never counts. That is how a
declared `@smrt({ indexes: [...] })` composite (#2357) takes over: declaring
`(tenant_id, created_at, status)` replaces the generated pair, while declaring
a different sort column such as `(tenant_id, publish_date)` sits **beside** it,
because that index cannot order the default page. Declared indexes are appended
before this helper for exactly that reason; anything that appends an index in
future goes in the same slot, ahead of `ensureDefaultListOrderingIndex()` and
`ensureReferenceColumnIndexes()`.

### 19. One conflict-target rule, applied on every producer

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

### 20. Every generated index name is length-guarded before it leaves a path (#2374)

PostgreSQL truncates any identifier past 63 **bytes** and reports nothing;
SQLite and DuckDB do not, so the entire test suite was blind to it. The 66-byte
`content_contribution_revisions_contribution_id_revision_number_idx` shipped
that way — only the differ's signature-equivalence check kept it from emitting
`add_index` on every run. Two names agreeing for 63 bytes is the real hazard:
`CREATE INDEX IF NOT EXISTS` no-ops against the wrong index, and the second
index is never created.

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
- **Table and column names** → deliberately **not** guarded. PostgreSQL
  truncates identifiers *consistently on every reference*: `CREATE TABLE
  "<80 bytes>"` and a later `SELECT ... FROM "<the same 80 bytes>"` both resolve
  to the same stored 63-byte name, so one long name round-trips fine end to end.
  `smrt-users` depends on this — it ships an intentional 80-byte
  `@smrt({ tableName })` (`permission_policy_table_name_that_is_far_too_long…`)
  and derives unique Postgres RLS policy names from it. An earlier revision of
  this rule hard-errored here on the theory that the runtime resolves tables by
  name and would break; that theory is wrong for the reason above, and the error
  broke `packages/users`. The residual collision risk is over a name the
  developer chose, not one the generator manufactured.

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

### 21. The `_smrt_` prefix does not mean "system table" (#2376)

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

## Referential integrity lives in `delete()`, not in the DDL

No schema path emits a `FOREIGN KEY` clause on any engine — grep `schema/ddl/*`,
`schema-manager.ts` and `differ.ts` for `REFERENCES` and you get nothing. That is
a deliberate position, not an oversight: emitting constraints changes delete
semantics for every consumer, requires topological table ordering in both
migrate paths (neither orders today), and needs a plan for the orphans already in
production databases. Emitting them is tracked separately.

What `@foreignKey(..., { onDelete })` therefore means is *application* behaviour,
applied by `SmrtObject.delete()` through `src/cascade.ts` (#2371):

| Reference | Default when `onDelete` is absent |
|---|---|
| Column is part of the referencing class's `conflictColumns` | `CASCADE` |
| Polymorphic `(metaType, metaId)` association row | `CASCADE` |
| Anything else | `NO ACTION` — the row is left alone |

The natural-key rule is what cleans junction rows up without any per-package
annotation: a junction declares
`@smrt({ conflictColumns: ['content_id', 'asset_id', 'relationship'] })`, so the
row is *identified* by the content and cannot outlive it. An ordinary child
(`Order.customerId`) is keyed by `(slug, context)` and keeps its pre-#2371
behaviour unless it opts in explicitly.

Properties to keep if you touch that module:

- **The plan is registry-derived and rebuilt per delete.** Registration is
  incremental — manifests load lazily and tests register classes between cases —
  so a cached plan would silently skip a table that registered later. Cache it
  only behind an invalidation hook that every registration path calls.
- **A class nothing references skips the transaction entirely.**
  `hasIncomingReferences()` is checked first, against the class's
  `getResolvedQualifiedName()` (not the bare constructor name — two packages can
  register the same simple name), so the common case pays no extra round trip
  beyond the two side-table statements.
- **Cascaded rows are removed set-based.** Their `beforeDelete`/`afterDelete`
  hooks and interceptors do not run and no change-feed tombstone is written for
  them, which is exactly what a DB-level `ON DELETE CASCADE` does. Only the
  object `delete()` was called on runs the lifecycle. Do not "improve" this into
  a per-row model delete without deciding what that means for sync consumers.
- **Everything is one transaction where the adapter has one**, including the
  object's own `DELETE`, whenever there is anything to cascade. The `RESTRICT`
  checks run first, before any mutation, so a refusal costs nothing; the
  transaction is what makes a refusal *deeper* in the graph safe.
- **`_smrt_embeddings` and `_smrt_contexts` are matched by id alone.** Their
  class columns store the *runtime* constructor name, which for an STI hierarchy
  is the concrete subclass rather than the class the cascade planned from. A
  failure to clean them is logged, never raised — an application database may
  predate the table, and losing derived rows must not fail a valid delete.

`_smrt_changes`, `_smrt_ai_usage`, `_smrt_signals` and the dispatch tables are
deliberately **not** cascaded. They are append-only logs; the change feed in
particular receives the delete's own tombstone, so cascading it would erase the
record that tells sync clients the row is gone.
