# Database-generated fields (#4915)

`@field({ generated: expression })` and `RuntimeFieldDefinition.generated`
declare database-owned columns. Expressions use the existing
`@happyvertical/sql` `AggregateOperand` nodes. References name logical model
fields (`{ col: 'unitPrice' }`), which schema generation maps to physical
columns. A generated column reads, filters, sorts and aggregates like an
ordinary column.

```ts
@field({
  type: 'integer',
  generated: { op: 'mul', left: { col: 'qty' }, right: { col: 'unitPrice' } },
})
total = 0;
```

Registration checks the closed node shapes, same-row references, result type,
24-level depth, 1024-node budget and 65536 serialized-character budget.
References to generated or transient fields are refused, including self
references. Validation resolves the full effective ancestry; decorator parents
are resolved by constructor identity even when packages share a class name.

Framework identity/ownership fields cannot be generated. This covers `id`,
`slug`, `context`, creation/update timestamps (camelCase or snake_case), every
underscore-prefixed system field (including STI discriminators/data and sync
revision/device identity), explicitly marked primary keys, foreign keys and
cross-package references. Tenant columns use the registry's shared ownership
resolver: an implicit `tenantId` is protected without a tenancy declaration,
as are explicitly configured or marked tenant fields. Decoration, manifest
registration/merge and runtime definitions enforce the same boundary.
Pre-registration candidates use `ObjectRegistry.getOwnershipTenantColumn()`
against the shared-table base and every ancestor, and `getConflictColumns()`
for all natural-key columns. Invalid candidates never enter the registry or
its inheritance caches when their ancestry is available. A generated declaration
whose parent has not loaded may register as pending metadata, but schema access
(including migration inputs) and persistence throw `GeneratedFieldError` with
`ancestry unresolved` until the full chain is registered. Loading a parent
revalidates only subscribed generated descendants, without scanning other
registrations. An invalid descendant is quarantined on its own registry record;
parent registration succeeds. Its typed error appears in existing registry
diagnostics (`usable: false`) and its own field/schema/DDL, runtime migration,
persistence and transport entry points refuse use. Bulk schema, migration-input,
OpenAPI, REST-manifest and MCP catalogs omit only quarantined classes, so other
models stay available. Pending classes follow the same isolation rule. Legitimate
pending children become usable when
their ancestry is complete. An unqualified decorator parent is held by its
constructor identity while pending: a different package's same-named class
cannot resolve it. Qualified manifest parent references retain package identity.
Runtime definitions with generated fields can also be pending; they use manifest ancestry until the real parent is available.
Children cannot turn any inherited ordinary field into
a generated field, or explicitly redeclare an inherited generated field in
source/runtime definitions. Unchanged inherited generated metadata in a merged
manifest is inheritance, not a new declaration.

Metadata is cloned and frozen so changing a caller's definition cannot change a
registered expression. `GeneratedFieldError` carries a validation code;
caller assignments use `VALIDATION_GENERATED_FIELD_WRITE`.

Generated expressions inherit sensitivity and read permission from their
inputs. A definition requiring multiple distinct read permissions is refused:
the existing field policy represents only one permission. This preserves the
restriction until conjunctions have an owning field-policy contract.

All SDK 0.112.3 scalar nodes are accepted: arithmetic and comparisons,
boolean/null/coalesce operations, `asText`, conditionals (`if`, `case`),
`round`, `abs`, `floor`, `ceil`, `least`, `greatest`, `mod`, text functions
(`concat`, ASCII `lower`/`upper`, `trim`, `length`, `substring`), calendar
parts (`year`, `month`, `day`), `secondsBetween`, `daysBetween`, and `addDays`.
Arguments and branches must have compatible types; SDK literal bounds and
closed shapes are enforced too. Dates use JSON-safe
`{ value: { kind: 'date' | 'datetime', iso } }` literals; JavaScript Date
instances are refused. `div` and `mod` return NULL on zero divisors.

