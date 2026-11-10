---
type: "Component"
title: "@happyvertical/smrt-sales"
description: "Modular sales for the SMRT framework: agreement execution, CRM, referral intake, neutral commissions, and reusable Svelte surfaces"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:1c5c2d3c5ec417a74003551d1ed50dcf0940bed93991a3cb5f63c5a947250b17"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/package.json"
    title: "@happyvertical/smrt-sales package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/AGENTS.md"
    title: "@happyvertical/smrt-sales packages/sales/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/agents/agreements.md"
    title: "@happyvertical/smrt-sales packages/sales/agents/agreements.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/agents/commissions.md"
    title: "@happyvertical/smrt-sales packages/sales/agents/commissions.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/agents/crm.md"
    title: "@happyvertical/smrt-sales packages/sales/agents/crm.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/agents/referrals.md"
    title: "@happyvertical/smrt-sales packages/sales/agents/referrals.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/sales/agents/svelte.md"
    title: "@happyvertical/smrt-sales packages/sales/agents/svelte.md"
---

# @happyvertical/smrt-sales

## Package

- Directory: `packages/sales`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/sales/AGENTS.md`
- `packages/sales/agents/agreements.md`
- `packages/sales/agents/commissions.md`
- `packages/sales/agents/crm.md`
- `packages/sales/agents/referrals.md`
- `packages/sales/agents/svelte.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./agreements`
- `./commissions`
- `./crm`
- `./manifest`
- `./manifest.json`
- `./referrals`
- `./svelte`

## Models

- `Agreement` (collection `agreements`, extends `SmrtObject`)
- `AgreementExecution` (collection `agreementexecutions`, extends `SmrtObject`)
- `AgreementExecutionEvent` (collection `agreementexecutionevents`, extends `SmrtObject`)
- `AttributionException` (collection `attributionexceptions`, extends `SmrtObject`)
- `AttributionPolicy` (collection `attributionpolicies`, extends `SmrtObject`)
- `Commission` (collection `commissions`, extends `SmrtObject`)
- `CommissionAdjustment` (collection `commissionadjustments`, extends `SmrtObject`)
- `CommissionAdjustmentOperation` (collection `commissionadjustmentoperations`, extends `SmrtObject`)
- `CommissionPayout` (collection `commissionpayouts`, extends `SmrtObject`)
- `CommissionPlan` (collection `commissionplans`, extends `SmrtObject`)
- `Earner` (collection `earners`, extends `SmrtObject`)
- `EarnerSourceAttribution` (collection `earnersourceattributions`, extends `SmrtObject`)
- `EarningEvent` (collection `earningevents`, extends `SmrtObject`)
- `ExecutedAgreement` (collection `executedagreements`, extends `SmrtObject`)
- `Lead` (collection `leads`, extends `SmrtObject`)
- `Opportunity` (collection `opportunities`, extends `SmrtObject`)
- `OpportunityConversion` (collection `opportunityconversions`, extends `SmrtObject`)
- `PipelineDefinition` (collection `pipelinedefinitions`, extends `SmrtObject`)
- `PipelineStage` (collection `pipelinestages`, extends `SmrtObject`)
- `Referral` (collection `referrals`, extends `SmrtObject`)
- `ReferralAgreement` (collection `referralagreements`, extends `SmrtObject`)
- `ReferralClickOperation` (collection `referralclickoperations`, extends `SmrtObject`)
- `ReferralLink` (collection `referrallinks`, extends `SmrtObject`)
- `ReferralProgram` (collection `referralprograms`, extends `SmrtObject`)
- `ReferralTermSnapshot` (collection `referraltermsnapshots`, extends `SmrtObject`)
- `ReferralTouch` (collection `referraltouches`, extends `SmrtObject`)
- `Referrer` (collection `referrers`, extends `SmrtObject`)
- `ReferrerIdentifier` (collection `referreridentifiers`, extends `SmrtObject`)
- `SalesActivity` (collection `salesactivities`, extends `SmrtObject`)
- `SalesGovernanceEvent` (collection `salesgovernanceevents`, extends `SmrtObject`)
- `SalesGovernanceState` (collection `salesgovernancestates`, extends `SmrtObject`)
- `SalesRepresentative` (collection `salesrepresentatives`, extends `SmrtObject`)

## MCP tools

- `create_commissionadjustments`: create on `@happyvertical/smrt-sales:CommissionAdjustment`
- `create_earners`: create on `@happyvertical/smrt-sales:Earner`
- `create_earnersourceattributions`: create on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `create_earningevents`: create on `@happyvertical/smrt-sales:EarningEvent`
- `create_leads`: create on `@happyvertical/smrt-sales:Lead`
- `create_referrallinks`: create on `@happyvertical/smrt-sales:ReferralLink`
- `create_referraltouches`: create on `@happyvertical/smrt-sales:ReferralTouch`
- `create_referrers`: create on `@happyvertical/smrt-sales:Referrer`
- `create_salesactivities`: create on `@happyvertical/smrt-sales:SalesActivity`
- `get_agreements`: get on `@happyvertical/smrt-sales:Agreement`
- `get_attributionexceptions`: get on `@happyvertical/smrt-sales:AttributionException`
- `get_attributionpolicies`: get on `@happyvertical/smrt-sales:AttributionPolicy`
- `get_commissionpayouts`: get on `@happyvertical/smrt-sales:CommissionPayout`
- `get_commissionplans`: get on `@happyvertical/smrt-sales:CommissionPlan`
- `get_commissions`: get on `@happyvertical/smrt-sales:Commission`
- `get_earners`: get on `@happyvertical/smrt-sales:Earner`
- `get_earnersourceattributions`: get on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `get_executedagreements`: get on `@happyvertical/smrt-sales:ExecutedAgreement`
- `get_leads`: get on `@happyvertical/smrt-sales:Lead`
- `get_opportunities`: get on `@happyvertical/smrt-sales:Opportunity`
- `get_opportunityconversions`: get on `@happyvertical/smrt-sales:OpportunityConversion`
- `get_pipelinedefinitions`: get on `@happyvertical/smrt-sales:PipelineDefinition`
- `get_pipelinestages`: get on `@happyvertical/smrt-sales:PipelineStage`
- `get_referralagreements`: get on `@happyvertical/smrt-sales:ReferralAgreement`
- `get_referrallinks`: get on `@happyvertical/smrt-sales:ReferralLink`
- `get_referralprograms`: get on `@happyvertical/smrt-sales:ReferralProgram`
- `get_referrals`: get on `@happyvertical/smrt-sales:Referral`
- `get_referraltermsnapshots`: get on `@happyvertical/smrt-sales:ReferralTermSnapshot`
- `get_referreridentifiers`: get on `@happyvertical/smrt-sales:ReferrerIdentifier`
- `get_referrers`: get on `@happyvertical/smrt-sales:Referrer`
- `get_salesrepresentatives`: get on `@happyvertical/smrt-sales:SalesRepresentative`
- `list_agreements`: list on `@happyvertical/smrt-sales:Agreement`
- `list_attributionexceptions`: list on `@happyvertical/smrt-sales:AttributionException`
- `list_attributionpolicies`: list on `@happyvertical/smrt-sales:AttributionPolicy`
- `list_commissionadjustments`: list on `@happyvertical/smrt-sales:CommissionAdjustment`
- `list_commissionpayouts`: list on `@happyvertical/smrt-sales:CommissionPayout`
- `list_commissionplans`: list on `@happyvertical/smrt-sales:CommissionPlan`
- `list_commissions`: list on `@happyvertical/smrt-sales:Commission`
- `list_earners`: list on `@happyvertical/smrt-sales:Earner`
- `list_earnersourceattributions`: list on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `list_earningevents`: list on `@happyvertical/smrt-sales:EarningEvent`
- `list_executedagreements`: list on `@happyvertical/smrt-sales:ExecutedAgreement`
- `list_leads`: list on `@happyvertical/smrt-sales:Lead`
- `list_opportunities`: list on `@happyvertical/smrt-sales:Opportunity`
- `list_opportunityconversions`: list on `@happyvertical/smrt-sales:OpportunityConversion`
- `list_pipelinedefinitions`: list on `@happyvertical/smrt-sales:PipelineDefinition`
- `list_pipelinestages`: list on `@happyvertical/smrt-sales:PipelineStage`
- `list_referralagreements`: list on `@happyvertical/smrt-sales:ReferralAgreement`
- `list_referrallinks`: list on `@happyvertical/smrt-sales:ReferralLink`
- `list_referralprograms`: list on `@happyvertical/smrt-sales:ReferralProgram`
- `list_referrals`: list on `@happyvertical/smrt-sales:Referral`
- `list_referraltermsnapshots`: list on `@happyvertical/smrt-sales:ReferralTermSnapshot`
- `list_referraltouches`: list on `@happyvertical/smrt-sales:ReferralTouch`
- `list_referreridentifiers`: list on `@happyvertical/smrt-sales:ReferrerIdentifier`
- `list_referrers`: list on `@happyvertical/smrt-sales:Referrer`
- `list_salesactivities`: list on `@happyvertical/smrt-sales:SalesActivity`
- `list_salesrepresentatives`: list on `@happyvertical/smrt-sales:SalesRepresentative`
