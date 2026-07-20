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
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```

See [`AGENTS.md`](./AGENTS.md) for provider, threshold, and resolver guidance.
