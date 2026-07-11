# Migrating from `@happyvertical/smrt-affiliates` to `@happyvertical/smrt-sales`

`@happyvertical/smrt-affiliates` is now a **deprecated compatibility shim**.
It declares no models and owns no persistence: every class it exports is the
same runtime class as the corresponding `@happyvertical/smrt-sales`
commissions-core export, re-exported under the legacy name. The legacy
`partners` / `commissions` / `payouts` schema is no longer emitted by this
package — data lives in the sales tables.

## No flag day

Existing imports keep compiling through this shim: `Partner` **is**
`Earner`, `Payout` **is** `CommissionPayout`, and the legacy enum-style
const objects (`PartnerStatus`, `PayoutStatus`, …) preserve their exact
member names and string values. Move field-level code to the new API at your
own pace; the shim will be retired in a future major release. New code should
import from `@happyvertical/smrt-sales` directly.

## API surface mapping

| Legacy export (`smrt-affiliates`) | New export (`@happyvertical/smrt-sales`) | Notes |
|---|---|---|
| `Partner` | `Earner` | Same class via the shim. Financial identity only — roles moved out (see below). |
| `PartnerCollection` | `EarnerCollection` | Same class via the shim. |
| `Commission` | `Commission` | Same name, **new shape** (see column mapping). |
| `CommissionCollection` | `CommissionCollection` | Same class via the shim. |
| `Payout` | `CommissionPayout` | Same class via the shim. Renamed to avoid the global `payouts` table-name collision with commerce. |
| `PayoutCollection` | `CommissionPayoutCollection` | Same class via the shim. |
| `PartnerOptions` | `EarnerOptions` | Type alias via the shim. |
| `CommissionOptions` | `CommissionOptions` | Type alias via the shim (new shape). |
| `PayoutOptions` | `CommissionPayoutOptions` | Type alias via the shim. |
| `PartnerStatus` enum | `EarnerStatus` union (`EARNER_STATUSES`) | Values align exactly. |
| `PartnerType` enum | — (roles are models now) | `Referrer` (`@happyvertical/smrt-sales/referrals`), `SalesRepresentative` (`@happyvertical/smrt-sales/crm`). |
| `CommissionType` enum | — (plan component keys) | See the worked `CommissionPlan` below. |
| `CommissionStatus` enum | `CommissionStatus` union (`COMMISSION_STATUSES`) | `pending`/`paid` align; `included` has no direct equivalent (see status mapping). |
| `PayoutStatus` enum | `CommissionPayoutStatus` union (`COMMISSION_PAYOUT_STATUSES`) | 1:1. |
| `PayoutMethod` enum | `PayoutMethod` union (`PAYOUT_METHODS`) | Legacy values align; the new union adds `'other'`. |

New concepts with no legacy counterpart (adopt as you migrate):
`CommissionPlan(Collection)` (versioned calculation terms),
`EarningEvent(Collection)` (immutable evidence rows),
`CommissionAdjustment(Collection)` (append-only corrections),
`CommissionCalculationService`, `CommissionSettlementService`,
`CommissionBalanceService`, `CommissionPayoutService`, and the `money.ts`
helpers (`roundCents`, `centsToAmount`, `amountToCents`,
`calculateCommissionAmountCents`).

## Table mapping

| Legacy table | New home |
|---|---|
| `partners` | `earners` (the financial identity: payout method/threshold/currency/status) **plus** role-model rows: `referrers` (`smrt-sales/referrals`) and/or `sales_representatives` (`smrt-sales/crm`), each holding `earner_id`. Publisher-style roles belong in your application domain (e.g. alongside your smrt-properties usage). |
| `commissions` (legacy shape) | `commissions` (new shape) — plus one `earning_events` evidence row per originating event. |
| `payouts` | `commission_payouts` |

## Column mapping: `partners` → `earners` (+ role models)

