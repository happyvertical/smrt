# @happyvertical/smrt-sales

Modular sales: provider-neutral agreement execution, CRM, referral intake, a neutral commissions financial core, and reusable Svelte surfaces. One installable package with distinct subpath exports:

- `@happyvertical/smrt-sales/agreements`
- `@happyvertical/smrt-sales/crm`
- `@happyvertical/smrt-sales/referrals`
- `@happyvertical/smrt-sales/commissions`
- `@happyvertical/smrt-sales/svelte`

The root export re-exports every TS module. `agreements` depends on the provider-neutral `@happyvertical/signatures` contract and `smrt-assets`; provider credentials stay in the injected SDK adapter/secret store. `referrals` binds its versioned terms to `agreements`.

## Validation

Run `pnpm --filter @happyvertical/smrt-sales test` and `pnpm --filter @happyvertical/smrt-sales typecheck` for package changes. PostgreSQL-sensitive changes must also run `pnpm --filter @happyvertical/smrt-sales test:postgres`; the command uses the repository's disposable PostgreSQL harness and is registered in the PostgreSQL CI shard.

## Roles vs. money

Referrers and Sales Representatives are **distinct roles** and stay that way. Both connect to money through one neutral financial account:

- **Earner** (commissions): payout identity — method, threshold, currency, status. Referenced by every Commission and CommissionPayout.
- **SalesRepresentative** (crm) and **Referrer** (referrals): role models, each holding `profileId` (cross-package string ref to smrt-profiles) and `earnerId`.

## Modules

Per-module semantics live in sibling module docs — read the one for the module
you are editing. This file keeps what holds in every module.

| Module | Scope | Module doc |
|---|---|---|
| `agreements` | verified execution evidence — private orchestration state, append-only provider events, immutable executed agreements, and the provider-neutral execution service | [agents/agreements.md](agents/agreements.md) |
| `commissions` | the neutral financial core — earners, versioned plans, earning events, commissions, adjustments, balances, and payout settlement | [agents/commissions.md](agents/commissions.md) |
| `crm` | leads, configurable pipelines, opportunities, tenant-safe Lead follow-up, activity trail, and idempotent conversion links | [agents/crm.md](agents/crm.md) |
| `referrals` | referrers, programs, versioned attribution policies, links/touches, referrals, exception review, and term snapshots | [agents/referrals.md](agents/referrals.md) |
| `svelte` | props-driven presentational surfaces for CRM, the referrer portal, and operator review | [agents/svelte.md](agents/svelte.md) |

## Currency

**All monetary fields are integer cents** with `*Cents` suffixes; that scale is a Sales contract, not an implicit framework currency rule. Fresh PostgreSQL/DuckDB INTEGER columns are BIGINT, while JavaScript hydration rejects values outside the safe-integer range. Rates are decimal (`0`–`1`). Rounding happens once per calculation step via `roundCents()` (half-away-from-zero) and every Commission stores its `calculationTrace` so amounts are reproducible. Convert at display/commerce boundaries with `centsToAmount()`/`amountToCents()`.

## Tenancy

Business/domain models are generally `@TenantScoped({ mode: 'optional' })` with `@tenantId({ nullable: true })`. This deliberately departs from legacy smrt-affiliates (which was cross-tenant by design for ad networks): sales programs, earners, and payouts are tenant-owned, while `tenantId: null` remains available for intentional global/operator-level rows. Immutable tenant-bound execution evidence (`AgreementExecution`, `AgreementExecutionEvent`, `ExecutedAgreement`) and private orchestration fences (`CommissionAdjustmentOperation`) instead use required tenancy with a non-null owner; never weaken those rows to optional tenancy.

## Cross-package references (plain strings)

`profileId` → smrt-profiles Profile; `invoiceId` (CommissionPayout) → smrt-commerce Invoice; agreement artifacts → smrt-assets Asset ids. No static imports of unrelated sibling domain packages.

## smrt-affiliates migration

`@happyvertical/smrt-affiliates` is now a deprecated compatibility package that re-exports this package's commissions core under the legacy names (`Partner` → `Earner`, `Payout` → `CommissionPayout`, `Commission`, collections, enums) with `@deprecated` guidance and **no duplicate persistence model**. The data/API mapping lives in `packages/affiliates/MIGRATION.md`.

## Gotchas

