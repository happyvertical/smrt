# @happyvertical/smrt-sales

Modular sales: CRM (Leads, Opportunities, Pipelines), referral intake with versioned attribution policies, a neutral commissions financial core with immutable term snapshots, and reusable Svelte surfaces. One installable package, four modules with distinct subpath exports:

- `@happyvertical/smrt-sales/crm`
- `@happyvertical/smrt-sales/referrals`
- `@happyvertical/smrt-sales/commissions`
- `@happyvertical/smrt-sales/svelte`

The root export re-exports every TS module. Internal module dependency order is `crm → commissions` and `referrals → commissions` (by string references only); `commissions` never imports from `crm`/`referrals` and never assumes advertising, Referral, Lead, or Opportunity semantics.

## Roles vs. money

Referrers and Sales Representatives are **distinct roles** and stay that way. Both connect to money through one neutral financial account:

- **Earner** (commissions): payout identity — method, threshold, currency, status. Referenced by every Commission and CommissionPayout.
- **SalesRepresentative** (crm) and **Referrer** (referrals): role models, each holding `profileId` (cross-package string ref to smrt-profiles) and `earnerId`.

## Modules

### commissions — neutral financial core

- **Earner**: `profileId`, `status` (`pending|active|suspended`), `payoutMethod` (`bank_transfer|check|paypal|credit|other`), `payoutThresholdCents`, `payoutScheduleKey` (open string: `manual`, `monthly`, …), `currency`, `metadata`.
- **CommissionPlan**: versioned calculation terms. Natural key `(tenant_id, plan_key, version)` (per-tenant keys; NULL-tenant rows opt out of upsert dedup); `status` (`draft|active|superseded|retired`); `effectiveFrom`. Components are a JSON-string array (`getComponents()`): each component has `key`, `trigger` (earning-event kind or `*`), `basis` (`fixed|gross|net|margin|custom`), `rate` or `fixedAmountCents`, `recurrence` (`one_time` or `recurring` with optional `maxOccurrences`/`windowMonths`). **Immutable once active** — amendments create a new row with `version + 1`; prior versions are never rewritten. `latestActiveByKey(key, at?)` resolves the highest active version **already in effect at `at`** — a future-dated amendment can be activated ahead of time without governing earlier qualifications (same rule on `AttributionPolicyCollection`).
- **EarningEvent**: immutable commercial-event evidence (`conversion`, `agreement_execution`, `invoice_payment`, `collected_revenue`, `recognized_margin`, or any extensible kind). Carries `sourceKind`/`sourceId` (generic earning source), `grossAmountCents`/`netAmountCents`/`marginCents`, `currency`, `occurredAt`, and a `dedupeKey` natural key for idempotent ingestion. No update/delete surface, plus a save-time immutability guard: hydrated edits, blind id overwrites, and fresh creates onto an existing dedupe key all throw (the upsert would rotate the row id and orphan referencing Commissions) — idempotent ingestion goes through `getOrCreateByDedupeKey()`.
- **Commission**: one earning record per earner per plan component per event occurrence. Integer-cents amounts (`baseAmountCents`, `amountCents`), decimal `rate`, `basis`, snapshot references (`planKey`/`planVersion`, generic `termsSnapshotKind`/`termsSnapshotId`), a JSON `calculationTrace` sufficient to reproduce the amount, split support (`splitGroupId`, `shareFraction`), and a `dedupeKey` for idempotent creation. Lifecycle `pending → earned → approved → payable → paid`, enforced by a save-time transition guard with an authoritative prior-status re-read (commerce pattern).
- **CommissionAdjustment**: append-only corrections (`refund|credit|chargeback|dispute|correction`), signed `amountCents`, required `reason`, immutable once created. Earned/paid Commissions are never rewritten — adjustments append to them.
- **Payable balance**: computed, not stored — `CommissionBalanceService` sums payable Commissions plus unsettled Adjustments per Earner/currency.
- **CommissionPayout**: settlement batch per Earner. `pending → approved → processing → completed | failed` (`resetFromFailed()` is the only exit from failed); settles rows via the collections' **conditional `claimForPayout`** (a row owned by another batch is never re-claimed) and stores totals recomputed from the VERIFIED claimed membership; idempotent via `idempotencyKey` natural key (default `${earnerId}:${currency}:${YYYY-MM-DD}`) — a clean replay touches nothing, while a pending payout whose totals disagree with its stamped rows (interrupted claim pass) is repaired on replay. `completePayout` flips member commissions to `paid` BEFORE the terminal transition, so a mid-loop failure stays retryable. Enforces `totalAmountCents = commissionTotalCents + adjustmentTotalCents` at save; retains `paymentReference`/`providerRef`; optional `invoiceId` cross-package string ref to a commerce Invoice. Generated surface is read-only on ALL doors (api/mcp/cli `list`/`get`) — writes go through `CommissionPayoutService` (settlement is single-writer per earner by expectation; the collection layer has no cross-row transactions).

