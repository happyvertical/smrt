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

All supported SDK scalar nodes are accepted: arithmetic (`div` is fractional
and NULL on zero), comparisons, `and`/`or`/`not`, `isNull`/`isNotNull`,
`coalesce`, `asText` and `secondsBetween`. Literals must be finite JSON scalars;
Date instances are not portable through static JSON manifests. The SDK does
not yet expose case/if, round/abs, scalar min/max, or further text/date nodes;
add these in the SDK, not as a second grammar here. Its public aggregate
builder owns rendering. Core extracts one expression projection and quotes
its bound strings for DDL. Changes to that SDK projection format fail closed.

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
