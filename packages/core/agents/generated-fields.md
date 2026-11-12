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
references. Framework identity/ownership fields cannot be generated. Metadata
is cloned and frozen so changing a caller's definition cannot change a
registered expression. `GeneratedFieldError` carries a validation code;
caller assignments use `VALIDATION_GENERATED_FIELD_WRITE`.

Generated expressions inherit sensitivity and read permission from their
inputs. A definition requiring multiple distinct read permissions is refused:
the existing field policy represents only one permission. This preserves the
restriction until conjunctions have an owning field-policy contract.

All SDK 0.112.2 scalar nodes are accepted: arithmetic and comparisons,
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
SQLite temporal inputs use ISO text. PostgreSQL core datetime columns are
TIMESTAMPTZ, so the compiler withholds the SDK's timezone-free type assertion:
generated date operations on those columns are refused. Typed date literals
and their composed calendar operations remain immutable. A bare typed temporal
result targeting a PostgreSQL TIMESTAMPTZ column also requires a session-dependent
implicit cast and is refused. `asText` of a datetime is refused because its
representation can depend on session settings.

SQLite uses VIRTUAL columns; PostgreSQL uses STORED; DuckDB uses VIRTUAL;
the JSON adapter is refused. Normal migration and parity paths retain
expression metadata. SQLite generated columns need `table_xinfo` because
`table_info` omits them. PostgreSQL deparses implicit casts; parity uses
read-only EXPLAIN (without ANALYZE) to normalize differing renderings. Changed
expressions drop and re-add the column and recreate declared column indexes.
Application tables are still created only by explicit schema planning.

`planRuntimeModelDDL` remains additive: it adds missing generated columns but
does not replace an existing expression. Use the ordinary migration differ
for expression changes. It needs column-name introspection from
`pragma_table_xinfo`, not `pragma_table_info`, on SQLite.

Persistence rejects supplied generated inputs, strips generated columns after
the complete serialization chain, and reloads computed values before
`afterSave`. Shared compatible bulk preparation uses the same path. Direct
property edits after initialization are rejected against the hydrated baseline.
Generated REST/MCP/CLI write schemas and CLI interactive prompts omit them;
output shapes retain them subject to normal read policy.

Tests: `src/__tests__/generated-fields.test.ts` (SQLite/PGlite),
`../../reports/src/__tests__/runtime-generated-field.test.ts`, and
`../../cli/src/__tests__/generated-fields.test.ts`.
