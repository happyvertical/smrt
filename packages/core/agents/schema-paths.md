# smrt-core/schema paths

Module semantics for `src/schema/` — which `SchemaGenerator` entry point reaches
a real database, what each one emits, and the rules that keep them in step.
Package orientation, the cross-module invariants, and the traps that apply
before editing anything live in [../AGENTS.md](../AGENTS.md) — read that first;
it links the relevant runtime and generation contracts.

The data shape rules these paths implement (required only with a reason, harden
by subclass, migrate all or nothing) and how each is kept are in
[data-shape-rules.md](data-shape-rules.md).

## Four entry points, two of which ship

`src/schema/generator.ts` exposes four index-emitting entry points. Their columns and indexes must agree for the same class.

| Entry point | Selected by | Status |
|---|---|---|
| `generateSTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateCTISchemaFromManifest` | `src/scanner/manifest-generator.ts` | **production** |
| `generateSTISchemaFromRegistry` | `src/testing/database.ts` (`getTestDatabase()`), `src/schema/utils.ts` (`generateSchema`; `ensureSchema` only as a fallback) | tests + runtime helpers |
| `generateSchemaFromRegistry` | the same two callers | tests + runtime helpers |

The migration differ and CREATE TABLE planner share adapter-aware engine
selection. A native in-memory DuckDB handle can report `:memory:` and expose
`exportTable`, so use the native and JSON adapter discriminators before URL
inference. For native DuckDB the differ reads inline UNIQUE constraints from
`duckdb_constraints()` because the adapter index list omits them.

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

