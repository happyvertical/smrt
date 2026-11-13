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
`VALIDATION_GENERATED_NON_IMMUTABLE` before DDL. The standalone SQLite renderer
can still compile temporal expressions for that dialect.

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
Introspection runs even when the expected schema declares no generated columns;
live parity reports `generated_expression_drift` for both conversion directions.

Generated-to-ordinary migrations have explicit value semantics:

- PostgreSQL uses `ALTER COLUMN ... DROP EXPRESSION`, preserving every STORED
  value and existing index. Ordinary type/default/nullability changes are then
  planned by the normal differ.
- SQLite (and DuckDB) VIRTUAL columns have no stored values. The migration drops
  and re-adds the column, recreating declared column indexes. Existing rows
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
for expression changes. It needs column-name introspection from
`pragma_table_xinfo`, not `pragma_table_info`, on SQLite.

Persistence rejects supplied generated inputs, strips generated columns after
the complete serialization chain, and reloads computed values before
`afterSave`. Shared compatible bulk preparation uses the same path. Direct
property edits after initialization are rejected against the hydrated baseline.
Generated core REST/MCP write schemas omit them;
output shapes retain them subject to normal read policy.

Tests: `src/__tests__/generated-fields.test.ts` runs SQLite persistence in
`pnpm test` and PostgreSQL persistence in `pnpm test:pglite`, using the existing
isolated SDK/PGlite fixture. Neither a core PGlite devDependency nor an external
PostgreSQL server is needed.
