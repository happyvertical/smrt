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
| `generateSTISchemaFromManifest` | `scanner/manifest-generator.ts` | **production** |
| `generateCTISchemaFromManifest` | `scanner/manifest-generator.ts` | **production** |
| `generateSTISchemaFromRegistry` | `testing/database.ts` (`getTestDatabase()`), `schema/utils.ts` (`generateSchema`; `ensureSchema` only as a fallback) | tests + runtime helpers |
| `generateSchemaFromRegistry` | the same two callers | tests + runtime helpers |
| `generateSchema` (AST) | the `smrt:schema` virtual module, which has no consumer | dead (#2380) |

Production DDL takes the manifest route:

```
@smrt() class ─▶ scanner ─▶ manifest.json ─▶ generate{STI,CTI}SchemaFromManifest
              ─▶ registered `schema` ─▶ ObjectRegistry.getAllSchemasAsDefinitions()
                 ├─▶ smrt db:migrate | db:diff | db:status
                 │     (the CLI drives SchemaComparer + MigrationTracker directly)
                 └─▶ migrateSmrtSchemas() / getPendingSchemaStatements()
                       (migrations/orchestrate.ts — exported for programmatic use;
                        no in-repo caller outside its own tests)
```

The suite takes the registry route, and the registry route emits indexes the
manifest route does not — per-column foreign-key indexes, and STI partial FK
indexes filtered by `_meta_type`. Tests therefore run against a richer schema
than any deployment receives. `testing/database.ts`'s "Generate schema using
SchemaGenerator (same as migrations)" comment describes an intent, not the code.

The manifest STI path even populates a `fkColumnsByClass` map and never reads it
— only its registry counterpart iterates one — and the manifest CTI path has no
FK loop at all. Both manifest paths then skip the explicit
`@foreignKey(X, { indexed: true })` opt-in — the CTI one under a comment claiming
"FK columns and unique columns get their own indexes", which holds on the
registry paths and not on this one.

`schema/utils.ts` sits in between, and the two exports differ:

- `generateSchema()` (reached from `SmrtCollection.generateSchema()`) always
  rebuilds from the registry and writes the result back into the registry,
  replacing whatever the manifest registered for that class.
- `ensureSchema()` (reached from the deprecated `smrt db:setup`) is
  manifest-first: it takes `ObjectRegistry.getSchema()` plus the merged
  `getAllSchemasAsDefinitions()` table definition, and only falls back to
  `generateSchema()` when no schema is registered at all.

So a normal build keeps the manifest schema through `db:setup`, and a
registry-derived schema is usually a test/dev artifact — but not always. One
shipping consumer takes the registry route at runtime: `smrt-content`'s
`src/hooks.server.ts` `bootstrapSchema()` calls `generateSchema()` for every
registered class and then `ensureSchema()`, from the SvelteKit `handle` hook on
any `/api/*` request, with no dev-mode gate despite the file header. In that
process `getAllSchemasAsDefinitions()` returns registry-derived schemas. Always
check which route a process actually took before trusting a reproduction.

## Why the drift stayed invisible

Every drift oracle compares a database with the same artifact that dropped the
index:

- `verifyPersistenceTable()` (`schema/table-verifier.ts`) calls `db.tableExists()`
  and nothing else. "Runtime verifies schema" has always meant existence-only —
  no column, type, constraint, or index comparison.
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

Anything touching numeric types, uuid casts, upsert conflict targets,
timestamps, or migrations runs `pnpm --filter @happyvertical/smrt-<pkg>
test:postgres` (core, cli, users, sales, marketing, analytics, and vitest carry
the lane). SQLite's type affinity accepts values PostgreSQL rejects — a money
field declared `number = 0` compiles to INTEGER and only fails on PG (#2361).

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
