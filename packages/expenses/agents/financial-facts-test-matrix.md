# Expense financial facts test design (#3792)

Risk: high — persisted financial mutation, tenancy, reviewed immutability, and
schema migration. Synthetic data only. Scope is source facts, not tax law or
settlement. Existing generated mutation surfaces remain closed.

All integration rows run in the shared expense behavior suite on SQLite and
PostgreSQL, using the caller-bound database executor and active tenant. Commands:
`pnpm --filter @happyvertical/smrt-expenses test` (S),
`pnpm --filter @happyvertical/smrt-expenses test:postgres` (P).

| Behavior / reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Optional source facts through create/save/load | Legacy amount roundtrip has no breakdown or inferred basis; explicit facts survive reload | Unknown keys, malformed JSON/types/currency, mismatched total/sign, duplicate component, overflow rejected | Consumer with same active tenant | Bound collection database, no multirow mutation | Node SQLite/PostgreSQL | Optional missing facts; unknown values fail closed | Integration S/P |
| Exact basis through getCostBasis | Partial recovery and negative refund exact minor units | Unsafe numbers and inconsistent recovery rejected | Consumer reading source facts | Pure synchronous calculation; N/A transaction (no writes) | Node plus persisted roundtrip both dialects | Structural typed result usable without dependency | Unit/integration S/P |
| Named third-party payer save | Name persists without employee reimbursement | Missing name, incompatible profile/name, reimbursable rejected; company/person unchanged | Same tenant expense author | Bound database | SQLite/PostgreSQL | New enum explicit, unknown rejected | Integration S/P |
| Refund source save | Negative refund references positive same-owner/currency source | Self, missing, cross-tenant/global, currency mismatch, refund-of-refund rejected | Active tenant × same/foreign/global resource | Lookup uses same database executor; transaction rollback and retry | SQLite/PostgreSQL | No settlement or cumulative refund entitlement inferred | Integration S/P |
| Reviewed facts save/reopen/review | Reopen, correct, review permitted | Direct financial/payer/refund mutation and mutation alongside reopen rejected; failed save preserves persisted row | Consumer review method; existing authorization contract unchanged | Revision-guarded single-row save; transaction rollback | SQLite/PostgreSQL | Existing closed generated surface retained | Integration S/P |
| Reviewed refund roll-up | Signed gross totals and commitment drawdown count source/refund once, retained basis does not replace legacy amount | Existing cross-currency/tenant commitment denials remain active | Same tenant reviewer | Bound collections and revision-guarded saves | SQLite/PostgreSQL | Existing aggregate semantics preserved | Integration S/P |
| Additive schema migration | Existing row retains amount and absent financial facts; repeat migration no-op | Live parity and column types asserted | Schema operator, no end-user authorization | Public dbMigrate migration path | SQLite/PostgreSQL | Existing deployed schema upgraded | Migration S/P |

Additional gates: package typecheck, build, browser harness; root combined release
validation and exact-head review belong to the coordinator. This is an additive
feature, so bug-fix base regression comparison is N/A. No network provider is
introduced: upstream provider failure is N/A. Refund lookup failure is tested.

## Executed release evidence

Executed on Node 26.10.0 / pnpm 11.25.0, with SQLite and PostgreSQL. All
behavior rows above run in the shared suite; PostgreSQL additionally checks
native column types and live parity. Both migration fixtures start from the
previous expense schema, preserve a seeded legacy row, exercise the migrated
refund FK's RESTRICT behavior, and prove repeat migration is a no-op.

- `test`: 61 backend tests and 15 UI tests passed. The optional PostgreSQL file
  is deliberately skipped here and executed by its dedicated command.
- `test:postgres`: 55 passed; no skipped tests.
- `test:e2e`: 11 passed using the supported system Chromium, including native
  submissions without JavaScript.
- Package build, typecheck (including Svelte), and scoped Biome checks passed.
- SQLite migration requires the generic new nullable FK column fix in #3795;
  the initial executable failure and passing dependency-head run are retained.

Full output is retained outside the checkout under
`/home/will/.local/state/happyvertical/tradeschief-277-release1/expenses/`:
`test-final.log`, `postgres-final-with-core.log`, `e2e.log`,
`package-build.log`, `typecheck-delivery.log`, `lint-final.log`, and
`core-build.log`. Initial diagnostic runs remain there for failure provenance.
The redundant whole-workspace build was stopped to reduce memory contention;
the coordinator owns the final combined root gates and exact-head review.
