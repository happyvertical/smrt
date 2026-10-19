# @happyvertical/smrt-subscriptions

Tenant subscriptions, feature grants, immutable usage evidence, thresholds,
effective-dated client pricing, spending policies, and entitlement resolution
for s-m-r-t applications.

The package is provider-neutral. Stripe or another billing provider may be
recorded as binding metadata, but provider API calls belong in an injected SDK
accounting adapter.

## Installation

```bash
pnpm add @happyvertical/smrt-subscriptions
```

Add `svelte` for the optional plan, subscription, and threshold components.

## Resolve entitlements

```ts
import { SubscriptionResolver } from '@happyvertical/smrt-subscriptions';

const resolver = await SubscriptionResolver.create({ db: 'app.db' });
const context = await resolver.loadEntitlementContext('tenant-1');

const result = await resolver.resolveTenantEntitlements('tenant-1', {
  context,
});

if (!result.allowed) {
  throw new Error('Subscription thresholds do not allow this operation');
}

console.log(result.planKey, result.featureKeys, result.thresholdEvaluations);
```

Create one resolver per request or application unit of work and reuse the
loaded `EntitlementResolutionContext` when several checks need the same
subscription and plan.

## Core model

- `SubscriptionPlan` is tenant-scoped by `(tenantId, planKey)` and stores
  feature grants, thresholds, and a `free`, `fixed`, or `pay_what_you_can`
  pricing mode. Amounts (`priceAmount`, `minimumAmount`, and
  `suggestedAmount`) are integer minor units. Provider bindings are optional
  metadata (`externalProvider`, `providerProductId`, `providerPriceId`).