| Legacy `partners` column | New home | Notes |
|---|---|---|
| `id`, `created_at`, `updated_at` | `earners.id`, … | Copy as-is (UUIDs preserved keeps FK rewrites trivial). |
| `profile_id` | `earners.profile_id` | Still a cross-package string ref to smrt-profiles. Also copy onto each role-model row. |
| `property_id` | application domain / role model | Publisher-specific; the neutral core has no property concept. Keep it on your publisher role model or in `earners.metadata`. |
| `partner_types` (JSON string array) | role-model **rows** | `'referrer'` → a `referrers` row; `'salesperson'` → a `sales_representatives` row; `'publisher'` → an application role model. Each row carries `earner_id`. One person with several roles keeps ONE earner. |
| `parent_partner_id` | plan components / role hierarchy | The parent-publisher waterfall is now expressed in `CommissionPlan` components (or commission splits), not on the account. Record the org relationship on your role models or in metadata. |
| `referred_by_id` | `smrt-sales/referrals` (`Referral` attribution) | Referral attribution is evidence-based (`ReferralTouch` → `Referral`), not a column on the account. |
| `parent_commission_share` | plan component rates / `share_fraction` | See the worked plan below. Note the legacy column was declared with an integer default (`= 0`) — audit stored values before converting. |
| `display_commission_rate`, `referral_commission_rate`, `sales_commission_rate` | `commission_plans.components` (JSON) | Per-type rates become plan components; see the worked plan below. Legacy values were true 0–1 decimals. |
| `payout_threshold` | `earners.payout_threshold_cents` | Same unit (integer cents), explicit `*Cents` name. |
| `payout_method` | `earners.payout_method` | Same string values; the new union adds `'other'`. |
| `currency` | `earners.currency` | Copy the explicit value (see currency note below). |
| `status` | `earners.status` | Same string values (`pending`/`active`/`suspended`). |
| `metadata` (JSON string) | `earners.metadata` | New default is `'{}'` rather than `''`. |
| — | `earners.tenant_id` | New, nullable. Legacy rows migrate as `NULL` (= global; matches the old cross-tenant behavior). |
| — | `earners.display_name` | New; backfill from your profile data. |
| — | `earners.payout_schedule_key` | New; defaults to `'manual'`. |

## Column mapping: `commissions` (legacy) → `commissions` (new) + `earning_events`

Each legacy commission row becomes a new `commissions` row, and each distinct
originating ad event becomes ONE `earning_events` evidence row shared by the
commissions it produced.

