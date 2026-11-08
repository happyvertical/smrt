# Reviewed expense allocations (#4746)

Risk: **high** — public financial contract, tenant authority, concurrent monetary
reservations and issued invoice lineage. The integration coordinator owns full
release validation and independent review; worker evidence is narrow only.

All rows exercise real persistence. Commands: `pnpm --filter
@happyvertical/smrt-expenses exec vitest run allocation` (SQLite), then the
package PostgreSQL lane at integration. DuckDB is not a declared expense release
lane; its status must be explicitly assessed before release. No provider writes.
New feature: base-fail comparison is N/A (no allocation API exists on base).

| Behavior / reachable trigger | Positive | Negative / failure | Actor/context | Executor / transaction | Runtime/dialect | Contract edge / level |
| --- | --- | --- | --- | --- | --- | --- |
| Review split | 100 → 60/40, reload, one receipt graph | zero/fraction/unsafe/duplicate keys/unknown fields, wrong sum | tenant reviewer | source row lock + revision CAS, all children same tx | SQLite/PostgreSQL | strict public input; integration |
| Current authority | every old and new target authorized | foreign tenant, revoked actor/grants, denied second target | ambient authenticated actor × owner × active tenant | callback receives bound executor | SQLite/PostgreSQL | required host callback; integration |
| Retry/concurrency | identical key returns same UUIDs | changed payload conflict; stale source; concurrent competing revisions | same tenant reviewer | lock then CAS; caller retry whole tx | SQLite/PostgreSQL | idempotency contract; integration |
| Atomicity | caller commit persists all | throw after first portion; outer rollback leaves no head/children | authorized reviewer | caller-owned executor | SQLite/PostgreSQL | injected failure; integration |
| Immutable revisions/source | unbilled supersession preserves history | direct save/delete, source review/money/tenant rewrite | owner and foreign actor | revision/head atomic | SQLite/PostgreSQL | guarded models; integration |
| Totals and accounting | global 100, targets 60/40; commitment100 once | source never added to portions, no partial remainder | current tenant | same bound executor reads | SQLite/PostgreSQL | legacy unsplit APIs; integration |
| Refund/reimbursement/reporting | source cash/tax facts count100 once, separate refund follows existing model | no allocated source review/money rewrite; refund capacity unchanged | tenant owner | source locks/CAS preserved | SQLite/PostgreSQL | original source remains accounting authority; integration |
| Canonical billable identity | portion resolves target/source/fingerprint/currency; reserve once | foreign/missing line, wrong tenant/target, reused portion | current tenant billing actor | source+invoice lock/CAS; reservation atomic | SQLite/PostgreSQL | public invoice/line contract; integration |
| Billed lineage | draft release then supersede; issued reservation retained | issued release/rewrite and supersede blocked | current tenant billing actor | bound transaction | SQLite/PostgreSQL | immutable issued snapshot; integration |
| Generated surface / migration | new tables/FKs/indexes; old rows unsplit | direct generated CRUD absent | no actor transport surface | real generated schema | SQLite/PostgreSQL | closed API/MCP/CLI; integration |

UI/browser N/A: no new user interface. External provider failure N/A: allocation
records local evidence and performs no external execution.

## Invoice binding extension (captured before its implementation)

Commerce owns only a nullable guarded `InvoiceLineItem.sourceReservationId`
pointer. The expense reservation remains the single capacity authority. A host
may reserve against its own draft, then bind the same reservation UUID to one
commerce line. Trusted package registration allowlists the `billable:` qualified
source type; client strings never dispatch arbitrary model methods.