- `TenantSubscription` binds a tenant or external subscriber to a plan over an
  effective period and records its chosen `agreedAmount` in integer minor
  units for pay-what-you-can plans. Such subscriptions require an amount at
  least the plan minimum; free/fixed subscriptions must leave it null.
  Free and pay-what-you-can plans require `priceAmount: 0`; fixed plans use
  `priceAmount`. Monthly commerce period-close bills tenant subscribers using
  their agreed amount for pay-what-you-can, never the suggested amount, and
  skips free plans. External subscriber invoice routing remains host-owned. Pricing
  mode and minimum are immutable after the plan is saved; create a
  new plan instead. Other term changes publish a new plan version (see
  [Plan versions](#plan-versions-and-paid-periods)).
  Invalid legacy pricing fails only its payer group at period close and reports
  the subscription ID while other payer groups continue. Ordinary subscription
  writes resolve only their own tenant's plans or legacy global plans; trusted
  system-context billing can link a seller's plan to its child tenant.
  Entitlement resolution validates plan ownership on both reader and supplied
  context paths; trusted seller-to-child resolution requires explicit system
  context too.
- `SubscriptionPlanVersion` is an immutable, effective-dated snapshot of a
  plan's terms; subscriptions pin the version their period paid for.
- `TenantUsageMetric` is immutable, idempotent usage evidence.
- `SubscriptionResolver` combines current subscription, plan, and batched usage
  summaries into one entitlement decision.
- `TenantUsageMeter` records and summarizes ordinary and AI usage.
- `PricingRule`, `ClientCharge`, and `BillingAdjustment` model effective-dated
  commercial evidence.
- `SpendingPolicyEvaluator` applies scoped budget behavior without embedding a
  payment provider.
- `PriceBook`, `PriceBookAssignment`, `RetailCharge`, and `CreditGrant` add
  reseller pricing, the reseller's retail ledger, and prepaid credit (see
  [Reseller billing](#reseller-billing)).

Subscribers are polymorphic: tenant subscribers use a tenant ID, while external
subscribers add a stable external discriminator. Utilities such as
`normalizeSubscriber()` and `assertSubscriberInvariant()` keep that identity
coherent.

## Upgrade note

`SubscriptionPlanCollection.findByPlanKey` now requires `(tenantId, planKey)`;
pass `null` explicitly for legacy global plans. Update callers from the old
single-argument signature. Pricing mode and minimum cannot be edited after
persistence, even before the first subscriber, so a concurrent signup cannot
observe terms that change mode underneath it. Existing fixed-price edits and
current-period entitlement versioning arrived with #4032 (see
[Plan versions](#plan-versions-and-paid-periods)). Concurrent first creates
for one `(tenantId, planKey)` use a strict insert: one succeeds and a collision
fails without changing the winner. Retry by reading the existing plan; a
sequential create with matching mode/minimum retains natural-key upsert behavior.
Retrying different pricing mode/minimum is rejected. The provider-neutral price
lookup falls back to legacy Stripe IDs when the binding is Stripe or unspecified;
explicit bindings to other providers do not use that fallback. PlanPicker accepts
optional pricing mode, minimum and suggested amounts, labeling free plans and
PWYC terms explicitly instead of displaying them as zero fixed-price plans.

Existing databases created before #3829 may retain the global
`_smrt_subscription_plans_plan_key_idx` on older migration runners. Run
`scripts/migrate-3829-drop-legacy-plan-key-index.ts` after the ordinary manifest
migration so different tenants can reuse a plan key. The script supports SQLite
and PostgreSQL and refuses DuckDB, whose inline unique constraint needs a
reviewed table rebuild.

## Plan versions and paid periods

A `SubscriptionPlan` is the stable tier identity, scoped by
`(tenantId, planKey)`. Its terms — `status`, `priceAmount`, `currency`,
`billingInterval`, `pricingMode`, `minimumAmount`, `suggestedAmount`,
feature grants and thresholds — are published as immutable
`SubscriptionPlanVersion` rows (#4032):

- Saving a plan whose terms differ from its latest version publishes the next
  version (1, 2, 3 …), effective now. `plan.publishTerms({ effectiveFrom })`
  schedules a future amendment instead. Versions are append-only (no update,
  no delete) and monotonic: a version cannot start before the previous one.
  Re-saving unchanged terms, or changing only `name`/`description`/metadata,
  publishes nothing.
- A version is in force from its `effectiveFrom` until the next version's;
  an instant before the first version resolves to version 1.
- `TenantSubscription.planVersionId` is the version frozen for the current
  period (`planVersionPinnedAt`, `planVersionPinReason`, and
  `planVersionPinNote` audit it). It is maintained on every save:
  - a new subscription pins the version in force at its period start
    (`currentPeriodStart ?? startedAt`);
  - **renewal** — a save whose new `currentPeriodStart` is at or after the
    stored `currentPeriodEnd` (or, for an open-ended row, after the stored
    start) — re-pins the version in force at the new boundary, for the plan
    the row now names. A downgrade or a plan change that removes features is
    applied this way. Moving the start within a paid period is not a renewal;
  - at creation and renewal the boundary decides the version: naming any
    other `planVersionId` (for example to grandfather an import) needs an
    authorized replacement;
  - within an unchanged period, a different plan or version is accepted only
    when it is an **upgrade** (`isEntitlementUpgrade()`: every enabled feature
    stays enabled and no threshold is added, lowered or made stricter), or
    when the period no longer entitles. Anything else is rejected;
  - `subscription.replacePlanVersion({ policy: 'authorized', reason })` is the
    explicit, audited escape hatch for an approved in-period downgrade or
    correction. `policy: 'upgrade'` applies an amended version of the same
    plan mid-period when it only adds.
- **Cancellation** keeps the paid period: a subscription canceled while it
  entitled (`active`/`trialing` within its period) records
  `retainsPaidPeriod` and entitles until `currentPeriodEnd`, then resolves
  nothing. A subscription canceled from `incomplete`, `past_due` or `unpaid`
  (for example a provider's `incomplete_expired`) entitles nothing. For an
  immediate cancellation of a paid period (e.g. with a refund) set
  `currentPeriodEnd` to the cancellation time.

`SubscriptionResolver` resolves entitlements at `options.now` from the pinned
version, not the live plan: editing, archiving, or removing a feature from a
plan never changes a paid period. A pinned version that cannot be found, or
whose status is not `active`, fails closed. `EntitlementResolution` reports
`planVersionId` and `planVersion`; `EntitlementResolutionContext` carries
`planVersion`, validated against the subscription's plan, pin and tenant like
`plan`. Resolvers built from custom readers without `planVersions` keep the
live-plan behavior.

```ts
// A co-op removes a perk. Paying members keep it until their renewal.
plan.setFeatureGrants(['coop:vote']);
await plan.save(); // publishes version 2, effective now

// Schedule an entitlement change from a future date.
plan.setFeatureGrants(['coop:vote', 'coop:shift-swap']);
await plan.publishTerms({ effectiveFrom: new Date('2027-01-01T00:00:00Z') });

// Resolve what a member is entitled to at an instant.
const result = await resolver.resolveEntitlements(subscriber, { now });
result.planVersion; // the version their current period paid for
```

The plan row always shows the latest published terms, including a scheduled
version's. Hosts that charge from the plan row must price from the pinned
version instead; commerce period-close still reads the live row until #4146,
so do not schedule a price change ahead of time while relying on it.

The plan row is written before its version. If publishing fails, the save
rejects with the row already updated and the next save publishes the missing
version; wrap the save in `plan.withTransaction()` when both writes must be
atomic.

### Migrating existing data

1. Run the ordinary manifest migration (`smrt db:migrate`). It adds the
   `_smrt_subscription_plan_versions` table and the nullable `plan_version_id`,
   `plan_version_pinned_at`, `plan_version_pin_reason` and
   `plan_version_pin_note` and `retains_paid_period` columns on
   `_smrt_tenant_subscriptions`. Nothing is dropped or rewritten. Existing
   `canceled` rows default to `retains_paid_period = false`, so they stay
   unentitled exactly as before.
2. Run `migrateSubscriptionPlanVersions(db)` once. Every plan without versions
   gets version 1 — its current terms, effective from the plan's creation —
   and every unpinned subscription is pinned to it with
   `planVersionPinReason: 'migration'`. Entitlements are unchanged. The run is
   idempotent, works across tenants in system context, and reports any
   subscription it could not re-save in `failed` (that row keeps resolving
   through version 1).

Until step 2, unpinned subscriptions to plans without versions keep resolving
from the live plan, and the first edit of such a plan records its pre-edit
terms as version 1 before publishing the change.

## Thresholds and spending

Thresholds define a metric key, time window, limit, and enforcement behavior.
The resolver batches metric reads when possible. Do not bypass tenant context
or repeatedly construct a new resolver inside one request.

Commercial usage records client-facing prices separately from usage evidence.
Spending policy decisions can allow, warn, require approval, or deny based on
the configured behavior and scope.

## Reseller billing

Resellers buy a service at wholesale and resell it to their own child tenants.
Parentage and the billing owner come from `smrt-tenancy`'s
`BillingRelationshipService`; this package prices usage against it.

- **Price books.** A `PriceBook` is published by one seller tenant and is
  either `wholesale` (what a provider charges a reseller) or `retail` (what a
  reseller charges its children). Its prices are ordinary `PricingRule` rows
  carrying the book's `priceBookId`, one row per currency.
- **Assignment per relationship.** `ResellerBillingService.assignPriceBooks()`
  picks, for one child, the wholesale book and currency and (optionally) the
  reseller's retail book and currency. An assignment made under one reseller
  never applies after the child moves to another.
- **Rating.** `CommercialUsageService.rateUsage()` resolves the child's
  relationship and returns a `UsageRating`:
  - self-billed or unrelated tenant: one direct `ClientCharge`, priced exactly
    like `price()`;
  - reseller-billed: a wholesale `ClientCharge` payable by the reseller
    (`tenantId` = reseller, `usageTenantId` = child) and, with a retail book,
    a `RetailCharge` the child owes the reseller, committed together.

  A usage event is rated once. `ClientCharge` keeps exactly one row per usage
  event, so a later billing-owner change returns the original rating instead
  of charging a second payer.
- **Delegated spending.** `setDelegatedSpendingPolicy()` writes a
  `SpendingPolicy` on the child with `setByTenantId` = the parent. The ordinary
  `SpendingPolicyEvaluator` enforces it (observe, warn, approval, block), and
  the child cannot edit, delete, or overwrite it. Parents change or retire
  (`active: false`) their policies through the same method. A policy's `basis` selects
  what it counts: `billed` (what the tenant pays the provider, the default),
  `retail` (what it owes its reseller), or `wholesale` (what the parent pays
  for this child's usage).
- **Prepaid credit.** A `period: 'balance'` policy's limit is the sum of its
  `CreditGrant`s; spend accumulates from `balanceFrom`. Its currency and
  period cannot change once saved; create a new balance instead. Grants are append-only (updates and deletes are refused)
  and idempotent per `source`/`sourceId`. Pass `autoTopUp` to
  `SpendingPolicyEvaluator.create()` to be called when a charge would exhaust a
  balance; return a grant once the host has secured the funds. The evaluator
  never calls a payment provider. Before charging, a hook can call the
  request's `currentShortfall()` to recompute the shortfall against the
  current balance (another evaluation may have topped it up meanwhile); the
  evaluator re-reads the balance after the hook returns either way.
  smrt-commerce's `BillingRuntime.autoTopUpHook()` charges a saved card.

```ts
import { BillingRelationshipService } from '@happyvertical/smrt-tenancy';
import {
  CommercialUsageService,
  ResellerBillingService,
} from '@happyvertical/smrt-subscriptions';

const relationships = await BillingRelationshipService.create({
  db,
  tenantExists,
});
const reseller = await ResellerBillingService.create({
  db,
  billingRelationships: relationships,
});
await reseller.definePrice({
  priceBookId: retailBook.id,
  ruleKey: 'tokens',
  metricKey: 'ai.tokens',
  strategy: 'fixed_unit',
  prices: [
    { currency: 'USD', terms: { unitPrice: 5 } },
    { currency: 'EUR', terms: { unitPrice: 4.6 } },
  ],
});
await reseller.assignPriceBooks({
  childTenantId,
  wholesale: { priceBookId: wholesaleBook.id, currency: 'USD' },
  retail: { priceBookId: retailBook.id, currency: 'EUR' },
});

const rating = await commercial.rateUsage({
  usageEventId,
  billingRelationships: relationships,
  approved: true,
});
```

Mutations require a system context, a super-admin bypass, or a host
`authorize` callback, like `BillingRelationshipService`; a seller may also
define prices in its own book under its own tenant context. The callback
receives the tenant whose authority the action exercises: the book's publisher
for `define_prices` and `assign_wholesale_price_book`, the parent for
`assign_retail_price_book` and `manage_child_spending`. Bind every decision to
the caller, and never authorize a reseller for the wholesale leg that charges
it. The package refuses a wholesale book published by the reseller or child it
would charge, but whether a publisher is a legitimate provider for that
reseller (`resellerTenantId` in the request) is the host's decision. The
calls first read the child's relationship through `BillingRelationshipService`
in the caller's context, so a provider assigning a wholesale leg also needs
that service's `authorize` to grant it `read` for the child. Once
authorized, the service writes in a system context, because a parent's writes
land on rows the child owns.

```ts
const reseller = await ResellerBillingService.create({
  db,
  billingRelationships: relationships,
  authorize: async ({ action, tenantId, resellerTenantId }) => {
    const caller = currentTenantId();
    if (caller !== tenantId || !(await isBillingAdmin(caller))) return false;
    return action === 'assign_wholesale_price_book'
      ? isProviderFor(caller, resellerTenantId)
      : true;
  },
});
```

Rating reads a seller's books across tenants, so run it where the host's
tenancy rules allow that (typically a system context). Spending evaluation can
run in the child's own tenant context: a `wholesale`-basis policy reads only
the sum of the parent's charges for that child's usage. Pass
`billingRelationships` to `SpendingPolicyEvaluator.create()` so a former
parent's delegated policies stop applying after the child changes reseller;
without it they keep applying (fail closed), and the new parent may replace
them by name. A delegated balance counts only credit granted by its current
parent. A former parent's prepaid balance cannot be taken over by name; it
keeps its credit ledger (reversible in a system context), and the new parent
creates its own balance. A parent's `retail` cap counts only what the child owes that
parent.

## Svelte entry point

`@happyvertical/smrt-subscriptions/svelte` exports provider-neutral,
presentational components:

- `PlanPicker`
- `SubscriptionSummary`
- `UsageThresholds`
- `CommercialOverview`

Hosts own data loading and mutation actions.

## Development

```bash
pnpm --filter @happyvertical/smrt-subscriptions test
pnpm --filter @happyvertical/smrt-subscriptions test:postgres
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```

See [`AGENTS.md`](./AGENTS.md) for provider, threshold, and resolver guidance.
