# smrt-ui/data: DataTable footers and summaries

Module notes for `DataTable` (`src/components/data/`, `./data`). Package
orientation is in [../AGENTS.md](../AGENTS.md).

## Footer rows

Three ways to put rows under the data, all outside the selectable,
virtualized body:

| Prop | Renders | Use for |
|---|---|---|
| `footer` (snippet, receives `{ rows }`) | one full-width `<tfoot>` cell | free content (a note, a link) |
| `structuralRows` (`kind: 'footer'`) | a `<tfoot>` row with per-column `values`, a `<th scope="row">` label | report rows you computed yourself |
| `summaries` | one `<tfoot>` row computed per column | counts, sums and averages |

`summary`, `subtotal` and `aggregate` structural rows render in a separate
body after the data instead.

## Column summaries (`summaries`, #3718)

`summaries: Record<columnId, 'count' | 'sum' | 'avg' | ((rows) => string)>`
renders one `footer` structural row (after any of yours), labelled
`summaryLabel` (default "Total", `ui.data_table.total`). Columns without an
entry get an empty cell.

- **Scope**: every filtered row, across pages; under manual pagination, only
  the rows given. A partial set is the caller's problem: pass a function
  summary (`() => formatted`) with a server total instead of `sum`.
- **Exact money**: integer input never leaves integers, so minor units are
  summed in minor units; a sum past `Number.MAX_SAFE_INTEGER` is an empty
  cell, never a rounded one. Format in the column's
  `summaryFormat(value, { kind, columnId, locale })` (money: divide by the
  currency's minor digits there); the default is `Intl.NumberFormat` in the
  table's locale. Numeric strings count; other values are skipped; `count`
  counts rows.
- **Alignment**: a `sum` / `avg` column without an explicit `align` is
  right-aligned (header, cells and footer).
- The arithmetic is the pure `DataTableSummaries.ts`
  (`buildDataTableSummaryRow`, `sumDataTableColumn`,
  `averageDataTableColumn`, `summarizeDataTableColumn`,
  `formatDataTableSummary`, `isNumericSummary`), exported from `./data` and
  Node-tested in `__tests__/DataTableSummaries.test.ts`; the rendered footer,
  alignment and axe are in `__tests__/DataTable.test.ts`.
