# @happyvertical/smrt-tabular-import

Turns a spreadsheet into records without guessing. A plan says which sheet
range becomes which table, which column becomes which typed field, and which
fields are calculated or point at another table. This package validates the
plan, checks it against the workbook before anything is written, loads the data
in batches through a target you provide, and then reads the target back to
prove nothing was lost or changed.

It does not decide what the plan is (a person or a model does that) and it does
not know where the data goes (your target does). Nothing here is tied to a
product, a database or an s-m-r-t model layer.

## Installation

```bash
pnpm add @happyvertical/smrt-tabular-import
```

## Usage

```ts
import { getSpreadsheets } from '@happyvertical/spreadsheets';
import { runImport } from '@happyvertical/smrt-tabular-import';

const workbook = await (await getSpreadsheets({ type: 'xlsx' })).read(bytes);

const result = await runImport({
  plan, // validated for you; a bad plan throws ImportPlanError
  workbook,
  target, // your ImportTarget
});

if (!result.ok) console.table(result.findings);
```

`runImport` validates the plan, refuses a workbook over the size limits, runs
`checkPlan`, refuses a target that already holds a planned table, builds the
structure, loads every batch, and runs `checkLoaded`. If `checkPlan` reports
errors nothing is written. Errors thrown by your target are never caught.

### Typing

Every cell is typed by one rule (`coerceCell`) and refused when it does not fit:
integers must be safe whole numbers, money must be an exact number of minor
units, booleans accept true/false/yes/no/y/n/1/0, dates become `YYYY-MM-DD`,
choices must match exactly, and error cells are always refused with their
Excel text. Long digit strings and values with leading zeros in number fields
are reported as `digits-as-number`: they are identifiers, so map them as text.

### Checks

`checkPlan` reports findings (`coerce-failed`, `digits-as-number`,
`lookup-key-not-unique`, `lookup-key-blank`, `reference-unresolved`,
`unmapped-column`, and structural ones) with the cell and row, at most 20
examples per code, table and field plus a total `count`. It also returns facts:
rows read, skipped and planned per table, and column sums.

`checkLoaded` compares the target with those facts: row counts, column sums,
and, for every calculated field with a `cachedColumn`, the target's value
against the workbook's cached result, row by row. That is how a translated
formula is proven.

If `ok` is false after a load, the target holds a draft that failed its proof:
discard it. This package does not undo or recreate anything.

### Targets

Implement `ImportTarget` (`describe`, `applyStructure`, `load`, `count`, `sum`,
`values`). `load` resolves references by lookup key and is all-or-nothing per
batch. The target keeps each record's `sourceRow`.

For tests there is a reference target on real in-process SQLite:

```ts
import { createSqliteReferenceTarget } from '@happyvertical/smrt-tabular-import/testing';

const target = await createSqliteReferenceTarget();
```

The `/testing` entry is Node-only; the root entry is browser-safe.

### Limits

Workbooks over 250,000 cells or tables over 10,000 rows are refused before any
row is read (`admit`). The cell limit is provisional. Reading is bounded by
occupied cells, not range size, and by a work budget (`maxWork`, refusal
`work-over-limit`). Plans are bounded too:
200 tables, 500 fields per table, 2 MB of JSON; all can be raised through
`validatePlan(plan, limits)`.
