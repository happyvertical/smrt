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
| Refund zero-tax recovery boundary | Zero charged and zero recovered accepted | Negative recovery against zero tax rejected by setter and save; persisted facts unchanged | Same tenant author | Bound collection database; retry after correction | SQLite/PostgreSQL | Exact magnitude bound includes zero | Regression integration S/P |
| Named third-party payer save | Name persists without employee reimbursement | Missing name, incompatible profile/name, reimbursable rejected; company/person unchanged | Same tenant expense author | Bound database | SQLite/PostgreSQL | New enum explicit, unknown rejected | Integration S/P |
| Refund source save | Negative refund references positive same-owner/currency source | Self, missing, cross-tenant/global, currency mismatch, refund-of-refund rejected | Active tenant × same/foreign/global resource | Lookup uses same database executor; transaction rollback and retry | SQLite/PostgreSQL | No settlement or cumulative refund entitlement inferred | Integration S/P |
| Reviewed facts save/reopen/review | Reopen, correct, review permitted | Direct financial/payer/refund mutation and mutation alongside reopen rejected; failed save preserves persisted row | Consumer review method; existing authorization contract unchanged | Revision-guarded single-row save; transaction rollback | SQLite/PostgreSQL | Existing closed generated surface retained | Integration S/P |
| Reviewed refund roll-up | Signed gross totals and commitment drawdown count source/refund once, retained basis does not replace legacy amount | Existing cross-currency/tenant commitment denials remain active | Same tenant reviewer | Bound collections and revision-guarded saves | SQLite/PostgreSQL | Existing aggregate semantics preserved | Integration S/P |
| Additive schema migration | Existing row retains amount and absent financial facts; repeat migration no-op | Live parity and column types asserted | Schema operator, no end-user authorization | Public dbMigrate migration path | SQLite/PostgreSQL | Existing deployed schema upgraded | Migration S/P |

Additional gates: package typecheck, build, browser harness; root combined release
validation and exact-head review belong to the coordinator. Original additive
feature rows do not require a bug-fix comparison; the zero-tax correction has
explicit failing-base evidence below. No network provider is
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


## Zero-tax refund correction

The added regression fails against feature commit `08a791a93`: a refund with
subtotal/total -100, tax 0, and recoverable tax -1 was accepted. Comparing exact
BigInt magnitudes fixes the bound without changing the sign requirements.
The shared regression also rejects raw-save bypass, verifies stored facts are
unchanged after failure, and permits retry with zero recovery. Evidence is in
`zero-tax-base.log` (expected failure), `zero-tax-test.log`,
`zero-tax-postgres.log`, `zero-tax-typecheck.log`, and `zero-tax-build.log`
under the evidence directory above.
Final correction validation: 62 backend + 15 UI tests and 56 PostgreSQL tests
passed, including both migration lanes. The unchanged browser contract retains
the 11-pass evidence above.


## Inbound refund source invariant — review thread 4243223180

Risk remains high (financial relationship mutation). Baseline is release
`d372e2df68f1000bbfccb9dbe88afcd7d78ece9b`. Execute before/after evidence for
the new regressions; the existing per-row revision guard alone cannot protect a
source/refund pair from concurrent edits.

| Behavior / reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Source save with inbound refunds | Unrelated edits and positive same-currency corrections remain valid; unreferenced sources remain editable | Zero amount, changed currency, or conversion to refund refused; source and reviewed refund unchanged | Same owner, source unreviewed or reopened, refund reviewed | Bound transaction; existing revision CAS retained | SQLite/PostgreSQL | Refund source eligibility preserved in both directions | Shared integration S/P |
| Inbound lookup ownership | NULL owner and tenant-owned references enforced outside context too | Malformed foreign-owner inbound fixture must not block another tenant; ordinary cross-tenant creation remains refused | Active tenant / no context × own / foreign / global | Public projected list with owner predicate, existing refund FK index | SQLite/PostgreSQL | No cross-tenant lookup bypass or existence disclosure | Shared integration S/P |
| Caller transaction affinity | Guard sees uncommitted inbound refund; valid retry after rollback | Invalid source edit rolls back sibling refund mutation; original rows remain valid | Same tenant author | Existing public nested transaction and withDatabase APIs | SQLite/PostgreSQL | No independent root transaction or partial commit | Shared integration S/P |
| Source/refund concurrent save | Winner preserves eligible persisted relationship | Refund-first blocks source edit; source-first makes later refund fail on current source | Same tenant, distinct real connections | Ordered PostgreSQL row locks held from validation through commit; SQLite write transaction serialization | PostgreSQL interleaving plus shared SQLite atomicity | No blanket source freeze or settlement limits | Real-PG integration P |
| Stale repeatable-read source snapshot | Fresh same-currency positive edit succeeds | Snapshot pinned before independent refund commit; stale currency edit aborts serialization; fresh invalid edit rejects | Same tenant | Public source revision claim in refund transaction | PostgreSQL REPEATABLE READ | No missed committed refund under stale snapshot | Real-PG integration P |