The SDK's public `renderExpression(..., { mode: 'ddl' })` owns SQL, identifier
quoting, literal escaping and immutability checks. There is no aggregate SQL
scraping. Schema/manifest columns carry `generatedInputTypes` for physical
references, preserving safe casts through migrations and parity checks.
`VALIDATION_GENERATED_NON_IMMUTABLE` refuses unsafe generated expressions.
Registration compiles for SQLite and PostgreSQL. PostgreSQL rejects datetime
columns and datetime literals anywhere in the expression tree, including inside
boolean comparisons or null checks: a boolean result does not make nested
TIMESTAMPTZ casts immutable. Portable definitions therefore use date-only
literals for calendar expressions; datetime inputs are refused with
`VALIDATION_GENERATED_NON_IMMUTABLE` before DDL. This is a known **temporary limit** while
[happyvertical/sdk#1516](https://github.com/happyvertical/sdk/issues/1516) is
open: registration refuses expressions using datetime fields or literals on
**every dialect**, including SQLite-only applications, because registration
validates portability before a database is selected. Date-only literals remain
supported. The standalone SQLite renderer can still compile temporal
expressions for that dialect.

SQLite uses VIRTUAL columns; PostgreSQL uses STORED; DuckDB uses VIRTUAL;
the JSON adapter is refused. Normal migration and parity paths retain
expression metadata. SQLite generated columns need `table_xinfo` because
`table_info` omits them. PostgreSQL deparses implicit casts; parity uses
read-only EXPLAIN (without ANALYZE) to normalize differing renderings. Changed
expressions on SQLite/PostgreSQL drop and re-add the column and recreate
declared column indexes. Ordinary-to-generated replacement carries the existing
warning advisory mechanism because it discards ordinary stored values. SQLite
adds UNIQUE generated columns with a separate unique index: ALTER ADD COLUMN
cannot carry inline UNIQUE. PostgreSQL columns are STORED; SQLite and DuckDB
columns are VIRTUAL.

DuckDB can create a new table with VIRTUAL generated columns (covered against
real in-process DuckDB). Its driver cannot add a generated column to an existing
table. Additions and expression changes on existing tables raise
`VALIDATION_GENERATED_DIALECT` before returning any executable statement; an
operator must explicitly plan a new-table migration.

Known limit: SQLite/DuckDB drift comparison ignores whitespace and identifier
quoting but otherwise compares expression text. An SDK renderer change can
report drift for a semantically identical expression; SQLite may replace the
column, while DuckDB refuses the change. Inspect the plan after SDK upgrades.
No semantic SQL parser or normalization beyond formatting is promised.
PostgreSQL and DuckDB diff and live-parity runs each read generated columns
in **one catalog query per run**, reused across managed tables. Rows for unmanaged
tables are ignored before parsing DuckDB DDL, so an unrelated table cannot break
generated-column discovery. This discovers removal of the last generated
declaration,
including hand-created columns, without requiring deployment snapshots.
A reused comparer refreshes the catalog for each run; standalone `compareTable`
calls also make one catalog read each. A database without generated columns
retains the ordinary migration diff, with one extra query per run.
Successful catalog reads do not scan model declarations to decide strictness;
that check is deferred until a catalog read fails. Ordinary SQLite diff/parity
reuse their existing column comparison to discover missing columns, avoiding
a separate generated-declaration walk.

SQLite retains feature-scoped discovery: it probes tables with expected or
previously recorded generated columns, or (without a previous table snapshot)
when an expected column is missing from live metadata. `table_info` hides
VIRTUAL columns, so this fallback discovers last-declaration removal. A genuinely
new ordinary column can also pay this best-effort probe. The optional
`previousSchemas` input can suppress that fallback for known ordinary tables;
it is not needed for PostgreSQL/DuckDB removal detection.

A failed optional catalog read is treated as no generated columns known,
preserving ordinary diff/parity behavior on catalog-incompatible adapters or
test doubles. Failure propagates if **any** generated column is expected in
the run; declared generated drift is never silently ignored. Optional discovery
can therefore miss a conversion when the catalog is unavailable. Live parity
reports `generated_expression_drift` for both conversion directions when found.

Generated-to-ordinary migrations have explicit value semantics:

- PostgreSQL uses `ALTER COLUMN ... DROP EXPRESSION`, preserving every STORED
  value and existing index. A warning advisory explicitly says the column will
  stop updating automatically, including for discovered hand-created columns.
  Ordinary type/default/nullability changes are then planned by the normal differ.
- SQLite and DuckDB VIRTUAL columns have no stored values. Removing a generated
  declaration is supported on both: the migration drops the VIRTUAL column and
  adds an ordinary column, recreating declared column indexes. DuckDB's refusal
  of generated additions/expression changes does not apply to this ordinary ADD. Existing rows
  receive the ordinary declaration's default, or NULL; the previous calculated
  results are not materialized. A populated table targeting NOT NULL without a
  non-NULL default stays manual drift and emits no destructive SQL: supply a
  deliberate data migration or a default first.
- Ordinary-to-generated and changed-expression migrations replace the derived
  column, discard its old values and recalculate from the expression. Source
  columns and rows remain intact. Execute multi-statement plans through the
  migration tracker's transaction so a failed replacement rolls back.

Application tables are still created only by explicit schema planning.

`planRuntimeModelDDL` remains additive: it adds missing generated columns but
does not replace an existing expression. Use the ordinary migration differ
for expression changes. DuckDB existing-table additions are refused here as
well, before any statements are returned. It needs column-name introspection from
`pragma_table_xinfo`, not `pragma_table_info`, on SQLite.

Persistence rejects supplied generated inputs, strips generated columns after
the complete serialization chain, and reloads computed values before
`afterSave`. Shared compatible bulk preparation uses the same path. Direct
property edits after initialization are rejected against the hydrated baseline.
REST, MCP and generated SvelteKit create/update handlers drop supplied generated
keys exactly like readonly keys, so a fetched record can be sent back whole.
The database recomputes the value from writable inputs. Direct object and
collection assignments still refuse generated keys. Generated REST/MCP write
schemas omit them; output shapes retain them subject to normal read policy.
Hydration bookkeeping uses the private `_generatedValues` slot, leaving a
person's ordinary `generatedValues` model field available.

Tests: `src/__tests__/generated-fields.test.ts` runs SQLite persistence in
`pnpm test` and PostgreSQL persistence in `pnpm test:pglite`, using the existing
isolated SDK/PGlite fixture. Neither a core PGlite devDependency nor an external
PostgreSQL server is needed.


For models without generated fields, manifests, DDL, migration diffs, OpenAPI
and generated source retain their pre-PR shape. Ordinary STI parent fields stay
on their declaring class; only inherited generated metadata is copied for the
new output/write contract. Dependency validation uses effective ancestry without
turning ordinary inherited unique fields into new child declarations.

OpenAPI creates an input component only for a model with generated fields. It
prefers `<Model>Input`, reserving real model and list component names first, then
uses deterministic numeric suffixes on collision (`OrderInput2`, etc.). Create
and update reference the same allocated component. Plain models retain their
original component references.

`src/__tests__/generated-fields-compatibility.test.ts` compares exact byte
digests with checked-in expectations captured from `origin/main` at
`b16fc4c9075e50a6410a6039e1df295a42473c26`. It covers a plain model and a
three-level STI hierarchy with a middle-class unique field, including a live
migration diff against the captured SQLite deployment. The fixture includes
OpenAPI, monolithic/modular MCP and every generated SvelteKit TypeScript file;
no output normalization is applied. See the fixture's provenance document.

Generated-feature isolation: registration records generated declarations during
its existing field-map writes. Plain classes perform no generated validation,
ancestry walk, or expression compilation; field/schema/write hot paths use only
an O(1) check on the class's own record. Pending subscriptions use exact parent
constructors for decorator classes and qualified names for unloaded manifests.
Only a subscribing generated class is revisited when its missing parent loads.
Transactional registry checkpoints preserve declaration discovery and subscriptions;
restoring ordinary classes performs no generated validation.
The PostgreSQL/DuckDB one-query discovery above remains necessary to detect a
removed last declaration without a persisted snapshot; it is the documented
exception to zero extra catalog work for a currently ordinary schema. SQLite's
missing-column discovery also remains necessary for that transition.