| Legacy `commissions` column | New home | Notes |
|---|---|---|
| `event_id` (smrt-ads `AdEvent` ref) | `earning_events` row: `source_kind = 'ad_event'`, `source_id = <event_id>`, plus `commissions.source_kind`/`source_id` (copied) | Create the event with `event_kind` of your choosing (e.g. `'ad_revenue'`), `occurred_at = event_timestamp`, `gross_amount_cents = gross_revenue`, and a `dedupe_key` (e.g. `'ad_event:' \|\| event_id`) — the natural key that makes re-runs idempotent. |
| `partner_id` | `commissions.earner_id` | FK now points at `earners`. |
| `commission_type` | `commissions.component_key` | `'display'`/`'referral'`/`'sales'`/`'parent'`/`'overhead'` map naturally onto plan component keys (see the worked plan); also set `plan_key`/`plan_version` to the migration plan you create. |
| `gross_revenue` | `commissions.base_amount_cents` (and `earning_events.gross_amount_cents`) | Same unit (integer cents). `basis = 'gross'`. |
| `commission_rate` | `commissions.rate` | **Type change.** New `rate` is DECIMAL in 0–1. The legacy column was declared INTEGER (`= 0` default), i.e. basis points on strict-typed databases — divide by 10,000 (`5000` → `0.50`). Audit first: SQLite deployments may hold fractional REALs despite the INTEGER affinity; if stored values are already 0–1 decimals, copy as-is. |
| `commission_amount` | `commissions.amount_cents` | Same unit (integer cents). |
| `currency` | `commissions.currency` | Copy the explicit value. |
| `payout_id` | `commissions.payout_id` | Now points at `commission_payouts`. |
| `status` | `commissions.status` | See status mapping below. |
| `event_timestamp` | `earning_events.occurred_at` | The commission itself carries lifecycle timestamps instead (`earned_at`/`approved_at`/`payable_at`/`paid_at`). |
| `network_id`, `site_id`, `campaign_id` | `metadata` JSON (recommended) or your own `source_kind`/`source_id` conventions | The neutral core has no ad-network vocabulary. Put them in `earning_events.metadata`/`commissions.metadata` (e.g. `{"networkId": …, "siteId": …, "campaignId": …}`) for aggregate queries, or encode them in `source_kind` conventions if they identify the source. |
| `metadata` | `commissions.metadata` | New default `'{}'`. |
| — | `commissions.dedupe_key` | New, required natural key — e.g. `` `${event.dedupe_key}:${plan_key}@${plan_version}:${component_key}:${earner_id}:0` `` (the calculation service's format). |
| — | `commissions.share_fraction` (`1.0`), `split_group_id`, `terms_snapshot_kind`/`terms_snapshot_id`, `calculation_trace` | New audit/split fields; safe defaults shown. A backfilled `calculation_trace` naming your migration plan keeps historical amounts reproducible. |
| — | `commissions.tenant_id` | Nullable; legacy rows migrate as `NULL`. |

## Column mapping: `payouts` → `commission_payouts`

| Legacy `payouts` column | New column | Notes |
|---|---|---|
| `partner_id` | `earner_id` | |
| `period_start`, `period_end` | same | Now nullable. |
| `display_earnings`, `referral_earnings`, `sales_earnings`, `parent_earnings`, `overhead_earnings` | `commission_total_cents` (sum) | The per-type breakdown columns are gone. `commission_total_cents = display + referral + sales + parent + overhead`; per-type breakdowns are now **queries** over the settled rows: `SELECT component_key, SUM(amount_cents) FROM commissions WHERE payout_id = … GROUP BY component_key`. |
| — | `adjustment_total_cents` | New (signed); `0` for migrated batches. |
| `total_amount` | `total_amount_cents` | Save-time invariant: `total_amount_cents = commission_total_cents + adjustment_total_cents`. |
| `currency` | `currency` | Copy the explicit value. |
| `invoice_id` | `invoice_id` | Still a cross-package string ref to a commerce Invoice. |
| `status` | `status` | 1:1 (see below). |
| `payment_reference` | `payment_reference` | |
| `paid_at` | `paid_at` | |
| `notes` | `notes` | |
| `metadata` | `metadata` | New default `'{}'`. |
| — | `payout_method` | New on the batch (defaulted from the Earner). Backfill from the legacy partner's `payout_method`. |
| — | `provider_ref` | New; empty for migrated rows. |
| — | `idempotency_key` | New, required natural key — e.g. `` `${earner_id}:${currency}:${period_end ISO date}` `` (the payout service's default format). |
| — | `tenant_id` | Nullable; legacy rows migrate as `NULL`. |

## Status mappings

Commission (`pending → earned → approved → payable → paid` is the new strict
forward chain):

| Legacy `commissions.status` | New `commissions.status` | Notes |
|---|---|---|
| `pending` | `pending` | |
| `included` | `payable` **with `payout_id` set** | No direct equivalent — "included in a payout batch" is now the combination of the `payable` state and a stamped `payout_id`. Set `payable_at` from the payout's creation time if you need a timestamp. |
| `paid` | `paid` | Backfill `paid_at` from the payout's `paid_at`. Intermediate `earned_at`/`approved_at`/`payable_at` may be left `NULL` for historical rows. |

Payout statuses map 1:1: `pending → pending`, `approved → approved`,
`processing → processing`, `completed → completed`, `failed → failed`.

Partner → Earner statuses map 1:1: `pending`/`active`/`suspended`.

## Rates → CommissionPlan components (worked example)

Legacy per-partner rate columns become a versioned `CommissionPlan`. The old
per-event waterfall was:

- display → publisher: `gross × display_commission_rate` (default 0.50)
- referral → referrer: `gross × referral_commission_rate` (default 0.05)
- sales → salesperson: `gross × sales_commission_rate × (1 − parent_commission_share)` (default 0.10 × 0.80 = 0.08)
- parent → parent publisher: `gross × sales_commission_rate × parent_commission_share` (default 0.10 × 0.20 = 0.02)

A plan whose `components` JSON reproduces that waterfall (using the default
legacy rates; substitute each partner's actual columns):

```json
[
  { "key": "display", "trigger": "ad_revenue", "basis": "gross", "rate": 0.5 },
  { "key": "referral", "trigger": "ad_revenue", "basis": "gross", "rate": 0.05 },
  { "key": "sales", "trigger": "ad_revenue", "basis": "gross", "rate": 0.08 },
  { "key": "parent", "trigger": "ad_revenue", "basis": "gross", "rate": 0.02 },
  { "key": "overhead", "trigger": "ad_revenue", "basis": "gross", "rate": 0.35 }
]
```

Each earning event is then calculated per earner with the component(s) that
earner is entitled to (`CommissionCalculationService.calculateForEvent`):
the publisher's Earner gets `display`, the referrer's gets `referral`, the
salesperson's gets `sales`, the parent publisher's gets `parent`.
Alternatively, keep ONE `sales` component at the full legacy rate (0.10) and
express the parent share as a split: two commissions sharing a
`split_group_id` with `share_fraction` 0.8 (salesperson) and 0.2 (parent).
Splits keep the calculation trace closer to the source terms; flat components
keep the plan closer to the legacy columns — both are valid.

Because legacy rates were **per partner**, either mint one plan per distinct
rate tuple (e.g. `plan_key = 'affiliates-legacy'`, one version per tuple) or
one plan per partner (`plan_key = 'partner-<id>'`). Plans are immutable once
active; rate changes are new versions, not edits.

## Behavioral changes

- **Tenancy**: every new model is `@TenantScoped({ mode: 'optional' })` with
  a nullable `tenant_id`. The legacy models were deliberately NOT
  tenant-scoped (cross-tenant ad network); migrate legacy rows with
  `tenant_id = NULL`, which the new stack treats as global and preserves the
  old visibility. Sales-era rows are tenant-owned by default.
- **Currency**: new models default to `USD`; the legacy models defaulted to
  `CAD`. Migrated rows keep whatever explicit value their `currency` column
  held (the default only affects newly created rows) — copy the column, never
  rely on the default.
- **Lifecycle**: the commission chain is now strict and forward-only —
  `pending → earned → approved → payable → paid`, enforced at save time.
  There is no generated update/delete on commissions, earning events, or
  payouts; corrections are **append-only** `CommissionAdjustment` rows
  (`refund`/`credit`/`chargeback`/`dispute`/`correction`) — an earned or paid
  commission is never edited.
- **Balances are computed, not stored**: the legacy
  `sumPendingByPartner()`-style aggregates become
  `CommissionBalanceService.getBalance(earnerId, currency)` (payable +
  unsettled adjustments), and payout batches are minted idempotently by
  `CommissionPayoutService.createPayoutBatch`.
- **Idempotency**: earning events, commissions, and payouts all carry natural
  keys (`dedupe_key` / `idempotency_key`); retried ingestion or settlement
  upserts instead of duplicating.
- **Integer cents are kept**: all monetary fields remain integer cents, now
  uniformly suffixed `*Cents`; rates are decimals in 0–1.

## Example SQL sketches (Postgres-flavored — TEMPLATES, not runnable as-is)

Adjust table/column names to your deployment, wrap in a transaction, and
verify counts. These assume you keep legacy UUIDs so downstream FK rewrites
are mechanical.

```sql
-- 1) partners → earners (financial identity; tenant stays NULL = global)
INSERT INTO earners (
  id, created_at, updated_at, tenant_id, profile_id, display_name,
  status, payout_method, payout_threshold_cents, payout_schedule_key,
  currency, metadata
)
SELECT
  p.id, p.created_at, p.updated_at, NULL, p.profile_id, '',
  p.status, p.payout_method, p.payout_threshold, 'manual',
  p.currency, COALESCE(NULLIF(p.metadata, ''), '{}')
FROM partners p;

-- 1b) role rows from the partner_types JSON array (repeat per role kind)
INSERT INTO sales_representatives (id, tenant_id, profile_id, earner_id, ...)
SELECT gen_random_uuid(), NULL, p.profile_id, p.id, ...
FROM partners p
WHERE p.partner_types::jsonb ? 'salesperson';
-- 'referrer' → referrers (smrt-sales/referrals); 'publisher' → your app's
-- publisher role model (property_id lives there, not on the earner).

-- 2) legacy commissions → earning_events (one row per distinct ad event)
INSERT INTO earning_events (
  id, tenant_id, event_kind, occurred_at, source_kind, source_id,
  gross_amount_cents, currency, dedupe_key, metadata
)
SELECT DISTINCT ON (c.event_id)
  gen_random_uuid(), NULL, 'ad_revenue', c.event_timestamp,
  'ad_event', c.event_id,
  c.gross_revenue, c.currency, 'ad_event:' || c.event_id,
  jsonb_build_object(
    'networkId', c.network_id, 'siteId', c.site_id, 'campaignId', c.campaign_id
  )::text
FROM commissions_legacy c
ORDER BY c.event_id, c.event_timestamp;

-- 3) legacy commissions → new commissions
--    NOTE the rate conversion: legacy commission_rate was an INTEGER column
--    (basis points) — divide by 10000.0. If your deployment actually stored
--    0–1 decimals (SQLite affinity), copy the value unchanged instead.
INSERT INTO commissions (
  id, created_at, updated_at, tenant_id, earner_id, earning_event_id,
  plan_key, plan_version, component_key, basis, base_amount_cents, rate,
  share_fraction, amount_cents, currency, status, payable_at, paid_at,
  payout_id, source_kind, source_id, calculation_trace, dedupe_key, metadata
)
SELECT
  c.id, c.created_at, c.updated_at, NULL, c.partner_id, ee.id,
  'affiliates-legacy', 1, c.commission_type, 'gross', c.gross_revenue,
  c.commission_rate / 10000.0,
  1.0, c.commission_amount, c.currency,
  CASE c.status WHEN 'included' THEN 'payable' ELSE c.status END,
  CASE WHEN c.status IN ('included', 'paid') THEN c.updated_at END,
  CASE WHEN c.status = 'paid' THEN pay.paid_at END,
  NULLIF(c.payout_id, ''), 'ad_event', c.event_id,
  '{}', ee.dedupe_key || ':affiliates-legacy@1:' || c.commission_type
        || ':' || c.partner_id || ':0',
  COALESCE(NULLIF(c.metadata, ''), '{}')
FROM commissions_legacy c
JOIN earning_events ee
  ON ee.source_kind = 'ad_event' AND ee.source_id = c.event_id
LEFT JOIN payouts pay ON pay.id = c.payout_id;

-- 4) payouts → commission_payouts (per-type columns collapse into the
--    commission total; breakdowns become GROUP BY component_key queries)
INSERT INTO commission_payouts (
  id, created_at, updated_at, tenant_id, earner_id, period_start, period_end,
  commission_total_cents, adjustment_total_cents, total_amount_cents,
  currency, payout_method, status, payment_reference, provider_ref, paid_at,
  invoice_id, notes, idempotency_key, metadata
)
SELECT
  po.id, po.created_at, po.updated_at, NULL, po.partner_id,
  po.period_start, po.period_end,
  po.display_earnings + po.referral_earnings + po.sales_earnings
    + po.parent_earnings + po.overhead_earnings,
  0,
  po.total_amount,
  po.currency, p.payout_method, po.status, po.payment_reference, '',
  po.paid_at, po.invoice_id, po.notes,
  po.partner_id || ':' || po.currency || ':'
    || to_char(po.period_end, 'YYYY-MM-DD'),
  COALESCE(NULLIF(po.metadata, ''), '{}')
FROM payouts po
JOIN partners p ON p.id = po.partner_id;
```

Post-migration checks worth running: per-earner sums
(`SUM(amount_cents)` grouped by `earner_id`/`status`) against the legacy
per-partner sums; `total_amount_cents = commission_total_cents +
adjustment_total_cents` on every payout; and every migrated `payable`/`paid`
commission carrying a `payout_id` that exists.

## Legacy collection helpers

The legacy query helpers have close equivalents; the network-scoped ones do
not (network vocabulary moved to metadata/source conventions):

| Legacy helper | New surface |
|---|---|
| `PartnerCollection.findByProfile()` | `EarnerCollection.findByProfile()` |
| `PartnerCollection.findByProperty()/findByParent()/findByReferrer()` | role-model / application queries |
| `CommissionCollection.findByPartner()` | `CommissionCollection.findByEarner()` |
| `CommissionCollection.findByEvent()` | `CommissionCollection.findByEvent()` (takes the `earning_event_id`) |
| `CommissionCollection.findByPayout()/findByStatus()` | same names |
| `CommissionCollection.sumPendingByPartner()` | `CommissionBalanceService.getBalance()` / `CommissionCollection.sumPayableByEarner()` |
| `CommissionCollection.getEarningsBreakdown()` | `GROUP BY component_key` over `commissions` |
| `CommissionCollection.findByNetwork*()/getSummaryByNetwork()/getPendingPayoutsByNetwork()` | metadata/source-convention queries in your application |
| `PayoutCollection.findByPartner()` | `CommissionPayoutCollection.findByEarner()` |
| `Payout.approve()/markProcessing()/complete()/fail()` | same methods on `CommissionPayout` (plus `resetFromFailed()`); they mutate without saving — the caller saves |
| `Commission.calculateAmount(gross, rate)` | `calculateCommissionAmountCents(baseCents, rate, shareFraction?)` from `@happyvertical/smrt-sales` |