The source revision advances atomically on a new/changed refund link through the
public revision API, including rollback with a caller transaction. Source
instances loaded before linking must be reloaded for subsequent valid edits.

Reproduction evidence in the external `inbound-refunds/` directory: baseline
SQLite fails all four new shared regressions, baseline PostgreSQL fails those
four plus both writer-order cases. Row locks without a source revision claim
also fail the repeatable-read regression (`base-rr.log`). The corrected focused
runs pass four SQLite and seven PostgreSQL cases (`fixed-sqlite.log`,
`fixed-postgres.log`). Final committed-head package build, full test, PostgreSQL,
typecheck, and browser commands are recorded with HEAD and exit status in
`validation-records.json` and their named logs in that same evidence directory.


## Exact refund positions (#4070)

Risk: high — cumulative financial reversals and concurrent edits. The shared
SQLite/PostgreSQL suite covers partial/full/excess cash reversals (including
rejected rows), independent subtotal/charged/recovery/nonrecoverable caps, exact
component identities, signed residuals, unknown legacy/partial facts, source
corrections, refund edits/reparenting, and rollback of refund plus source revision.
PostgreSQL additionally proves stale sibling amount and financial-facts edits
abort under REPEATABLE READ, then fail the appropriate cap on a fresh retry.
No missing financial facts are synthesized. A former freeze fixture now uses a
source gross sufficient for its refund and retains known linked facts after
reopen: clearing them would erase already-proved reversal bounds.

Focused commands: `pnpm --filter @happyvertical/smrt-expenses exec vitest run
src/__tests__/expenses.test.ts`, the same PostgreSQL optional test through
`scripts/run-with-ci-postgres.mjs`, and owning-package `tsc -p tsconfig.json
--noEmit`. External receipts: `/home/will/Work/tmp/tc-mvp-20261016/expense-refund-caps/`.
Coordinator owns combined prerequisites, release validation, and review.

## Refund cash direction and reimbursement positions (#4073)

Risk: high — retained payment amount, liability/receivable direction, additive
schema migration, and recipient-vs-payment concurrency. Shared SQLite/PostgreSQL
cases prove company receipts preserve gross personal claim, person receipts
reduce it, exact full-remaining payment is retained independently of economic
cost basis, later personal receipt creates a separate company receivable,
unknown/other-person recipients and historical missing paid amounts remain
unknown, direct overwrite/source-claim rewrite fail closed, recipient review
freeze/shape apply, and caller rollback restores an unpaid claim. PostgreSQL
pins a REPEATABLE READ reimbursement before an independent recipient correction
and requires serialization rejection, followed by exact fresh payment. Existing
service-backed permission tests run unchanged; optional expected amount remains
behind the same authorization. Migration verifies new fields stay null on legacy
rows; no historical payer or paid cash is inferred.

Focused evidence: `/home/will/Work/tmp/tc-mvp-20261016/expense-reimbursement-position/`.
No worker broad build/suite/review/PR; coordinator owns combined release gates.

## Explicit third-party refund recipients (#4082)

Shared SQLite/PostgreSQL cases retain exact bounded third-party source names,
refuse blank/malformed/overlong names and extra fields, persist/reload guarded
JSON and preserve reviewed provenance. Recipient edits claim the source revision;
caller rollback restores both evidence and revision. Person reimbursement with
third-party cash receipt returns unknown-third-party-recipient, nullable cash
positions and retained actual paid cash; it cannot infer company income, person
payment or settlement. An exact source name is evidence, not verified customer
identity. Existing company/person and unknown legacy cases remain covered.
