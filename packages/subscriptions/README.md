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

- `SubscriptionPlan` stores versioned feature grants and thresholds.
- `TenantSubscription` binds a tenant or external subscriber to a plan over an
  effective period.
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
  the child cannot edit, delete, or overwrite it. A policy's `basis` selects
  what it counts: `billed` (what the tenant pays the provider, the default),
  `retail` (what it owes its reseller), or `wholesale` (what the parent pays
  for this child's usage).
- **Prepaid credit.** A `period: 'balance'` policy's limit is the sum of its
  `CreditGrant`s; spend accumulates from `balanceFrom`. Grants are append-only
  and idempotent per `source`/`sourceId`. Pass `autoTopUp` to
  `SpendingPolicyEvaluator.create()` to be called when a charge would exhaust a
  balance; return a grant once the host has secured the funds. The evaluator
  never calls a payment provider.

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
