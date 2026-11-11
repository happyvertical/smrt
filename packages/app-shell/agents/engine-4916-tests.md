# Engine #4916 test design

All mutations run as the single app owner in Node 26, in-process SQLite through
one migration transaction. No external service or dialect is supported by this
engine. New feature work has no bug-fix base regression comparison.

| Behavior / invariant | Reachable trigger / positive | Failure / negative | Executor / external edge | Level / command |
|---|---|---|---|---|
| Calculations | add/set/clear, rename, undo, restart, draft publish | unknown/hidden input, generated dependency/cycle, wrong type, supplied writes | core validator + VIRTUAL DDL; REST/tools/methods | engine / package test |
| Reports | define/replace/rename/remove, monthly sum/filter/calculated value/reference names, frozen and draft run | hidden/foreign field, bad spec, row/time bounds | reports compiler/runner; app-only allow-list; worker timeout | engine + server / package test |
| Bulk | 10,000 rows, lookup references, key upsert, exact undo, publish replay | bounded input, rejected/ambiguous/missing lookup, atomic rollback | migration transaction; same coercion as records; archived originals | engine / package test |
| Extract | new/existing target, optional folding, empty values, undo/publish | ambiguous target, dependent field, undo with new references | migration transaction + row archive | engine / package test |
| Merge | chosen values, references from two models, exact undo/publish | invalid ids/field selector, always approval, atomic rollback | migration transaction + row archive | engine / package test |
| Policy | new catalog calls reach explicit target; owner allowed | non-owner denied, live risky call only creates Approval, frozen refuses structure | existing policy/builder/approval boundary | server + invariant / package test |
| Recovery | restart after successful change, injected transaction failure preserves data and version | failure during migration and persistence | existing worker swap/store compensation | engine / package test |

Validation: `node /Users/will/.local/bin/pnpm --filter
@happyvertical/smrt-app-shell test` and `typecheck`; root `lint`, `format-check`,
`knowledge:check --strict --format markdown`. Narrow Vitest cases run while
implementing. Exact executed evidence is recorded in the final local handoff.
