# Invoice rounding behavior-to-test matrix

Named high-risk trigger: canonical financial persistence, tenant authorization and immutable historical monetary snapshots. The executable contract is maintained in `src/__tests__/invoice-rounding.test.ts`, `src/__tests__/invoice-rounding.optional.test.ts`, and `e2e/invoices/invoice-rounding-model.spec.ts`. Optional PostgreSQL cases run through the maintained `test:postgres` discovery. Full package model/UI, PostgreSQL, browser, build and type gates remain the release requirement.

|Behavior|Reachable trigger|Positive|Negative|Actor/context|Executor/transaction|Runtime/dialect|External edge|Level|Command|
|---|---|---|---|---|---|---|---|---|---|
|Explicit policy, legacy history|backend opts draft into explicit authorized tenant policy|two10@5 => tax1,total21; unset=>2,22|unknown/missing algorithm, malformed policy, policy change after freeze rejected|authorized tenant / same invoice|parent revision + transaction|SQLite/PostgreSQL|policy JSON/version and shared calculator|native model + pure|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Allocation conservation/readback|save/reload/report line and header|stable-ID residual 1,0; all sums21|forged allocated tax/amount cannot persist|same tenant|same executor all siblings/header|SQLite/PostgreSQL|cost-billing calculator, model getters/export|native integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Draft mutation atomicity|insert/edit/delete including last line|all siblings/header recalc, last=>0|injected sibling/header failure rolls back; stale revision rejected|authorized editor|one parent claim and transaction|SQLite/PostgreSQL|collection/model save/delete|native integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Tenant isolation|explicit policy/mutation with actor/resource context|tenantA owns invoice+all lines|tenantB/global mismatch, forged parent, reparent denied|actor A/B/system with explicit context|tenant-aware collections + transaction|SQLite/PostgreSQL|generated create/update and backend policy method|native integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Freeze/history|first SENT or recognized invoice|policy/source/allocations retained; payment-only updates work|line insert/edit/delete/policy change rejected after freeze|authorized invoice actor|persisted prior state, not memory|SQLite/PostgreSQL|status machine, revenue recognition|native integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Payment/journal agreement|allocate21 / recognize revenue|cap21, AR21 revenue20 tax1|allocate22 fails atomically; stale/forged header fails|same-tenant customer/currency|existing allocation transaction / journal compensation|SQLite/PostgreSQL|payments/ledgers|native integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Mixed/exempt/discount arithmetic|explicit scope with multiple rates, discounts, fractional quantity|shared browser/server/model totals equal and permutation stable|unsafe amount/rate/malformed ids rejected|authorized invoice editor|pure calculate then persisted transaction|browser + Node SQLite/PostgreSQL|invoices + cost-billing exports|pure/native/browser|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|
|Migration|existing prefeature schema and rows|adds storage idempotently with no historical repricing|partial migration failure rollback; malformed stored snapshot fail closed|maintenance owner|explicit migration transaction|SQLite/PostgreSQL; DuckDB storage only if supported|public migration API/schema|migration integration|Targeted Commerce Vitest; full package test/test:postgres; invoice browser gate where applicable|

DuckDB complete Commerce model persistence is currently unsupported by existing ON UPDATE CASCADE schema contract (agents/invoice-quantity.md); do not weaken constraints. Credit lifecycle and retention are outside3818; signed calculator behavior is reused, not a new credit issuance contract. Provider-tax coexistence is explicitly rejected; the permanent freeze begins at the first non-draft save or earlier revenue recognition and survives payment reversal.

Additional executable boundaries: internal post-allocation failure rolls back and
retries the same line instance; independent PostgreSQL handles serialize parent
writes; generated writable allowlists exclude policy, allocations and frozen
history; generic accounting exports reject unsupported invoice allocation rather
than silently requesting per-line provider rounding. The old-schema migration
and an enclosing maintenance-transaction rollback are native dialect tests.

The two-10-at-5 historical/default case remains executable alongside the opt-in
case: it establishes 22 versus 21 without modifying legacy rules. This is an
additive feature, not a change to the existing calculator's correct line scope.
Browser/server shared entry tests assert the same 20/1/21 amounts as native model
roundtrips. Credit lifecycle and external provider posting are intentionally not
implemented by this feature.

Policy-selection authorization remains available on the same model instance if a
caller-owned transaction aborts after `save()`: repeating the authorized save
succeeds without inventing a new policy selection. Invalid revenue monetary
prerequisites (including missing required tax account) fail before the permanent
freeze is written. Both cases have native SQLite/PostgreSQL regressions; captured
pre-fix failures accompany the review evidence.

Review regressions cover active tenant-B insertion against tenant-A frozen history,
same-tenant context creation without an explicit tenant field (and explicit
mismatch rejection), and successful freeze followed by outer transaction rollback
and same-instance retry. Each runs on SQLite and maintained PostgreSQL discovery.
