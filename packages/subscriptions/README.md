# @happyvertical/smrt-subscriptions

Tenant plans, feature grants, immutable usage evidence, effective-dated pricing, scoped spending policies, and entitlement resolution.

## Installation

```bash
pnpm add @happyvertical/smrt-subscriptions
```

## Main APIs

Use `SubscriptionResolver.create()` once per request, or inject a resolver and reuse an `EntitlementResolutionContext` when checking several features. Provider bindings may store Stripe identifiers, but runtime payment calls belong behind the HappyVertical SDK accounting provider.

The Svelte exports are provider-neutral presentational surfaces; host applications supply actions and provider-specific flows.

## Validation

```bash
pnpm --filter @happyvertical/smrt-subscriptions test
pnpm --filter @happyvertical/smrt-subscriptions typecheck
pnpm --filter @happyvertical/smrt-subscriptions build
```
