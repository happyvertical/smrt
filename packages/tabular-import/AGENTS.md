# @happyvertical/smrt-tabular-import

The deterministic half of "build an app from a workbook" (#4969). A model,
elsewhere and later, proposes an `ImportPlan`; this package validates it,
checks it against the workbook, loads the data through an `ImportTarget`, and
proves the result. Two products implement the target, so nothing here may
name either. No `@smrt()` objects, no tables, no Svelte.

## Entries

- Root: browser-safe and pure. Imports `@happyvertical/spreadsheets` and
  `@happyvertical/sql/query` only, never the sql root or a `node:` built-in
  (`browser-safe.test.ts` walks and bundles the graph).
- `/testing`: Node-only `createSqliteReferenceTarget()`, real in-process SQLite
  through `@happyvertical/sql`. Calculated fields are generated columns made
  by `renderExpression`, so they run on database semantics. Never import it
  from the root entry.

## Source map

- `plan.ts`: `validatePlan` (closed shapes, JSON-cloned input, limits),
  `loadOrder`. Calculated expressions may read column fields only.
- `coerce.ts`: `coerceCell`, the one typing rule. Nothing is guessed.
- `evaluate.ts`: reads and types every table; shared by `checkPlan` and
  `planLoad`. A row that fails never reaches a record.
- `checks.ts`: `checkPlan` (before writing) and `checkLoaded` (after).
- `load.ts`: `admit` (limits) and `planLoad` (ordered, batched records).
- `run.ts`: `runImport`. Adapter errors propagate; it catches nothing.

## Invariants

- First import only: `runImport` refuses a target that has any planned table
  (`target-not-empty`). Re-import matching is a later slice.
- `checkPlan` errors stop the run before `describe()` is called; nothing is written.
- `DEFAULT_MAX_CELLS` (250,000) is PROVISIONAL, owner decision pending; keep it
  one constant. Per-table rows default to 10,000.
- Money is integer minor units (`value * 10^scale`, within 1e-6 of an integer or
  refused). Integer sums are exact (BigInt); number sums are compensated.
- `distinct` tables skip the unmapped-column warning: they extract columns by design.
- Work is bounded: evaluation visits occupied rows and mapped columns only, never
  range width x height, and spends from `maxWork` (`DEFAULT_MAX_WORK`); over it,
  `work-over-limit`. Row indexes live for one evaluation call, never across calls:
  a workbook is mutable and is re-read every time.
- `checkLoaded` value-checks every calculated integer, money and number field
  (`calculated-invalid`: not a whole safe integer / not finite) with or without a
  `cachedColumn`. Integer and money comparisons are exact; tolerance is for `number`.
- `ok:false` after a load is a verdict, not a repair: the caller discards the draft
  target. There is no rollback or recreation logic here.
- Findings keep at most 20 examples per (code, table, field) with a total `count`.
- Plan keys are `^[a-z][a-z0-9_]{0,62}$`; SQL keywords are fine, names that exist
  on every object (`constructor`, `prototype`, ...) are refused. The reference
  target quotes every identifier.

## Validation

`pnpm --filter @happyvertical/smrt-tabular-import build|typecheck|test`.
Tests build workbooks in code with the SDK's `createWorkbook`/`createSheet`;
no binary fixtures, no containers.