### crm

- **SalesRepresentative**: role model (`profileId`, `earnerId`, `status`).
- **Lead**: identified prospect with owner assignment, generic acquisition source (`sourceKind`/`sourceId`), preserved `acquisitionContext` JSON, and audited merge (`mergedIntoId`; merges preserve activity + acquisition history on both sides).
- **PipelineDefinition / PipelineStage**: configurable ordered stages with default `new → qualified → discovery → proposal → negotiation → closed_won | closed_lost` (seeded via `ensureDefaultPipeline()`); stages carry `probability` and `isWon`/`isLost` terminal flags.
- **Opportunity**: qualified engagement — owner, pipeline + stage, `expectedValueCents`, `probability`, `expectedCloseAt`, outcome. Stage movement validated against the pipeline; terminal stages set `won|lost` status.
- **SalesActivity**: activity/next-action trail for Leads and Opportunities (`subjectKind`/`subjectId`), also the audit trail for assignment, qualification, merges, and stage movement.
- **OpportunityConversion**: idempotent conversion links (`targetKind`/`targetId` — client, project, contract, subscription, …) with a composite natural key. CRM never creates downstream records itself and never mutates referral or commission state.

### referrals

- **Referrer**: role model (`profileId`, `earnerId`, `status`).
- **ReferralProgram**: program defaults — default commission plan key, default attribution policy key, eligibility defaults.
- **AttributionPolicy**: versioned `(tenant_id, policy_key, version)` policy (per-tenant keys) — attribution `windowDays`, credit mode (`first_touch|last_touch|assigned|split`), split shares, self-referral/existing-client eligibility, eligible services/campaigns/regions, conflict behavior. Immutable once active; amendments bump `version`.
- **ReferralLink**: shareable link/code per Referrer+Program. Codes are crypto-random, uniqueness-checked, with click counting.
- **ReferralTouch**: immutable attribution evidence (`click|code_entry|manual_assignment|partner_entry`) with subject hints and evidence JSON.
- **Referral**: the introduction — generic qualifying target (`targetKind`/`targetId`: lead, opportunity, client, project, subscription, …), resolved policy version, credit fraction (splits create sibling Referrals sharing `splitGroupId`), lifecycle `pending → attributed → qualified | disqualified | expired | under_review`.
- **AttributionException**: conflict review queue. Conclusive policy resolves automatically; ambiguity creates an exception; overrides require a `resolutionReason` and are audited.
- **ReferralAgreement**: versioned per-Referrer terms binding — pins `commissionPlanKey`/`planVersion`, effective dating, optional cross-package string refs to a commerce Contract and executed-artifact evidence (e-signature execution lives downstream).
- **ReferralTermSnapshot**: immutable at qualification — freezes agreement/plan/policy version refs plus the calculation inputs needed to reproduce every later earning.
- **Services**: `AttributionService` (resolve touches → Referral(s) or exception; typed refusals `existing_client_ineligible | no_active_policy | no_eligible_touches`; `override()` requires a reason, audits via a resolved AttributionException, pins the displaced credit's policy version, and throws `QualifiedReferralOverrideError` on qualified referrals), `ReferralQualificationService` (eligibility + frozen snapshot + transition; `requalify()` is the explicit apply-amendment path), `ReferralCommissionService` (bridge: qualified Referral + EarningEvent → Commissions through the snapshot with `termsSnapshotKind = REFERRAL_TERMS_SNAPSHOT_KIND`; occurrence limits counted per `(termsSnapshotId, componentKey)`; fully idempotent on replay).

### svelte

Props-driven presentational components (no data fetching, no model-class imports, Provider-free smrt-ui primitives, `--smrt-*` tokens only): CRM — `SalesDashboard`, `LeadList`, `OpportunityBoard`, `OpportunityDetail`; referrer portal — `ReferralLinkManager`, `ReferralStatusList`, `ReferrerEarningsSummary`, `CommissionBreakdown` (trace-explained amounts), `PayoutHistoryList`, `ExecutedAgreementsList`; operator — `AttributionConflictQueue` (award editor + required resolution reason), `PayoutBatchReview`, `CommissionExpenseSummary` (explicitly distinct from client invoices). Monetary props stay integer cents; `format.ts` converts at render. View-model prop types are exported interfaces (never inline intersected generics in `$props()`); pure helpers (dashboard math, award validation mirroring the service, payout action gating) are unit-tested while components are svelte-check-gated.

## Currency

**All monetary fields are integer cents** with `*Cents` suffixes; rates are decimal (`0`–`1`). Rounding happens once per calculation step via `roundCents()` (half-away-from-zero) and every Commission stores its `calculationTrace` so amounts are reproducible. Convert at display/commerce boundaries with `centsToAmount()`/`amountToCents()`.

## Tenancy

Every model is `@TenantScoped({ mode: 'optional' })` with `@tenantId({ nullable: true })`. This deliberately departs from legacy smrt-affiliates (which was cross-tenant by design for ad networks): sales programs, earners, and payouts are tenant-owned; `tenantId: null` remains available for global/operator-level rows.

## Cross-package references (plain strings)

`profileId` → smrt-profiles Profile; `invoiceId` (CommissionPayout) → smrt-commerce Invoice; `contractRef` (ReferralAgreement) → smrt-commerce Contract. No static imports of sibling domain packages.

## smrt-affiliates migration

`@happyvertical/smrt-affiliates` is now a deprecated compatibility package that re-exports this package's commissions core under the legacy names (`Partner` → `Earner`, `Payout` → `CommissionPayout`, `Commission`, collections, enums) with `@deprecated` guidance and **no duplicate persistence model**. The data/API mapping lives in `packages/affiliates/MIGRATION.md`.

## Gotchas

- **Cents vs. rates**: `*Cents` fields are INTEGER (`= 0` defaults); `rate`/`probability`/`shareFraction` are DECIMAL (`= 0.0` defaults). Don't mix the two conventions on one field.
- **Versioned terms are rows, not edits**: CommissionPlan / AttributionPolicy / ReferralAgreement amendments insert `version + 1`; active versions are save-guarded immutable.
- **Idempotency is dedupeKey-based**: EarningEvent, Commission, and CommissionPayout carry natural keys (`conflictColumns`) — retried ingestion/settlement upserts instead of duplicating.
- **Adjustments never rewrite**: correcting an earned/paid Commission means appending a CommissionAdjustment, not editing the Commission.
- **CommissionPayout, not Payout**: avoids the pre-existing global table-name collision between commerce `Payout` and legacy affiliates `Payout` (`payouts`).
- **Table names are global**: new models were named to avoid collisions across packages (`commission_payouts`, `sales_activities`, `attribution_policies`, …).
- **Svelte module is svelte-check-gated**: no runtime component tests; `typecheck` runs `svelte-check` via `scripts/svelte-check-a11y.mjs`. Ship raw `.svelte` via `svelte-package`.
- **Model transition methods don't save**: `markEarned()/approve()/markPayable()/markPaid()` (Commission) and the payout transitions mutate + stamp timestamps only — callers save; the settlement/payout services do both.
- **`sweepClearing` treats `clearingEndsAt: null` as immediately sweepable** (no clearing configured ⇒ nothing to wait for).
- **Agreement freeze scope**: activating a ReferralAgreement freezes referrer/program/version/plan refs/clearingDays/approvalMode/effectiveFrom; `effectiveTo` (end-dating) and the evidence fields (`contractRef`, artifact url/hash, `acceptanceEvidence`) stay writable — e-signature completes downstream.
- **Circular FK pair by design**: `Referral.snapshotId ↔ ReferralTermSnapshot.referralId`. Fine on SQLite (and no cross-table DDL constraints are emitted for these string FKs); keep an eye on strict-DDL environments.
- **`ObjectRegistry.getConfig(X)` needs the class module imported** (decorator side effects) — manifest-only registration doesn't carry api/mcp/conflictColumns; tests asserting surface configs need a side-effect import of the module barrel.
