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
  row a slug resolves to).
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
