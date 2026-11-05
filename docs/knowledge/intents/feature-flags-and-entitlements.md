---
type: Capability
title: "Feature flags and entitlements"
description: "Reach for smrt-features for tenant-aware flags and smrt-subscriptions for plan entitlements and usage thresholds."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/features/src/feature-resolver.ts
    path: packages/features/src/feature-resolver.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/features/src/feature-resolver.ts (FeatureResolver.isEnabled, resolveBaseState)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/subscriptions/src/services/subscription-resolver.ts
    path: packages/subscriptions/src/services/subscription-resolver.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/subscriptions/src/services/subscription-resolver.ts (SubscriptionResolver)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/subscriptions/src/index.ts
    path: packages/subscriptions/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/subscriptions/src/index.ts (public exports)"
---

# Feature flags and entitlements

# Entry point

Flags: import `FeatureResolver` from `@happyvertical/smrt-features` and call `isEnabled(featureKey, { tenantId })` or `isEnabledFor(Class, localId, ctx)`. Defaults are declared in code and synced with `FeatureSyncService`; changes are written through `FeatureOverrideService` as global or tenant `FeatureOverride` rows. Entitlements: `SubscriptionResolver` (resolves a subscriber's plan terms and thresholds into an `EntitlementResolution`) and `TenantUsageMeter` (`record()`/`summarize()`) from `@happyvertical/smrt-subscriptions`.[^s3]

# Why not hand-roll it

`FeatureResolver.isEnabled()` in `feature-resolver.ts` resolves the registry default, then the global override, then walks the tenant's ancestor chain applying each tenant override, inheriting down the chain only where the parent has `cascadePermissions` and the child `inheritPermissions`, and it throws for a key that is neither registered nor synced instead of returning false.[^s1] It also strips host list bounds from its reads, because a configured default list limit would drop an ancestor override and silently change the resolved value (#3056).[^s1] `SubscriptionResolver` resolves terms from the plan version frozen on the subscription, fails closed when a pinned version cannot be found, and rejects a plan whose tenant does not match the subscription.[^s2] An environment variable or a column on the tenant row has no inheritance, audit or pinned-version semantics.

# Component pages

- [smrt-features](/components/smrt-features.md)
- [smrt-subscriptions](/components/smrt-subscriptions.md)

# Detection signals

- `import:launchdarkly-node-server-sdk`
- `import:unleash-client`
- `import:flagsmith-nodejs`
- `import:@growthbook/growthbook`
- `regex:FEATURE_[A-Z_]+`
- `regex:plan\s*===`

[^s1]: `packages/features/src/feature-resolver.ts` at `478ae36900`: FeatureResolver.isEnabled, resolveBaseState.
[^s2]: `packages/subscriptions/src/services/subscription-resolver.ts` at `478ae36900`: SubscriptionResolver.
[^s3]: `packages/subscriptions/src/index.ts` at `478ae36900`: public exports.