| Behavior / trigger | Positive | Negative / failure | Actor/context | Executor / transaction | Runtime/dialect | Contract edge / level |
| --- | --- | --- | --- | --- | --- | --- |
| Host-draft bridge | reserve once, later bind same UUID | second capacity claim, two concurrent bind targets | ambient reviewer + host draft/invoice authority | source lock/CAS, unique `(relatedReservationId,kind)`, same executor | SQLite/PostgreSQL | public compose API; integration |
| Commerce pointer guards | authorized bind then issue | direct pointer assignment, old-pointer clearing with source namespace change, clone/duplicate, model and collection delete, cascading invoice deletion | active tenant | document lock, owning reservation checks | SQLite/PostgreSQL | existing public mutations; integration |
| Missing capability | registered protected type resolves | unknown/missing handler; unbound protected line at issue | active tenant | same issue transaction | SQLite/PostgreSQL | fail-closed protocol; integration |
| Withdrawal | release + pointer removal then supersede | issued release, rollback after release before unbind | host current authority | one source/invoice transaction, immutable event history | SQLite/PostgreSQL | no second ledger; integration |

Initial SQLite evidence: allocation-fourth.log (6/6); extended billing first run
allocation-billing-first.log (8/8). These are worker evidence, not release gates.

## Dialect assessment evidence

Existing package AGENTS validation defines SQLite and migrated PostgreSQL lanes;
its supplier-payable matrix explicitly uses Node26 SQLite+PG. No explicit
DuckDB compatibility promise was found in the owning README/AGENTS. A real
DuckDB graph bootstrap was attempted: `allocation-dialects.log` records failure
before allocation behavior on the existing
`_smrt_billing_accounts.customer_id ON UPDATE CASCADE` relationship. Core
`schema/foreign-key-planner.ts` deliberately refuses that unsupported DuckDB
contract and directs callers to PostgreSQL/SQLite. This diagnostic is preserved;
no FK/schema weakening or alternate toolchain was used. It does not constitute
DuckDB execution evidence for allocations, and release review must reconcile the
supported-dialect contract rather than claim universal compatibility.

| Additional bounded contract | Positive | Negative/failure | Context/actor | Executor | Dialect/runtime | Validation |
| --- | --- | --- | --- | --- | --- | --- |
| Source privacy by action | full review source grant; bounded billing context | denied original source even when destinations allowed | real ambient review actor; callback action review/reserve/bind/release | caller bound | SQLite/PG Node26 | allocation shared suite |
| Read authority | actual expenses.read + host target grant | read-only principal cannot reserve/review; source privacy denial does not hide own bounded portion | read actor × own target | same scoped DB | SQLite/PG Node26 | allocation shared suite |
| Exact economic attestation | known zero-tax gross basis60, company category only | unknown/recoverable/refunded basis stays null; refunded new bill denied | target-authorized reader/biller | source lock/CAS for mutation | SQLite/PG Node26 | allocation shared suite |

## Explicit unbilled withdrawal (before implementation)

High-risk financial/tenancy/contract continuation. Withdraw is not a billed
reversal and never releases claims implicitly. Public input includes exact source
revision, expected active allocation revision, request key and audit evidence.

| Behavior / trigger | Positive | Negative/failure | Actor/context | Executor/atomicity | Dialect | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Unbilled withdrawal | released draft claim → audited withdrawal → reopen/amount correction or duplicate rejection | active reserved/bound/issued capacity refuses; no auto-release | source-private reviewer + ALL old target grants + mandatory restored-unsplit destination grant | source lock/CAS, same caller executor, immutable event + null head in one transaction | SQLite/PG shared suite | narrow allocation command |
| Retry/concurrency | identical replay reauthorizes and returns same audit UUID | changed payload/key collision, stale active/source revisions, competing withdrawals | current actor/source/old targets/restored destination | unique request, unique predecessor successor; source CAS | SQLite/PG | shared feature proof |
| Atomic reporting | source100 returns once to unsplit target; commitments/global totals unchanged | injected failure after audit insert leaves old head/targets, caller rollback restores all | same tenant | no transient committed source+portion cost | SQLite/PG | shared real persistence |
| History after correction | next review links latest withdrawal deterministically; old portion facts remain immutable across source edits/reject/reopen | foreign/revoked old/restored target denies, ambiguous chain fails closed | bounded old-target reader vs full source editor | immutable relational predecessor chain; typed revision source snapshot | SQLite/PG | shared lineage/reload proof |

New API absent on prior source is feature baseline N/A for existing API
regression, but executable absent-command/blocked-correction evidence is captured.
No provider writes, browser/UI N/A; root owns PG/fullvalidation/review.