All four entry points share `SchemaGenerator.completeIndexes()` (#4946), the
single ordered tail after conflict/discriminator/unique indexes: slug lookup,
opt-in fields (including STI JSON paths), declared indexes (then STI descendant
declarations), default list ordering, polymorphic owner lookup, reference
columns **last**, then identifier limits. The registry schema builder calls the
same sequence after merging every contributor and conflict index whenever it
adds runtime columns absent from a manifest, or a class has no manifest schema.
It supplies the missing fields for opt-in indexing and preserves supplied
manifest indexes; reference suppression sees the complete table's indexes.
Current manifests that already supply every column retain their index sets.

Since #2359 the two families share one set of index helpers and
`src/schema/schema-path-parity.test.ts` runs the same fixture manifest through
the manifest paths, through `ObjectRegistry.registerFromManifest()` + the
registry paths, and through `getAllSchemasAsDefinitions()`, asserting identical
column and index sets. Extend that fixture with every generator change; a
divergence is a bug in the generator, not an exception to add to the test.

### Field inheritance: one rule, one module (#4922, #4940, #4942)

"What fields does a class have, counting what it inherits" is decided in ONE
place: `resolveInheritedFields()` in `src/schema/field-inheritance.ts`, a pure
module (no registry or scanner imports, generic over any field shape with
`type` / `required` / `enum` / `description` / `related` / `_meta`). Callers:
`ManifestGenerator.mergeInheritedFields()` (build; manifest representation),
`getAllFields()` and `getOwnTableFieldsSync()` in
`registry/inheritance-resolver.ts` (registry representation; the latter feeds
`getAllSchemasAsDefinitions()` and `runtimeModelEntry()`). Do not write a
second merge loop; extend the module and the differential test.

Ancestors apply base to child, then the class's own fields last:

- **A redeclared field inherits parent options as defaults.** Only options the
  child states override them. Nearest wins per option, in either direction,
  for own-table and shared-table (STI) classes. A bare redeclaration keeps all
  options. To loosen, say so: `required: false`, `unique: false`, a lower `min`
  or a wider `max`. Scanner-inferred `required` and `default` apply to new
  fields. A same-type redeclaration keeps the parent value or its absence. A type change may use
  fresh inferred defaults for the new type. `_meta.__statedOptions` records the
  written decorator options, plus enum and relationship declarations, before
  registry normalization can mix inferred values into `_meta`. The decorator
  path writes the same list from the options the author passed. **An entry
  with no list** (a manifest built before the list existed, or one written by
  hand) uses the options it carries, as before this release, when it replaced
  its parent's field whole: its `default`, `description`, `enum` and the like
  win. The one exception is `required` and `nullable` over a parent that smrt
  needs (`requiredFor`): an older scanner inferred `required: false` for fields
  the author never touched, so they are not taken as stated. The field keeps
  the parent's `required` and `requiredFor`, and nothing is refused at run time
  (`CONFIG_REQUIRED_FIELD_LOOSENED` needs a stated `required: false`; an empty
  list also states nothing). Rebuild the manifest to get the list. The check
  reads `required` from the field or from `_meta`, since a registry field
  loaded from a manifest keeps the flag only under `_meta`.
- A type change drops inherited `sqlType`, `min`, `max`, `enum`, `default`,
  `backfill`, `minLength`, `maxLength` and `pattern`. Other options still
  inherit. Type means the field type (`text`, `integer`, etc.); changing it
  drops these type-bound options even between numeric types. A type the
  scanner could not resolve (an enum or class imported from a file it cannot
  read) is not a stated type: the build types it `json` and marks it
  `_meta.__typeUnresolved`, and the redeclaration keeps the parent's type and
  options (#4942).
- `null` clears an inherited option. Leaving it out inherits it. The effective
  field has no value for a cleared option, at either the top level or in
  `_meta`. The stated name remains so the clear survives later merges.
  This applies to `sqlType`, `default`, `backfill`, bounds, `pattern`,
  `description` and `readPermission`. Registry fields also keep tenancy
  markers, combine validators and fill a missing runtime `value`.
- A concrete declaration replaces a framework abstract base's default whole.
- `SmrtHierarchical.parentId` becomes a nullable self-referencing
  `foreignKey` bound to the class's own table: the class itself (own-table),
  the family root, i.e. the first concrete class in the chain (shared-table).
  A concrete ancestor's own `parentId` never replaces an own-table class's
  binding. The registry table of a hierarchical class gains `parent_id` even
  when its registration declares no `parentId` (decorated classes, an
  unmerged manifest); the schema builder's FK pass binds that field to the
  class's own table without a relationship lookup.
- Methods merge by a different rule (`mergeInheritedFields()` methods loop)
  and are not part of this.

An own-table class carries the ancestors' fields in its table definition: a
differently named subclass (`VipCustomer extends Customer` gets `name`/`phone`
in `vip_customers`) and a same-named one (an app `Customer` extending a package
`Customer` keeps the parent's columns on `customers`; the parent comes from the
dependency manifest through `extendsQualified`). Existing databases only gain
columns: a required inherited column with no default on a populated table is
the usual "required column not added" report. How a shared table unions its
family's columns is the schema builder's job and is unchanged.

`src/schema/field-inheritance-parity.test.ts` runs 144 declaration shapes
(table strategy x chain depth/placement x `SmrtHierarchical` base x the
nearer class's behaviour) through the manifest path (real scanner, manifest
generation, `registerFromManifest`) and two registry routes (decorated classes;
an unmerged manifest) and requires identical effective fields and columns. Its
known-disagreement list is empty and stays empty.

`packages/scanner/src/inheritance-resolver.ts` (`mergeFieldsForSTI`) still
pre-merges shared-table fields at the raw AST level, nearest declaration
winning, before types are converted. It works on `RawFieldDefinition`s (type
annotations and decorators), not converted fields, so it does not use this
module; the two agree because core's rule is nearest-wins as well.

### An app hardens a smrt object by overriding a field (#4932)

The nearest declaration wins, tighter or looser. The one limit: a field that is
required **and** carries `requiredFor` (`_meta.requiredFor`, #4923) may not be
made optional by a subclass. `resolveInheritedFields` reports it through
`onRequiredLoosened`; `ManifestGenerator.mergeInheritedFields()` throws
`CONFIG_REQUIRED_FIELD_LOOSENED` naming the class and field. The registry does
not pass the callback: the build is the gate. A required `@tenantId()` carries
`requiredFor: 'tenant-scope'` (scanner and `smrt-tenancy`), so it is covered by
the same fact.

What the database does with a stricter subclass field:

- Own-table class: the column is `NOT NULL`.
- Shared-table (STI) class: every column stays nullable, so `sti-hardening.ts`
  adds a table `CHECK` on PostgreSQL that is true for every other class:
  `_meta_type NOT IN ('<class>', ...) OR "col" IS NOT NULL`. One constraint per
  column lists the requiring classes, descendants included; its name is
  `smrt_ck_<hash of table, column, rule>`. It is carried as `schema.checks` in
  the manifest and `SchemaDefinition.checks`.
- It covers a field the subclass requires and the **base leaves optional**. A
  field the base itself requires keeps today's nullable column.
- The differ (`compareTableChecks`) adds a missing constraint (`alter_column`,
  alteration `set_check`), reports instead when live rows already break the
  rule, and drops a `smrt_ck_` constraint the manifest no longer declares
  (`drop_check`). Other constraints are never touched.
- SQLite and DuckDB get no constraint. SQLite cannot add one in place and
  DuckDB has no per-class form. There the rule is smrt's save-time check
  (`VALIDATION_REQUIRED_FIELD`).

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
- **Widening an explicit key** (e.g. `['key']` → `['tenant_id', 'key']`,
  #3126) renames its index, so migration adds the new unique and
  `SchemaComparer` drops the superseded one without `--drop-indexes`: a UNIQUE
  index named `conflictIndexName()` for its own columns, with no predicate,
  whose columns are a strict subset of a declared UNIQUE index. It is a pure
  relaxation (every row satisfies the wider key) and otherwise would keep
  rejecting rows the model allows. The maintenance-window rule below applies.
  DuckDB has no partial indexes, so its indexes count as predicate-free, and
  its quoted index columns (`"key"`) are unquoted before comparison (#3305 M1).
- **Optional NULL tenants** retain the SDK's NULL-equal upsert identity. Generated
  framework conflict indexes with nullable keys carry `nullsNotDistinct: true`;
  PostgreSQL 15+ creates `UNIQUE NULLS NOT DISTINCT`, enabling warm single-statement
  native upserts. Earlier PostgreSQL, SQLite and DuckDB retain adapter fallback
  semantics. Existing ordinary indexes are upgraded only through the explicit
  [NULL-equal maintenance migration](null-equal-indexes.md). Optional business
  unique fields remain NULLS DISTINCT; this marker is not inferred from them.
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
Runtime `verifyPersistenceTable()` checks the migrate record and table existence.
Database drift checks compare with generated artifacts; they cannot detect an omission shared
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

### STI subclasses declare indexes on the shared table (#3299)

`@smrt({ indexes })` on an STI **descendant** is emitted on the shared table
by `appendStiSubclassDeclaredIndexes()` (both STI entry points, after the
base's declarations; `getAllSchemasAsDefinitions()` and `getTestDatabase()`
inherit it). It goes through the same validation as a base declaration: known
columns, the 63-byte name limit, and errors on a collision. A UNIQUE
declaration is scoped to the declaring subtype with
`WHERE _meta_type = '<qualified class>'`, so siblings sharing the column are
not constrained. As with `@field({ unique })` on a descendant, each class in
the declaring class's own subtree gets a partial copy
(`<declared name, cut to 52>_<10-hex digest>`), so uniqueness holds per
concrete class there too, not across the subtree. DuckDB/JSON skip these
rather than widen them. A subclass UNIQUE with its own `where` is refused; declare a
combined predicate on the base. A plain subclass index stays unqualified, so
polymorphic reads can use it. Columns are emitted exactly as declared and are
never tenant-prefixed, as with explicit `conflictColumns`: put `tenant_id`
first for a tenant-local key (`['tenantId', 'rampEventId']`). Leave it out
only for a reviewed global identity (#3305 dispositions).

Migration: `db:migrate` adds the new index by name. A UNIQUE index fails
closed (the migration rolls back) when existing rows already duplicate the
key. Find and repair those rows first, scoped to the subtype
(`_meta_type = '<qualified class>'`), and never by deleting history to make
the index fit. With `db:migrate --postgres-safe` it is built `CONCURRENTLY`.
A failed concurrent build leaves an INVALID index, which the next run drops
and rebuilds after the data is repaired.

### Relationship targets resolve to a class name on both paths

`@foreignKey`/`@oneToMany`/`@manyToMany` accept a class, a name string, or a
`() => Target` thunk. The decorator invokes the thunk and throws when the target
cannot be resolved (never `related: ''`); the scanner unwraps the same thunk
from raw source (never `related: '() => Target'`). An unresolved target silently
costs the relationship edge, `loadRelated()`, and the FK-derived index (#2379).
A thunk resolves at decoration time, so a target declared later in the same
module is still in its temporal dead zone — use the string form there.
Runtime decorators retain the resolved constructor alongside the display name.
Inverse lookup and cascade planning resolve that constructor when queried, so
the target may register after its child without binding to a same-name class
in another package. String targets prefer the declaring package; ambiguous
unqualified targets never match an unrelated package's inverse edge.
Registry schema generation and the merged migration schema resolve the same
canonical target before selecting both its table and identifier type. The
manifest generator resolves unqualified targets in the declaring package.
Keep the merged schema in parity tests: `getTestDatabase()` preserves its
authoritative FK metadata over the generated columns, so testing only the
standalone generator cannot prove the constraint that reaches the database.
With an explicit `classes` list, `getTestDatabase()` builds that authoritative
schema with `getAllSchemasAsDefinitions({ tables })`: only the requested tables
and their foreign-key closure are merged and ownership-checked
(`CONFIG_TABLE_NAME_COLLISION` still fires for any of them), so an unrelated
collision elsewhere in the registry cannot abort the setup. The implicit list
checks every registered table (#3956).

Field decorator registration retains constructor ownership separately from the
simple-name inspection view. Custom decorators should pass the callback's
constructor as `registerFieldDecorator`'s fourth argument. Omit it only for
intentional legacy string-only metadata; that legacy metadata still composes
with constructor-owned options, but mirrored public decorator fields do not.

### Decorator-only field types agree on both paths (#4295)

A compiled model registered without a manifest entry sees only `@field()`
options, never the initializer or annotation the scanner reads. Without an
explicit `type`, a boolean `default` infers `boolean` on both paths
(`inferDecoratorOnlyFieldType` in `src/registry/class-registration.ts`, step
3.7 of the scanner's `ManifestAdapter.inferFieldType`); anything else falls
back to `text`. Numbers are never inferred at runtime (`0` and `0.0` are the
same value), so a runtime-only numeric field must declare
`type: 'integer' | 'decimal'`. Loading the manifest later still replaces the
decorator-only type. A database whose column was built from the old TEXT
expectation is not auto-cast; parity reports the drift for an explicit
migration.

### Schema change decisions (#4925)

Migrate makes the database match the code without asking whenever that is safe.
It stops only when it would lose or invent data.

`src/migrations/change-kinds.ts` owns `SCHEMA_CHANGE_KINDS`, the single table of
stable kinds and decisions for PostgreSQL, SQLite, and DuckDB (JSON uses DuckDB's
policy). `classifySchemaChange()` identifies the shape; `decideSchemaChange()`
returns apply, stop, or report and a message naming the table and column or
constraint. Producer `kindHint` values distinguish refusal shapes that share
SQL and flags; consumers never parse the human diagnosis.

Apply kinds carry executable SQL. Report kinds retain data: orphan columns
(including NOT NULL orphans that can break inserts), orphan indexes/unique
constraints, stale defaults, unrequested relaxations, possible rename notes,
and conversions already handled by another rebuild. Reports never set
`unactionableChanges` or `hasManualDrift`; these now contain exactly stop
decisions, even when a report has warning severity. Read `diff.changes` to
show all reports. The differ's executable-DDL helper and the CLI partition use
the same classification; a data-blocked advisory-only UUID conversion is a
stop, not a report.

Every data stop says `loses-data` or `invents-data` and explains why.
`UNRESOLVED_NON_DATA_STOPS` records existing refusals whose engine or adapter
support is incomplete: column alterations/rebuilds, unfinished JSON/UUID preservation
probes, live constraints that prevent UUID conversion, foreign-key additions/replacements/removals, and a missing referenced
parent column. These are explicit exceptions awaiting implementation, not extra
data rules. Unknown shapes stop as `unlisted`; source-coverage and real-comparer
tests guard against real differ output reaching that fallback.

### The three engines apply the same kinds (#4937)

Every kind that applies on PostgreSQL applies on SQLite and DuckDB too. The
table records, per engine, what is still different and why. This is the whole
list:

| Difference | Engines | Why |
|---|---|---|
| Shared-table `CHECK` (`check.*`) | PostgreSQL only | SQLite and DuckDB keep the rule in smrt's save-time check (#4932). DuckDB cannot add a constraint to a table and gives a `CHECK` no name. |
| Removing a foreign key (`foreign-key.drop-unavailable`) | PostgreSQL stops | The SQL adapter does not give the live PostgreSQL constraint name. SQLite and DuckDB rebuild the table instead. |
| Table declared `AUTOINCREMENT` | SQLite stops (`column.rebuild-unavailable`) | The rebuild would lose the sequence. |
| Table that references itself | DuckDB stops, when the change needs a rebuild | DuckDB cannot copy rows into a table whose key points at itself in one statement. A plain `ALTER` still works there. |
| A constraint on a dropped column | DuckDB stops | The rebuild cannot keep a table constraint that names a dropped column. |
| Two tables that would reference each other | DuckDB stops (the rebuild's kind, "overlap and cannot be combined") | DuckDB can create neither table first, and has no `ADD CONSTRAINT`. |
| A new table that references a table the migration alters or rebuilds | DuckDB stops (the rebuild's kind, "new table") | The new table is created first, and DuckDB then refuses to alter or drop the table it references. Adding a plain column still works. |
| Any rebuild | JSON adapter stops | It is DuckDB-backed but has no rebuild. |
| Calculated column (#4915) added or changed on an existing table (`column.add`, `column.generated-replace`) | DuckDB refuses before planning (`VALIDATION_GENERATED_DIALECT`) | Its driver cannot add a generated column to an existing table. |
| Calculated column made ordinary (`column.generated-to-ordinary`) | SQLite and DuckDB stop (loses data) | PostgreSQL `DROP EXPRESSION` keeps the stored values; a VIRTUAL column stores none, so its values would become the default or NULL. |
| `NOT NULL` dropped from a calculated column | SQLite stops (`column.rebuild-unavailable`) | The rebuild does not rewrite a generated column definition. |

Calculated columns otherwise: a changed expression is applied (recalculated,
not additive, so never by a table-limited run on a build table); making an
ordinary column calculated stops on every engine
(`column.generated-from-ordinary`, it would discard stored values); a rebuild
for another column copies only ordinary columns and keeps the calculated one
calculated. PostgreSQL compares expression renderings with EXPLAIN on the live
table and sends no probe for an expression that reads a column the same run
adds. Tests: `migrations/__tests__/calculated-column-kinds.test.ts`.

How each engine gets there:

- **SQLite** rebuilds the table (below) for a type, `NOT NULL`, default,
  foreign key add, replace or remove, and a required column with a backfill.
  One rebuild carries every change of a table: the plan is built from the live
  definition, so a second plan would undo the first. `MigrationTracker` turns
  foreign keys off around it and checks them again before the commit, so a table
  other tables reference no longer stops the run. Dropping a column drops the
  indexes that cover it first, as PostgreSQL does.
- **DuckDB** (`src/migrations/duckdb-rebuild.ts`) refuses `ALTER` when the table
  has an index, when another table has a key onto it, and after an `UPDATE` in
  the same transaction. It also has no `ADD CONSTRAINT`. A change that works
  with `ALTER` once the indexes are out of the way is wrapped in `DROP INDEX`
  and `CREATE INDEX`. Any other change rebuilds the table, and every table that
  references it, in the migration's transaction: copy to staging tables, drop,
  create again from the live definitions, copy back, replay the indexes. DuckDB
  DDL is transactional, so a failure rolls every table back.
- **One DuckDB rebuild per connected group** (`combineDuckDbRebuilds`). Rebuilds
  whose groups share a table, counting keys a rebuild adds, become one plan:
  each table is created once in its final shape and filled once from its old
  rows, backfills included. Every other change to a table of the group runs
  after it; a table the rebuild starts to reference takes its changes before
  it. The diff order does not change the result. Planned one table at a time,
  a parent's rebuild created a changed child again from its old definition and
  lost the change while the migrate succeeded (rv4,
  `issue-4937-overlapping-rebuilds.test.ts`). Rebuilds that cannot be combined
  stop the whole migration before anything runs.
- **The DuckDB rebuild checks itself** before its staging tables are dropped:
  for every table of the group it compares the columns, indexes, foreign keys
  and row count with what the plan meant to build, and fails the transaction
  with the differences. SQLite has no such check: its rebuild touches one table,
  copies every column in one `INSERT ... SELECT`, and has no `error()` function
  to fail a transaction from SQL; `MigrationTracker` checks its foreign keys.
- **Atomic.** A rebuild that fails part-way leaves every table, row, index and
  foreign-key setting as it was. `sqlite-parity` and `duckdb-parity` tests fail
  a rebuild mid-way and compare the database before and after.
- Dropping `NOT NULL` from a manifest-nullable column applies by default on all
  three engines. A stale default and an orphan `NOT NULL` still need
  `relaxColumns`.

`packages/cli/src/commands/__tests__/db-migrate-engine-parity.test.ts` runs one
scenario table on SQLite, DuckDB and PostgreSQL (PGlite). Each scenario gives
its outcome per engine, and a test fails if a scenario differs by engine without
an entry in its `DIFFERENCES` list.

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
- **Called on its own, it refuses when any table has a foreign key onto the
  target and `PRAGMA foreign_keys` is ON** (the SMRT adapter's default). The
  differ passes `foreignKeysSuspended` (#4937), because it runs the plan in
  `MigrationTracker`, which turns foreign keys off and checks them before the
  commit. Only a caller that runs the plan some other way meets the refusal. `DROP TABLE`
  performs an implicit `DELETE FROM` that fires `ON DELETE CASCADE` on
  children, and `defer_foreign_keys` defers constraint *checks*, not FK
  *actions* — verified: the child rows go. The target's own self-reference
  counts, because the staging table copies that clause and becomes a child of
  the table being dropped (verified: a two-row self-referencing table finishes
  the rebuild holding one row). Under the tracker (#4937) the rows are kept.
- **`PRAGMA legacy_alter_table` brackets the rename**, because SQLite ≥ 3.25
  re-parses the schema on `ALTER TABLE ... RENAME` and a view still pointing at
  the just-dropped table makes it fail outright. It is restored immediately
  after; a rolled-back batch leaves it set on that connection, which is inert
  here only because nothing else in SMRT renames a table.

All the drifted columns of one table share a single rebuild: the first change
carries the plan and the rest become `no change needed` comments that the CLI
classifies as no-ops.

### Explicit SQLite NOT NULL relaxation (#4413)

Removing an ordinary inline `NOT NULL` clause from a manifest-nullable column
applies by default on SQLite, as on PostgreSQL (#4937); it used to need
`relaxColumns: true` / `smrt db:migrate --relax-columns`. The flag still
controls a stale default and an orphan `NOT NULL` column. The local application
entry point forwards `smrt app migrate --relax-columns` under its existing
operation lock and refuses a live application writer.

The rebuild preserves live DDL, indexes/triggers and assigned rowids. Named
NOT NULL constraints, `ON CONFLICT`, AUTOINCREMENT tables, primary/generated target columns, missing
clauses and tables shadowing every rowid alias refuse rather than guessing.
Every rebuild the differ plans emits `PRAGMA foreign_keys = OFF` as a tracker
handoff (#4937; at first only the nullable relaxation did): `MigrationTracker` suspends FK enforcement **before** opening its
transaction, verifies suspension on both the base and transaction connection,
and checks `PRAGMA foreign_key_check` before commit. This avoids inbound FK
`ON DELETE` actions and preserves referencing rows. An active borrowed transaction
that cannot suspend enforcement, a mismatched transaction connection or an
adapter without transactions refuses. FK and legacy rename settings are restored
in `finally`, including after rollback. Run this maintenance operation with
exclusive access to the SQLite connection.

A caller that runs the returned statements itself (`getPendingSchemaStatements().statements`,
`getSQLFromDiff`, `planSqliteTableRebuilds`, `buildSqliteRebuildStatements`) in
its own transaction cannot suspend enforcement: `PRAGMA foreign_keys = OFF` does
nothing inside a transaction, so `DROP TABLE` would delete the rows of children
that cascade (verified by `issue-4937-rebuild-caller-executes.test.ts`, which
failed before the guard: the child rows went). Every plan for a table that other
tables reference therefore starts with the guard from
`sqliteForeignKeyGuardStatements()`: an INSERT into a temporary table whose
CHECK fails, with the reason as the constraint name, when `pragma_foreign_keys`
is 1. It runs ahead of every statement that changes data, passes under the
tracker (enforcement is off by then), and the caller's transaction rolls back.
The planner reads the references whether or not enforcement is on for the
planning connection. `buildSqliteRebuildStatements` takes `inboundReferences`;
leaving it out means "not checked" and adds the guard; pass `[]` only after
checking that nothing references the table. A caller outside any transaction
runs the marker, which turns enforcement off on that connection until it sets it
back. The data-loss change kinds (`column.rebuild-data-loss`,
`type.rebuild-data-loss`) are still produced by a direct planner call without
`foreignKeysSuspended`; the differ never produces them.

## What the differ compares (#2369)

`SchemaComparer` (`src/migrations/differ.ts`) compares each manifest column's
type, then — unless the type itself is drifting — its nullability and default,
and always reports what it will not touch:

- **Strengthening** (`SET NOT NULL`, `SET DEFAULT`) is executable on all three
  engines (SQLite by table rebuild, DuckDB by rebuild or index wrap, #4937).
  `SET NOT NULL` is preceded by an `UPDATE … WHERE c IS NULL`
  backfill of the manifest default (a DuckDB rebuild copies with `COALESCE`
  instead, because DuckDB refuses an `ALTER` after an `UPDATE`); without a default the live data is probed
  and, if NULLs exist, the change is reported (comment SQL + `advisory`) instead
  of emitting an ALTER that would abort the atomic batch.
- **Relaxing.** On every engine the migrator drops `NOT NULL` from a column the
  manifest declares nullable by default, with no flag and no opt-out (#4897,
  #4937). It
  loses no data and rejects no row, and the manifest is already trusted to
  tighten columns (`SET NOT NULL`), so a package release that relaxes a column
  must not strand consumers on `manual_migration_required`. The owner's
  direction is that the migrator makes the database match the code without
  asking, whenever that is safe (happyvertical/smrt#4920). Every such change is
  visible: `db:migrate` lists it under "Columns to alter" and logs
  `Altered column <table>.<column> (drop_not_null)`, and `migrateSmrtSchemas` /
  `getPendingSchemaStatements` return it in `relaxedColumns` (the former also
  logs one `Relaxed <table>.<column>` line each). This covers nullability only.
  `DROP DEFAULT` and orphan `DROP NOT NULL` remain report-only advisories until
  the caller passes `relaxColumns` (`db:migrate --relax-columns`); any other
  kind of drift is never changed silently.
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
  the #2369 DuckDB test pins the upsert), older DuckDB builds may not. A required column with no default is enforced inline only on an empty
  table. On a populated one it needs a per-row `backfill` (#3008,
  `ColumnDefinition.backfill` from `@field({ backfill })`): PostgreSQL/DuckDB
  run `ADD COLUMN` (nullable) → `UPDATE … SET col = (backfill) WHERE col IS
  NULL` → `SET DEFAULT` (deferred, if declared) → `SET NOT NULL` → the unique
  index; SQLite adds it through the table rebuild (`sqliteBackfillPlaceholderSql`
  → `planSqliteTableRebuilds` appends `"col" TYPE NOT NULL` and copies
  `(backfill)`), one rebuild per table for every such column. The differ first
  probes `WHERE (backfill) IS NULL` on the live rows. With no default and no
  backfill, or with a backfill that yields NULL or will not evaluate, the
  column is **not added**: a manual `alter_column` (`mismatch.actual ===
  REQUIRED_COLUMN_NOT_ADDED`) names table and column, and `compareTable`
  withholds `add_index`/`add_foreign_key` changes on it. The same backfill
  repairs nullability drift (an existing nullable column holding NULLs).
  A backfill for a single-column unique target is also probed for duplicate
  values and refused by name. Partial unique indexes are exempt from that
  probe only where `supportsPartialIndexes()` holds (SQLite/PostgreSQL);
  DuckDB/JSON build them as full indexes, so they are probed there (#3015).
  DuckDB refuses `ALTER COLUMN` while any index depends on the table, so its
  `SET NOT NULL` is bracketed by `DROP INDEX`/recreate from `duckdb_indexes().sql`.
- **SQLite** has no `ALTER COLUMN`: a nullability or default alteration is a
  table rebuild (#4937, see "The three engines apply the same kinds"). A NOT NULL
  tightening with a declared `backfill` is performed by the same rebuild
  (`COALESCE(col, backfill)` in the copy), which also consumes `type_upgrade`
  placeholders.
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

### Tenant OWNERSHIP, not tenant scope, leads the default key

A class with a `tenantId` field is tenant-owned even when it declares no
tenancy — consumers register such classes with the tenancy interceptor at
runtime (Anytown's Ludis `League`/`Team`, smrt-users `Group`/`Role`/…), which
core never reads. `resolveOwnershipTenantColumn()` (declared tenant column,
else `tenant_id`) leads the default natural key on every producer:
`ObjectRegistry.getOwnershipTenantColumn()` / `getConflictColumns()`,
`normalizeConflictColumns()`, the generator's `resolveConflictTarget()` and the
registry schema-builder. The tenancy read policy is still never inferred
(`getTenantScopedConfig()` stays undefined). Explicit `conflictColumns` are
never rewritten. Old code's `ON CONFLICT (slug, context)` and new code's
`ON CONFLICT (tenant_id, slug, context)` each need their own unique index, so
the inferred tenant-led key is named by the custom-key rule
(`<table>_tenant_id_slug_idx`; only a DECLARED tenant column keeps
`<table>_slug_context_idx`) and `smrt db:migrate` builds it BESIDE the legacy
global unique (expand). The differ keeps the legacy index
(`isLegacyNaturalKeyIndex()`, exempt from the #3126 superseded-index sweep and
from `--drop-indexes`) until `--drop-legacy-natural-key` /
`DiffOptions.dropLegacyNaturalKey` (contract). `db:status` exits 1 while the
tenant-led unique is missing and warns while the legacy one survives
(`cli/src/commands/tenant-natural-keys.ts`). Deploy order and locking:
`docs/content/core.md` ("Upgrading an existing database"). The implicit
`tenant_id` column never makes a foreign key identifying
(`resolveForeignKeyDeleteAction({ columnName })`): a tenant FK stays
`NO ACTION`, so deleting a tenant does not cascade through tenant-owned tables.

The save path backs this up where the key still omits the owner (an explicit
key, or a live table not yet migrated) — `SmrtObject.writeNaturalKeyRow()`. The
row a NEW object's conflict target matches is read directly, bypassing read
interceptors. A different owner on any ownership column
(`ObjectRegistry.getOwnershipColumns()`: `tenant_id`, the declared tenant
column, `@tenantId` fields and runtime registrations reported through
`ObjectRegistry.registerOwnershipColumnSource()` — the tenancy package reports
`registerTenantScopedClass(…, { field })` columns) raises
`TenantIsolationError.naturalKeyOwnedElsewhere()` (`TENANT_ISOLATION_VIOLATION`,
never retried, never naming the other owner), also under `withSystemContext()`;
NULL — or an ownership column the save leaves unset — counts as an owner. A
same-owner row is adopted by id (keeping its `created_at`, applied to the
instance only after the write succeeds), so `DO UPDATE SET` never rewrites a
primary key (no `ON UPDATE CASCADE` churn). Adoption needs an explicit natural
key: when the match is only through a slug `getSlug()` derived from
`name`/`title`/`label` (a human value, not an identity), the new object keeps
its id, moves to the first free `<base>-2` … `<base>-9` (one `slug IN (…)`
probe; then `<base>-<8 id chars>`) and INSERTs — whoever owns the taken row, so
it is never refused. `getOrUpsert()`'s create path opts back into adoption
(`_adoptNaturalKey`): a miss on a non-key field updates the row the derived
slug names instead of adding `<slug>-2`. On PostgreSQL with no NULL conflict
value the write is `INSERT … ON CONFLICT (…) DO NOTHING RETURNING id` first, so
a new key costs one statement and no pre-read, and concurrent first creates
never collapse: the loser re-reads and adopts (explicit key) or moves (derived
slug, then straight to the id suffix), bounded retries. Embedded engines
(serialized by the in-process write queue) and NULL-bearing keys read first.
The junction batch path falls back to per-item saves when
its conflict target omits an ownership column present in the row (`tenant_id`,
the declared tenant column, or any `@tenantId`-marked field), and when any new
item's natural key already names a row the batch is not removing; its
`DO UPDATE SET` never lists `id`, `created_at` or an ownership column. Strict
inserts (`_insertOnly`) check NULL-bearing keys the same way, because NULLs
are distinct in the unique index on SQLite, DuckDB and PostgreSQL < 15.

A save with no owner (`tenantId: null`, typically under `withSystemContext()`)
is deliberately NOT refused when a tenant row shares its slug under the
tenant-led key: it lands as a separate global row, the global-default /
tenant-override shape #2360 keeps. Refusing it would need a cross-owner read on
every global save and would break that pattern. A model that needs a slug
unique across every owner declares explicit `conflictColumns` without the
tenant column; then the guard refuses the colliding save instead.

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

`SmrtClass` coalesces concurrent system-table initialization through completion
of bootstrap, deferred compatibility, and vector setup (#3944). In-flight work
is shared only by the same database handle. Distinct handles at the same URL
retain database-level coordination: a caller-owned transaction may finish its
initialization statements before its tables become visible to another handle.
All same-handle waiters observe failure; the pending entry is removed so a fresh
instance can retry. Existing completed-success cache identities are unchanged.
Provision system tables on a base connection before caller-owned transactions;
constructor initialization still preserves PostgreSQL's transaction lock lifetime.

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
Bootstrap-table columns go in `ensureBootstrapSystemTableCompatibility()`,
which runs before the replay so its indexes find them: `_smrt_ai_usage`'s
#4751 columns are the model (`agents/ai-usage.md`).

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

On PostgreSQL `db:migrate` converges a live SMRT-owned constraint whose only
drift is its action (#3023, `SchemaComparer.findReplaceableForeignKey()`):
build-then-swap via `renderForeignKeyReplaceStatements()` — staged
`<name>_smrt_new` added `NOT VALID` and validated before the old constraint is
dropped and the staged one renamed; `--postgres-safe` runs the VALIDATE and the
swap outside the batch transaction. A change toward `CASCADE` / `SET NULL` /
`SET DEFAULT` still applies (the manifest declares it) but carries a
`warning` advisory that `db:diff`, `db:status` and `db:migrate` print as
DESTRUCTIVE.

### Deletes inside a caller-owned transaction

`runCascadeDelete()` owns the cascade's atomic scope through
`runInOwningCascadeTransaction()` in `src/cascade.ts` (#2824). A root handle opens
its own transaction. A transaction handle on an engine with savepoints nests.
When the engine refuses to nest (`NestedTransactionError`, raised by the SDK before
the callback runs), the cascade joins the enclosing transaction. This happens for
framework-owned handles, for caller-owned **native DuckDB** transactions
(`db.transaction()` scopes and `beginTransaction()` handles passed to
`withDatabase()`), and for the bulk junction path (#2818). A transaction handle
counts as native DuckDB only after core has seen its root, through
`initialize()`, `withDatabase()` or a framework transaction. Otherwise the
handle is never treated as native by guesswork, and the delete keeps the
`NestedTransactionError` refusal. The caller's commit or
rollback then decides the outcome of the cascade, the owned `_smrt_contexts` and
`_smrt_embeddings` cleanup, and the target row.

There is no savepoint, so a cascade that fails part-way cannot be undone on its
own. On native DuckDB the framework therefore aborts the joined transaction
(`SELECT error(...)`) before rethrowing, but only if the cascade has already
issued a write. The SDK's DuckDB `delete()` reports a constant affected count,
and the owned-row cleanup always runs. In practice, then, any failure after the
depth-0 RESTRICT / NO ACTION preflight aborts the transaction. That includes a
revision or write-guard conflict on the row itself, even one that changed no
rows. DuckDB then rejects every later statement with "transaction
is aborted", and its `COMMIT` persists nothing. A caller that swallows the error
therefore cannot commit a half-applied cascade, and the callback is never
replayed. By contrast, a refusal raised before the first write, such as the
RESTRICT / NO ACTION preflight, leaves the caller's transaction usable.
JSON-adapter caller transactions keep the detectable
`NestedTransactionError` refusal, because nothing can poison them.

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
When the referenced parent is absent but scheduled for creation by the same
`compare()` batch (#3240), PostgreSQL first proves the entire existing child
table empty instead of querying the absent parent. Nonempty children are blocked
without executable repair SQL: create and populate the parent deliberately,
then rerun the ordinary orphan preflight. The exception never applies to a
standalone `compareTable()` or an undeclared missing parent, and incompatible
column types, missing target columns, and existing conflicting constraints stay
blocked. Planned-parent and newly added child-column types are compared using
the PostgreSQL DDL mapping (for example, `TIMESTAMP` becomes `TIMESTAMPTZ`,
`INTEGER` becomes `BIGINT`); existing columns retain their live physical types. `NOT VALID` plus `VALIDATE CONSTRAINT` remains the authoritative check;
a writer racing the preflight causes the atomic migration to roll back.
SQLite emits inline `REFERENCES` when adding a new nullable column with no
non-NULL default or backfill (#3795): existing rows receive NULL and the database
enforces subsequent writes. An existing-column constraint or another column
shape still requires a deliberate table rebuild. DuckDB reports the unsupported ALTER
path. Neither engine treats an unsupported constraint addition as a successful
no-op.

**Counting orphans is a separate, read-only concern (#2753).**
`renderForeignKeyOrphanDetector({ limitOne: true })` makes the probe a gate;
`schema/foreign-key-orphan-report.ts`'s `collectForeignKeyOrphanCounts()` runs
the identical predicate as `COUNT(*)` (via the same function's `countOnly`
option, so the FROM/JOIN/WHERE clause is never duplicated) for every
manifest-declared foreign key, and reports child/parent table and column, the
live count, and child-column nullability. A relationship whose child or parent
table does not exist live is skipped and reported separately rather than
failing the whole run. It never repairs anything — the CLI surface is
`smrt db:orphans` (`packages/cli/src/commands/db-orphans.ts`), and `db:status`
prints a compact per-foreign-key summary when any count is nonzero.

**Diagnostics are latency-bound, not query-bound.** Each `getTableSchema()` is
five catalog round trips, so `compare()` and the orphan report read each table
at most once per run, with bounded concurrency on PostgreSQL
(`schema/bounded-concurrency.ts`: 8 introspections, 4 data-scanning probes; 1
elsewhere). `compare()` reads partial-index predicates in one `pg_indexes`
query, and `db:status` seeds the orphan report with
`SchemaComparer.getLiveSchemaSnapshot()`. Never add a per-table or
per-relationship query to these paths without batching or bounding it.

**All-or-nothing migrate (#4927).** `decideMigrationRun()` in
`migrations/migration-run-decision.ts` is the shared run gate. Pass `changes`,
`addedTables`, and `engine`. It returns `proceed`, `stops` (original change,
kind, reason, message), and `heldBack` (plain description, table, optional
column). Schema stops and unconfirmed missing packages refuse a run. Reports
never do. Package checks add `packageStops` and `notices` (see below).
Every new table and apply change is held back if any stop remains. The CLI and
`migrateSmrtSchemas()` both call this gate; Work-style wrappers need no local
policy. `getPendingSchemaStatements().decision` exposes the schema-only plan.
A refused core run returns `applied:false`, `refused:true`, `stops`, and
`heldBack`, with `packageStops` and `notices`. `unactionableChanges` and
`hasManualDrift` still describe schema stops only.
It does not initialize the tracker or stamp a successful migrate record.
Proceeding/in-sync runs return `refused:false` and empty stops/heldBack.
Ordinary execution uses `tracker.applyAll(..., {atomic:true})`. A later failure
rolls back the whole batch. PostgreSQL concurrent-index mode is the declared
exception: non-index changes commit first and a rerun completes the indexes.
The batched PostgreSQL index read includes `pg_index.indisvalid`; an INVALID
index cannot satisfy a declaration by name or signature and is planned again.
A stop still refuses that mode before any writes. The CLI also defers tracker
bootstrap and system timestamp conversion until after the decision. Its lock
uses session advisory locks on PostgreSQL and writes no table rows; other
engines need no lock. Removed `--apply-unblocked` fails before connecting.
See [CLI contract](../../cli/agents/db-migrate-all-or-nothing.md).

The FK-orphan advisory branch in `compareForeignKeys()` (`migrations/
differ.ts`) tags its `SchemaChange` with `orphanBlocked: true` and
`orphanNullable` (mirroring `renderForeignKeyOrphanRepair()`'s own
nullable/not-nullable branch) so a caller can identify this specific
manual-intervention reason without parsing `advisory.message`. `db:migrate
--null-orphans` reads that tag: for a nullable child column it runs the
differ's own suggested `UPDATE ... SET <column> = NULL` (from
`advisory.suggestedSql[1]`, the exact statement the differ already
rendered — never re-derived), then rebuilds the `ADD CONSTRAINT NOT VALID` +
`VALIDATE CONSTRAINT` pair via the shared `renderForeignKeyAddStatements()`
helper (`schema/foreign-key-ddl.ts`, also used by the differ's own safe-add
branch) and adds it through the normal atomic tracker batch. The exact original
change is included in `resolvedStops` for the shared gate. Any other stop
holds back both this UPDATE and the FK. A NOT NULL child column
keeps the unconditional "Manual repair required" refusal — nulling isn't an
option and the flag never deletes rows. `planOrphanDispositions()` fails
closed (routes to "not nullable"/no-op) if an orphan-blocked change is
missing its `foreignKey` definition or its `advisory.suggestedSql` pair, on
the same "report and withhold rather than guess" principle as the rest of
this gate.

`getForeignKeyOrphanOptions()`'s `nullable` reads BOTH sides: the manifest
AND the live column (`dbSchema.columns[...].notNull`), never the manifest
alone (review, #2748). A manifest relaxed to nullable while the live column
has not converged yet — the same drift `--relax-columns` handles for plain
columns — would otherwise report `nullable: true` from the manifest side
only, and `--null-orphans` would attempt an `UPDATE` PostgreSQL rejects
outright (`23502`). The whole run now refuses before writes. Nullable only
when both sides agree; a real NOT NULL on either side keeps the unconditional refusal.

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
advisory and no SQL. The CLI routes them to manual interventions with the
table's data-loss reason; they never become executable tracker migrations.

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

`runRetentionSweep(db, policy)` runs five built-ins in fixed order (`changes`,
`ai-usage`, `contexts`, `dispatch`, `run-once-claims`), then
`registerRetentionTask()` contributions. A failed task records its result and
continues; a missing table is `unavailable`. The `globalThis` registry avoids
split registrations under duplicate core resolution; package tasks exist only
after importing the package. CLI prune optionally imports jobs/users.

Defaults are opt-out: changes 30 days, AI usage 90 days, completed dispatch 30
days/failed dispatch 90 days, contexts by `expires_at`, run-once claims 30
days on `completed_at` (#3080; `in_progress` rows never match — the window is
a replay deadline for `runOnce()`, not just disk hygiene, see
`agents/run-once.md`). `smrt.configure({ retention })` tunes built-ins;
contributed tasks own their defaults/options.
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
`_smrt_contexts(expires_at)`, `_smrt_ai_usage(tenant_id, created_at)`, dispatch
`(status, processed_at)` / `(status, updated_at)`, and
`_smrt_run_once_claims(status, completed_at)`. Jobs `(status, completed_at)`
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

## Successful migrate record (#4926)

`migrations/migrate-record.ts` owns `_smrt_migrate_runs`, provisioned by
`ensureSystemTables` (system schema 1.16.0). A successful whole-schema migrate,
including an already-current database, records the core release, the build's
packages and fingerprint (below). Failed, stopped, and dry runs never stamp
it. Identical release/packages/fingerprint skip the insert; changed values append
and preserve history. This permanent ledger has no retention/prune task.
`readLastMigrateRecord` is SELECT-only and returns `state: 'none'` for an absent
or empty table: the first run under this scheme, not a schema mismatch. The latest
row orders by `created_at`, then `id`. Call the writer on the caller's database
handle while its migration lock is held; it also works without a tracker.

### The build's schema (rv1)

`migrations/build-schema.ts`. The build is the app's project manifest: the
first of `PROJECT_MANIFEST_PATHS` (`.smrt/manifest.json`, `dist/manifest.json`,
`src/manifest/manifest.json`), the file `smrt db:migrate` already requires.
`.smrt/manifest.json` is first because the app's bundled description
(`.smrt/build-schema.js`) is written from it in the same publish, so migrate and
the bundled app agree by construction. A `dist/manifest.json` is a published
library manifest (the shell's lists only its own objects); it is the build only
when nothing else exists. When two project manifests describe different
schemas, `noteAlternativeManifests` sets `BuildSchema.notice`, which migrate
prints and doctor shows: it names the one used and why. A tool that filters or
copies a manifest must recompute `schemaFingerprint` for the objects it writes
or leave it out; `scripts/check-manifest-stamps.mjs` (part of `pnpm build`)
fails on a built manifest whose stamp does not match its own objects.
`describeManifestSchema(manifest)` gives its stamp (`schemaFingerprint`), its
tables with their owning packages, and the packages that contribute tables
(framework base classes and collections own none). `resolveBuildSchema()` finds
it: a registered build, else the file in `SMRT_BUILD_MANIFEST`, else the project
manifest under the working directory. Under `NODE_ENV=test` only the first two
count. A build is registered by `registerBuildSchema(manifest)` (CLI discovery
registers the project manifest it found) or by the app's generated
`.smrt/build-schema.js`: both manifest writers publish it with
`.smrt/manifest.json` from the same merged manifest
(`generateBuildSchemaModule`), and it sets the `BUILD_SCHEMA_GLOBAL` slot without
importing anything. The generated `smrt-register.ts` (so the server bundle and
`.smrt/runtime/register.js`) and the consumer's `.smrt/register.js` import it
first, so a deployed app knows its build with no file and no variable. Library
`dist` output carries no build module; its stamp, when it has one, describes
only its own objects and is read only when that file is the project manifest.

`collectMigrateRecordInput(build = resolveBuildSchema())` is the one input for
both writers (CLI and `migrateSmrtSchemas`): `fingerprint` is
`computeSchemaFingerprint` over the planned schema restricted to the build's
tables (equal to the stamp when declarations agree), `packages` is the build's
list. So the CLI, the app's own migrate, a dev install and a production install
all record the same values. A build table the run has not planned is an
unconfirmable package stop ("part of this build, but this run has not loaded
its tables"). All tables planned but a different shape (installed packages
newer than the build) proceeds with a notice that the build will be refused
until rebuilt. With no build, the whole planned schema and every registered
class's package are recorded, as before.

`migrateSmrtSchemas()` and the CLI pass `packagesSeenInput(current, last,
confirmed)` to `decideMigrationRun()` before tracker bootstrap or apply.
Unconfirmed missing packages refuse the whole run. `packageStops` names them
and explains that a missing declaration could loosen required columns;
`heldBack` lists the apply changes. Pass `confirmRemovedPackages: string[]`
with exact recorded names to confirm intentional removals. Added packages are
fine. A successful run writes the same package list used for this comparison,
so confirmed removals leave the next record, including on an in-sync run.

`checkPackagesSeen({ recorded, current, confirmedRemoved })` is the pure check
in `migration-run-decision.ts`. `recorded: null` means no earlier record.
`decideMigrationRun({ packagesSeen, ... })` folds it into the all-or-nothing
gate. Package stops are not schema change kinds. `notices` reports ignored
confirmations for non-missing names and a skipped comparison when no record
exists. The core migrator logs those notices and returns them to wrappers.
`getPendingSchemaStatements().decision` covers schema changes only.

The fingerprint hashes canonical sorted JSON of abstract tables, columns,
defaults, column CHECKs, calculated-column expressions with their input types
(left out for ordinary columns, #4915), table-level CHECKs (shared-table rules, by name and
whitespace-normalized expression, left out of the JSON when a table has none),
physical foreign keys, indexes (including predicates and JSON paths), and
triggers. It is computed from declarations, never read back from a catalog, so
how PostgreSQL rewrites a stored expression cannot change it. Defaults use the
shared DDL formatter; nested JSON keys are canonicalized. Presentation
metadata, source paths, version hashes, timestamps and registration order do
not participate. What is left out and why: `referenceKind`, `backfill`,
column/index/trigger `description`, a check's `columns`, `ddl` (unless the
table has no columns), `version`, `dependencies`, `packageName`, `baseClass`;
none is a statement migrate runs. `migrations/__tests__/schema-fingerprint.test.ts`
lists every attribute of the schema definition as a `Record` over its keys, so
a new attribute does not compile until someone decides, and checks each
decision. A new shared-table rule changes the stamp (#4929, #4932): the build
is refused until migrate has installed the rule. The stamp is computed by the
same function in the manifest writers, the generated build module, the migrate
record and startup, so all move together. Release-upgrade snapshots hold no
stamps. A stamp is never compared across smrt versions except through a fresh
migrate: after upgrading smrt, rebuild and run migrate before starting. Manifest writers stamp it
as `schemaFingerprint` after merging local and consumed declarations; the
schema-path parity test compares the stamp with the registry for the same
declarations. Only a project manifest's stamp is read. Registered copies leave
it out: per-class manifests in generated `smrt-register.ts`, the consumer's
`.smrt/register.js`, and library inline register shims. A manifest whose
contributors disagree on a shared index has no stamp (generation warns).

## PostgreSQL migration execution

`MigrationTracker.applyAll({ atomic: true })` sets local lock/statement timeouts
before any DDL. `postgresSafe: true` commits non-index DDL atomically, then runs
indexes CONCURRENTLY on `db.acquireSession()` so settings and DDL share a
connection. This mode is not atomic. Unfinished indexes are `failed`, not
`running`; `[smrt: concurrent-index phase 1 committed]` in `error_message`
allows reruns to resume index work without replaying committed DDL. Inspect
`pg_index.indisvalid` and drop INVALID indexes before rebuild (`pg_indexes`
alone cannot detect them). Operational commands: `packages/cli/AGENTS.md`.

### Subclass conflict identities (#3456)

An STI child's explicit `conflictColumns` owns a partial unique index restricted
to its qualified discriminator. The root conflict index excludes these children;
registry and manifest paths emit the same predicates. Natural-key lookups include
that scope, PostgreSQL atomic inserts include the index predicate, and adopted
rows update by id. Bulk writes use per-item guards for these targets. Normal
migrations replace the root index by name and add the child index; repair any
existing duplicate child natural keys before migrating. Stop old writers for this
index migration and load the complete consumer manifest on every shared-table
writer before resuming: a provider-only manifest lacks the child predicates.
DuckDB/JSON reject
these schemas because partial unique conflict identities cannot be enforced.

## Consumer physical table bindings (#3660)

`smrt.tableNames` maps exact qualified model identities to deployment-local
physical tables. `registry/table-mappings.ts` projects schemas for both runtime
`getSchema()` reads and merged migration planning, including index names and
relationship targets. Never remap by a raw old table name: two unrelated models
may own that name in their respective packages. Bind STI roots only; sensitive
models are refused. Well-formed bindings may precede model registration;
partial registries never need unrelated models merely to satisfy configuration.
Runtime object/collection getters recheck ownership even for cached table
names; validation is memoized by registry generation and binding configuration.
Configuration must load before first database use and stay
fixed for that process. This is not an implicit data migration; see
[consumer table bindings](../../../docs/content/table-bindings.md).

## Migrate before runtime starts (#4929)

`assertDatabaseMigratedForBuild(db, { engineHint })` is exported from core.
It compares the build's stamp (`resolveBuildSchema()`, above) with the last
migrate record. It never reads the live registry, so lazy imports, a worker
loading a subset of packages, installed packages the app never imports and
run-time models (`planRuntimeModelDDL`, `migrateSmrtSchemas({ tables })`) do
not affect it. It never
creates schema or runs migrations. Collection queries and object persistence call
it beside their table check in `verifyPersistenceTable()`. TaskRunner and
ScheduleRunner call it before starting their loops. Successful starts share one
record read per database key per process, including concurrent first uses.
Refusals are not cached as successes.
System bootstrap, migrate, doctor and db:status do not call this guard.
The SvelteKit app runtime's `ready()` (its `init` gate) runs the check at
start. A process that loads no generated registration (a plain script, a Vite
app without SvelteKit route generation) finds its build only by
`SMRT_BUILD_MANIFEST` or the working directory's project manifest. A cached
start remembers the registered build; a later registration checks again, so a
query that ran before the registration never fixes the answer. A build with no
stamp, or no build at all, refuses in production (warns in development):
migrate refuses the same index conflict, so no database can be migrated for it.

Production refuses a missing record or a different fingerprint and names
`smrt db:migrate`. The error shows short expected/found fingerprints. An old
copy of the app that restarts after a migrate will not come back up. Rolling
code back without the database will not start either. Stop old copies before
migrating and start the matching build after the migrate succeeds.

`NODE_ENV=development` (also the unset default used by the CLI) warns once per
database and starts. `NODE_ENV=test` is a quiet exemption, to keep existing
log assertions and test fixtures stable. Handles successfully prepared by
`getTestDatabase()` are marked in a module-owned WeakSet and exempt even in
production mode. The mark belongs to that handle, not every database at its URL.

For an emergency, `SMRT_ALLOW_UNMIGRATED_START=1` starts anyway. It logs once
per database per process, including when fingerprints match. The warning names
the override and the expected/found values. Other values do not override.

Whole-schema provisioning is `db:migrate` or `migrateSmrtSchemas`; both record
success, including an in-sync run. A run limited to `tables` (lazy activation,
run-time model edits) is not a whole-schema migrate: it skips the package
comparison and records nothing, and on a build table it may only add (a
change whose SQL does more than add is a `build-table` stop; see the CLI's
`db-migrate-all-or-nothing.md`). `smrt app install/setup/migrate` use the CLI
migrate path. The local app-runtime's first-run `createSchema` hook and its
`migrateSchemas()` callback use the core migrator, so they also record success.
The app-shell's additive `prepareShellSchema` and content's `bootstrapSchema`
hook are local/development bootstraps, not production migration entry points.
The deprecated `db:setup`, `ensureSchema`, and `SchemaManager.ensureTable(s)`
fill in missing tables and columns. They do not reconcile all existing
constraints or prove the whole registry matches. They must not provision
production databases or stamp that claim.
Jobs' `ensureSchema` call prepares terminal-event compatibility storage only;
it does not replace a whole-schema production migrate. The smrt-vitest schema
builders are test-only. Direct SQL/adapter `createTable` calls are low-level DDL;
production applications must finish with a successful whole-schema migrate.

## Release upgrade gate

Repository files in `packages/core/release-upgrade/` record the upgrade promise.
`snapshots/<release>.json` saves every smrt-owned PostgreSQL table as it was
created by that release's own migrator. It includes columns, constraints,
indexes, and system bookkeeping rows. `modelTables` records which tables the
old release declared as models. This includes models named `_smrt_*`; the
prefix alone does not make a table bookkeeping. `oldest-supported.json` names the oldest
release we support. The first saved schema is the first supported release.
Capture normalises bookkeeping timestamps, generated UUIDs, execution times,
and the migration actor;
these values must not make two captures of the same build differ.

The release maintainer runs `pnpm release:snapshot` after publishing, on the
built release checkout, and commits the resulting snapshot. To capture a built
older checkout, run `node scripts/release-upgrade-gate.mjs save --root <checkout>`.
Keep the oldest snapshot and the two newest others. A first-hop snapshot named
by a floor move is also kept while that decision needs it.
Each release saves its snapshot with `pnpm release:snapshot`; the 0.60.18 snapshot was saved after the fact because 0.60.18 was published before the gate existed.

Run `pnpm build` and `pnpm check:release-upgrade` locally. The full-mode knowledge
PR job runs the gate after the build. It rehearses the newest saved release at
or before this build's version, and the oldest supported release. When these
are the same file it runs once. Each rehearsal restores the old physical schema
in PGlite and seeds one minimal row per model table. Only old required columns
without defaults are filled, with deterministic primary keys. Foreign keys and
enum checks guide seed values. Every model table must get its row (rule 6: a
rehearsal on an empty table proves nothing). A table that does not, a seeded
reference that cannot be aligned or points at no row, and a stale plan entry all
fail the gate, each naming the table and the database error. There is no warning
path. `seed/<release>.json` holds, per snapshot, the two checked-in escapes:
`suppliedRows` (`table`, a real minimal `row` of column values, `reason`) for a
table the generic row cannot satisfy, and `emptyByDesign` (`table`, `reason`) for
a table that must stay empty. Both start empty. An entry is stale, and fails, when
its table is not a model table of that release, a supplied column is not in the
snapshot, or the generic seeder now fills the table. A seed file with no snapshot
fails too. `save` writes an empty file for a new snapshot; pruning a snapshot
removes its file.

Any migration stop fails the gate. The output names the table and column,
the reason, and the work held back. Errors and a second diff that still needs
work also fail. An old column that the build no longer declares fails if it
holds data. A NOT NULL orphan without a default fails even if empty, because
new code cannot insert. Ship a needed data step with the schema change. A field that was optional in the oldest supported release becomes required only together with the data step for rows that lack it.
`leftover-columns.json` can record intended leftovers. Every entry names
`table`, `column`, `since` and a non-empty `reason`. Review that reason as a data
decision. Entries that match no leftover in either rehearsal fail as stale.

Migrate refuses a database whose last migrate record is older than the floor.
It names the supported release and the first upgrade to run. A database without
a record is a first run under this scheme and proceeds. To move the floor, run
`node scripts/release-upgrade-gate.mjs move-oldest --to <release>
--upgrade-first-to <release> --reason "<why old upgrade code can be removed>"`
on one shell line. Both releases must have saved snapshots. The command appends
the previous record to `history` and records the release older databases must
upgrade to first. Move it when old upgrade code must be deleted, never because
time passed. Review and commit that decision with the code deletion.

P8: the release workflow is not wired to this gate yet. A release job cannot be
verified without publishing. This change supplies a tested command and a PR
job; a later verified release change must wire the publishing path.

Fallback registry aggregation includes `_sync_origin_device_id` and
`_sync_revision` even without a generated manifest schema. Migration-created
source-only models must support the same tracked delete path as compiled models.
The fallback id-type regression also asserts these columns; the plugin fixture
exercises delete after owner approval against a fresh runtime database.
