---
type: "Component"
title: "@happyvertical/smrt-subscriptions"
description: "Tenant subscriptions, entitlement resolution, usage thresholds, and subscription UI for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T03:10:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:c878a8f484fc9305e5783cb9494dacd2b0be5a585b12d6e97fbeafa100b59633"
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
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/subscriptions/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-features](/components/smrt-features.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
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
- `BillingAdjustmentCollection` (collection `billingadjustments`, extends `SmrtCollection`)
- `ClientCharge` (collection `clientcharges`, extends `SmrtObject`)
- `ClientChargeCollection` (collection `clientcharges`, extends `SmrtCollection`)
- `CreditGrant` (collection `creditgrants`, extends `SmrtObject`)
- `CreditGrantCollection` (collection `creditgrants`, extends `SmrtCollection`)
- `PriceBook` (collection `pricebooks`, extends `SmrtObject`)
- `PriceBookAssignment` (collection `pricebookassignments`, extends `SmrtObject`)
- `PriceBookAssignmentCollection` (collection `pricebookassignments`, extends `SmrtCollection`)
- `PriceBookCollection` (collection `pricebooks`, extends `SmrtCollection`)
- `PricingRule` (collection `pricingrules`, extends `SmrtObject`)
- `PricingRuleCollection` (collection `pricingrules`, extends `SmrtCollection`)
- `RetailCharge` (collection `retailcharges`, extends `SmrtObject`)
- `RetailChargeCollection` (collection `retailcharges`, extends `SmrtCollection`)
- `SpendingPolicy` (collection `spendingpolicies`, extends `SmrtObject`)
- `SpendingPolicyCollection` (collection `spendingpolicies`, extends `SmrtCollection`)
- `SubscriptionPlan` (collection `subscriptionplans`, extends `SmrtObject`)
- `SubscriptionPlanCollection` (collection `subscriptionplans`, extends `SmrtCollection`)
- `SubscriptionPlanVersion` (collection `subscriptionplanversions`, extends `SmrtObject`)
- `SubscriptionPlanVersionCollection` (collection `subscriptionplanversions`, extends `SmrtCollection`)
- `TenantSubscription` (collection `tenantsubscriptions`, extends `SmrtObject`)
- `TenantSubscriptionCollection` (collection `tenantsubscriptions`, extends `SmrtCollection`)
- `TenantUsageMetric` (collection `tenantusagemetrics`, extends `SmrtObject`)
- `TenantUsageMetricCollection` (collection `tenantusagemetrics`, extends `SmrtCollection`)

## MCP tools

- `billingadjustment_get`: get on `@happyvertical/smrt-subscriptions:BillingAdjustment`
- `billingadjustment_list`: list on `@happyvertical/smrt-subscriptions:BillingAdjustment`
- `clientcharge_get`: get on `@happyvertical/smrt-subscriptions:ClientCharge`
- `clientcharge_list`: list on `@happyvertical/smrt-subscriptions:ClientCharge`
- `creditgrant_get`: get on `@happyvertical/smrt-subscriptions:CreditGrant`
- `creditgrant_list`: list on `@happyvertical/smrt-subscriptions:CreditGrant`
- `pricingrule_create`: create on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_delete`: delete on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_get`: get on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_getterms`: getTerms on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_list`: list on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_setterms`: setTerms on `@happyvertical/smrt-subscriptions:PricingRule`
- `pricingrule_update`: update on `@happyvertical/smrt-subscriptions:PricingRule`
- `retailcharge_get`: get on `@happyvertical/smrt-subscriptions:RetailCharge`
- `retailcharge_list`: list on `@happyvertical/smrt-subscriptions:RetailCharge`
- `spendingpolicy_create`: create on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `spendingpolicy_delete`: delete on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `spendingpolicy_get`: get on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `spendingpolicy_list`: list on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `spendingpolicy_update`: update on `@happyvertical/smrt-subscriptions:SpendingPolicy`
- `subscriptionplan_get`: get on `@happyvertical/smrt-subscriptions:SubscriptionPlan`
- `subscriptionplan_list`: list on `@happyvertical/smrt-subscriptions:SubscriptionPlan`
- `subscriptionplanversion_get`: get on `@happyvertical/smrt-subscriptions:SubscriptionPlanVersion`
- `subscriptionplanversion_list`: list on `@happyvertical/smrt-subscriptions:SubscriptionPlanVersion`
- `tenantsubscription_get`: get on `@happyvertical/smrt-subscriptions:TenantSubscription`
- `tenantsubscription_list`: list on `@happyvertical/smrt-subscriptions:TenantSubscription`
- `tenantusagemetric_get`: get on `@happyvertical/smrt-subscriptions:TenantUsageMetric`
- `tenantusagemetric_list`: list on `@happyvertical/smrt-subscriptions:TenantUsageMetric`
