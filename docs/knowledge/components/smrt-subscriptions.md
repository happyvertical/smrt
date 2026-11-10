---
type: "Component"
title: "@happyvertical/smrt-subscriptions"
description: "Tenant subscriptions, entitlement resolution, usage thresholds, and subscription UI for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:af951ae164901d31727a198002bc0188c2f8822a455f415adeaef6d06c2c7234"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/subscriptions/package.json"
    title: "@happyvertical/smrt-subscriptions package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/subscriptions/AGENTS.md"
    title: "@happyvertical/smrt-subscriptions packages/subscriptions/AGENTS.md"
---

# @happyvertical/smrt-subscriptions

## Package

- Directory: `packages/subscriptions`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/subscriptions/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-features](/components/smrt-features.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `BillingAdjustment` (collection `billingadjustments`, extends `SmrtObject`)
- `BillingCheckoutSession` (collection `billingcheckoutsessions`, extends `SmrtObject`)
- `ClientCharge` (collection `clientcharges`, extends `SmrtObject`)
- `CreditGrant` (collection `creditgrants`, extends `SmrtObject`)
- `PriceBook` (collection `pricebooks`, extends `SmrtObject`)
- `PriceBookAssignment` (collection `pricebookassignments`, extends `SmrtObject`)
- `PricingRule` (collection `pricingrules`, extends `SmrtObject`)
- `RetailCharge` (collection `retailcharges`, extends `SmrtObject`)
- `SpendingPolicy` (collection `spendingpolicies`, extends `SmrtObject`)
- `SubscriptionPlan` (collection `subscriptionplans`, extends `SmrtObject`)
- `SubscriptionPlanVersion` (collection `subscriptionplanversions`, extends `SmrtObject`)
- `TenantSubscription` (collection `tenantsubscriptions`, extends `SmrtObject`)
- `TenantUsageMetric` (collection `tenantusagemetrics`, extends `SmrtObject`)

## MCP tools

- `create_pricingrules`: create on `@happyvertical/smrt-subscriptions:PricingRule`
- `create_spendingpolicies`: create on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `delete_pricingrules`: delete on `@happyvertical/smrt-subscriptions:PricingRule`
- `delete_spendingpolicies`: delete on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `get_billingadjustments`: get on `@happyvertical/smrt-subscriptions:BillingAdjustment`
- `get_clientcharges`: get on `@happyvertical/smrt-subscriptions:ClientCharge`
- `get_creditgrants`: get on `@happyvertical/smrt-subscriptions:CreditGrant`
- `get_pricingrules`: get on `@happyvertical/smrt-subscriptions:PricingRule`
- `get_retailcharges`: get on `@happyvertical/smrt-subscriptions:RetailCharge`
- `get_spendingpolicies`: get on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `get_subscriptionplans`: get on `@happyvertical/smrt-subscriptions:SubscriptionPlan`
- `get_subscriptionplanversions`: get on `@happyvertical/smrt-subscriptions:SubscriptionPlanVersion`
- `get_tenantsubscriptions`: get on `@happyvertical/smrt-subscriptions:TenantSubscription`
- `get_tenantusagemetrics`: get on `@happyvertical/smrt-subscriptions:TenantUsageMetric`
- `list_billingadjustments`: list on `@happyvertical/smrt-subscriptions:BillingAdjustment`
- `list_clientcharges`: list on `@happyvertical/smrt-subscriptions:ClientCharge`
- `list_creditgrants`: list on `@happyvertical/smrt-subscriptions:CreditGrant`
- `list_pricingrules`: list on `@happyvertical/smrt-subscriptions:PricingRule`
- `list_retailcharges`: list on `@happyvertical/smrt-subscriptions:RetailCharge`
- `list_spendingpolicies`: list on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `list_subscriptionplans`: list on `@happyvertical/smrt-subscriptions:SubscriptionPlan`
- `list_subscriptionplanversions`: list on `@happyvertical/smrt-subscriptions:SubscriptionPlanVersion`
- `list_tenantsubscriptions`: list on `@happyvertical/smrt-subscriptions:TenantSubscription`
- `list_tenantusagemetrics`: list on `@happyvertical/smrt-subscriptions:TenantUsageMetric`
- `update_pricingrules`: update on `@happyvertical/smrt-subscriptions:PricingRule`
- `update_spendingpolicies`: update on `@happyvertical/smrt-subscriptions:SpendingPolicy`