- **Cents vs. rates**: `*Cents` fields are INTEGER (`= 0` defaults); `rate`/`probability`/`shareFraction` are DECIMAL (`= 0.0` defaults). Don't mix the two conventions on one field.
- **Optional same-package foreign keys use null**: execution, supersession, earning-event, and payout references that are absent persist as `null`, never `''`; their physical database constraints remain enabled when a real id is present.
- **Versioned terms are rows, not edits**: CommissionPlan / AttributionPolicy / ReferralAgreement amendments insert `version + 1`; active versions are save-guarded immutable.
- **Idempotency is dedupeKey-based**: EarningEvent, Commission, and CommissionPayout carry natural keys (`conflictColumns`) — retried ingestion/settlement upserts instead of duplicating.
- **Adjustments never rewrite**: correcting an earned/paid Commission means appending a CommissionAdjustment, not editing the Commission.
- **Adjustment retries use the service**: CommissionAdjustment has no public operation field and rejects an untyped `operationId` constructor option; ordinary legacy creates without one remain compatible. `CommissionAdjustmentService` transactionally claims the private operation fence with insert-on-conflict-no-op, creates the explicit mapped adjustment id only for the winner, then verifies the persisted intent; the same globally unique operation UUID cannot be reused by another tenant.
- **Manifest objects must remain root-importable**: generated consumer registration imports every manifest-advertised model and collection from `@happyvertical/smrt-sales`. The `CommissionAdjustmentOperation` and `ReferralClickOperation` model/collection values are therefore root and owning-subpath exports for runtime loading, while their `api: false`, `mcp: false`, and `cli: false` decorators keep them off generated application surfaces. Publish-pack validation imports the actual CLI-generated register against the packed tarball.
- **CommissionPayout, not Payout**: avoids the pre-existing global table-name collision between commerce `Payout` and legacy affiliates `Payout` (`payouts`).
- **Table names are global**: new models were named to avoid collisions across packages (`commission_payouts`, `sales_activities`, `attribution_policies`, …).
- **Svelte module is svelte-check-gated**: no runtime component tests; `typecheck` runs `svelte-check` via `scripts/svelte-check-a11y.mjs`. Ship raw `.svelte` via `svelte-package`.
- **Lead follow-up stays generic**: call `LeadWorkflowService` for audited Lead assignment/status/activity/task mutations under ambient tenancy; it locks rows, rejects cross-tenant identifiers, and has no authorization, SLA, automatic-owner, reminder, website-contact, or conversion policy. `LeadDetail` is props/callback only; host applications map state and call the service.
- **Model transition methods don't save**: `markEarned()/approve()/markPayable()/markPaid()` (Commission) and the payout transitions mutate + stamp timestamps only — callers save; the settlement/payout services do both.
- **`reject()` alone strands rows**: the model method only flips status — always reject through `transitionPayoutForSource`, which releases the batch's membership in the same transaction; stamped rows on a rejected payout would be unsettleable forever.
- **The payout source stamp is derived data, never authorization**: `sourceKind`/`sourceId` on CommissionPayout index the history listing; both the listing and the lifecycle service re-verify actual membership and fail closed when the stamp cannot be proven.
- **`sweepClearing` treats `clearingEndsAt: null` as immediately sweepable** (no clearing configured ⇒ nothing to wait for).
- **Agreement freeze scope**: activating a ReferralAgreement requires and freezes its execution/evidence refs along with its commercial terms. `effectiveTo` remains writable for explicit end-dating; signed bytes, hashes, signer evidence, and audit trail exist only on immutable ExecutedAgreement/Asset records.
- **Circular FK pair by design**: `Referral.snapshotId ↔ ReferralTermSnapshot.referralId`. Fine on SQLite (and no cross-table DDL constraints are emitted for these string FKs); keep an eye on strict-DDL environments.
- **Attribution resolution is single-writer per (target, program)**: `resolve()` is idempotent against PERSISTED state, but two workers resolving the same target concurrently can both pass the existence check and create duplicate credit — the collection layer has no cross-row transaction (the same stance as payout batching, which relies on disjoint scopes for concurrency). Run intake resolution serially per target (it naturally is, in a request handler); duplicates are visible in the portal and correctable via `override()`.
- **recordClick inside your transaction participates, never nests**: a nested adapter `transaction()` takes an independent pooled connection (happyvertical/sdk#1108) — it deadlocks undetectably on locks the caller's transaction holds (PostgreSQL sees a promise-wait, not a lock-wait) and refuses caller-created uncommitted links as `unknown_code`. Pass the caller's transaction database as `RecordClickInput.transaction` or bind the collection to it (`{ db: tx, _reuseInitializedDb: true, _deferRuntimeInitialization: true }` — detected and honored automatically); a pool-level database passed as `transaction` is refused with typed reason `invalid_transaction`. Participating results are bound to the caller's transaction — carry ids across the commit boundary; the pool-bound default still self-transacts and rehydrates after commit.
- **Click retries reuse one key**: pass the exact same non-empty, well-formed-Unicode `recordClick.idempotencyKey` (maximum 256 UTF-8 bytes) on transport/database retry. Omitting it remains source-compatible but creates and returns a one-shot UUID; it cannot deduplicate a later independent invocation. `maxEvidenceBytes` guards creation; changing it cannot turn an already-committed exact replay into failure. Replay validation is against the immutable operation/touch snapshot, not mutable current link fields: later link edits preserve exact replay, the result link is current, and the touch evidence is the original snapshot. The private optional-tenant `ReferralClickOperation` table is the serialization fence and must be included in schema migration. Never pre-bound caller evidence: Sales owns the authoritative final-envelope byte check.
- **`ObjectRegistry.getConfig(X)` needs the class module imported** (decorator side effects) — manifest-only registration doesn't carry api/mcp/conflictColumns; tests asserting surface configs need a side-effect import of the module barrel.
