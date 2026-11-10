---
type: "Component"
title: "@happyvertical/smrt-sales"
description: "Modular sales for the SMRT framework: agreement execution, CRM, referral intake, neutral commissions, and reusable Svelte surfaces"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T22:32:35Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d4873ba74d72d43a63b08a775750f76af40ed6994383f23cd3e92cc9115f0dca"
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
- Object source: `domain-artifact`
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
- `AgreementCollection` (collection `agreements`, extends `SmrtCollection`)
- `AgreementExecution` (collection `agreementexecutions`, extends `SmrtObject`)
- `AgreementExecutionCollection` (collection `agreementexecutions`, extends `SmrtCollection`)
- `AgreementExecutionEvent` (collection `agreementexecutionevents`, extends `SmrtObject`)
- `AgreementExecutionEventCollection` (collection `agreementexecutionevents`, extends `SmrtCollection`)
- `AttributionException` (collection `attributionexceptions`, extends `SmrtObject`)
- `AttributionExceptionCollection` (collection `attributionexceptions`, extends `SmrtCollection`)
- `AttributionPolicy` (collection `attributionpolicies`, extends `SmrtObject`)
- `AttributionPolicyCollection` (collection `attributionpolicies`, extends `SmrtCollection`)
- `Commission` (collection `commissions`, extends `SmrtObject`)
- `CommissionAdjustment` (collection `commissionadjustments`, extends `SmrtObject`)
- `CommissionAdjustmentCollection` (collection `commissionadjustments`, extends `SmrtCollection`)
- `CommissionAdjustmentOperation` (collection `commissionadjustmentoperations`, extends `SmrtObject`)
- `CommissionAdjustmentOperationCollection` (collection `commissionadjustmentoperations`, extends `SmrtCollection`)
- `CommissionCollection` (collection `commissions`, extends `SmrtCollection`)
- `CommissionPayout` (collection `commissionpayouts`, extends `SmrtObject`)
- `CommissionPayoutCollection` (collection `commissionpayouts`, extends `SmrtCollection`)
- `CommissionPlan` (collection `commissionplans`, extends `SmrtObject`)
- `CommissionPlanCollection` (collection `commissionplans`, extends `SmrtCollection`)
- `Earner` (collection `earners`, extends `SmrtObject`)
- `EarnerCollection` (collection `earners`, extends `SmrtCollection`)
- `EarnerSourceAttribution` (collection `earnersourceattributions`, extends `SmrtObject`)
- `EarnerSourceAttributionCollection` (collection `earnersourceattributions`, extends `SmrtCollection`)
- `EarningEvent` (collection `earningevents`, extends `SmrtObject`)
- `EarningEventCollection` (collection `earningevents`, extends `SmrtCollection`)
- `ExecutedAgreement` (collection `executedagreements`, extends `SmrtObject`)
- `ExecutedAgreementCollection` (collection `executedagreements`, extends `SmrtCollection`)
- `Lead` (collection `leads`, extends `SmrtObject`)
- `LeadCollection` (collection `leads`, extends `SmrtCollection`)
- `Opportunity` (collection `opportunities`, extends `SmrtObject`)
- `OpportunityCollection` (collection `opportunities`, extends `SmrtCollection`)
- `OpportunityConversion` (collection `opportunityconversions`, extends `SmrtObject`)
- `OpportunityConversionCollection` (collection `opportunityconversions`, extends `SmrtCollection`)
- `PipelineDefinition` (collection `pipelinedefinitions`, extends `SmrtObject`)
- `PipelineDefinitionCollection` (collection `pipelinedefinitions`, extends `SmrtCollection`)
- `PipelineStage` (collection `pipelinestages`, extends `SmrtObject`)
- `PipelineStageCollection` (collection `pipelinestages`, extends `SmrtCollection`)
- `Referral` (collection `referrals`, extends `SmrtObject`)
- `ReferralAgreement` (collection `referralagreements`, extends `SmrtObject`)
- `ReferralAgreementCollection` (collection `referralagreements`, extends `SmrtCollection`)
- `ReferralClickOperation` (collection `referralclickoperations`, extends `SmrtObject`)
- `ReferralClickOperationCollection` (collection `referralclickoperations`, extends `SmrtCollection`)
- `ReferralCollection` (collection `referrals`, extends `SmrtCollection`)
- `ReferralLink` (collection `referrallinks`, extends `SmrtObject`)
- `ReferralLinkCollection` (collection `referrallinks`, extends `SmrtCollection`)
- `ReferralProgram` (collection `referralprograms`, extends `SmrtObject`)
- `ReferralProgramCollection` (collection `referralprograms`, extends `SmrtCollection`)
- `ReferralTermSnapshot` (collection `referraltermsnapshots`, extends `SmrtObject`)
- `ReferralTermSnapshotCollection` (collection `referraltermsnapshots`, extends `SmrtCollection`)
- `ReferralTouch` (collection `referraltouches`, extends `SmrtObject`)
- `ReferralTouchCollection` (collection `referraltouches`, extends `SmrtCollection`)
- `Referrer` (collection `referrers`, extends `SmrtObject`)
- `ReferrerCollection` (collection `referrers`, extends `SmrtCollection`)
- `ReferrerIdentifier` (collection `referreridentifiers`, extends `SmrtObject`)
- `ReferrerIdentifierCollection` (collection `referreridentifiers`, extends `SmrtCollection`)
- `SalesActivity` (collection `salesactivities`, extends `SmrtObject`)
- `SalesActivityCollection` (collection `salesactivities`, extends `SmrtCollection`)
- `SalesGovernanceEvent` (collection `salesgovernanceevents`, extends `SmrtObject`)
- `SalesGovernanceEventCollection` (collection `salesgovernanceevents`, extends `SmrtCollection`)
- `SalesGovernanceState` (collection `salesgovernancestates`, extends `SmrtObject`)
- `SalesGovernanceStateCollection` (collection `salesgovernancestates`, extends `SmrtCollection`)
- `SalesRepresentative` (collection `salesrepresentatives`, extends `SmrtObject`)
- `SalesRepresentativeCollection` (collection `salesrepresentatives`, extends `SmrtCollection`)

## MCP tools

- `agreement_get`: get on `@happyvertical/smrt-sales:Agreement`
- `agreement_list`: list on `@happyvertical/smrt-sales:Agreement`
- `attributionexception_get`: get on `@happyvertical/smrt-sales:AttributionException`
- `attributionexception_list`: list on `@happyvertical/smrt-sales:AttributionException`
- `attributionpolicy_get`: get on `@happyvertical/smrt-sales:AttributionPolicy`
- `attributionpolicy_list`: list on `@happyvertical/smrt-sales:AttributionPolicy`
- `commission_get`: get on `@happyvertical/smrt-sales:Commission`
- `commission_list`: list on `@happyvertical/smrt-sales:Commission`
- `commissionadjustment_create`: create on `@happyvertical/smrt-sales:CommissionAdjustment`
- `commissionadjustment_list`: list on `@happyvertical/smrt-sales:CommissionAdjustment`
- `commissionpayout_get`: get on `@happyvertical/smrt-sales:CommissionPayout`
- `commissionpayout_list`: list on `@happyvertical/smrt-sales:CommissionPayout`
- `commissionplan_get`: get on `@happyvertical/smrt-sales:CommissionPlan`
- `commissionplan_list`: list on `@happyvertical/smrt-sales:CommissionPlan`
- `earner_create`: create on `@happyvertical/smrt-sales:Earner`
- `earner_get`: get on `@happyvertical/smrt-sales:Earner`
- `earner_list`: list on `@happyvertical/smrt-sales:Earner`
- `earnersourceattribution_create`: create on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `earnersourceattribution_get`: get on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `earnersourceattribution_list`: list on `@happyvertical/smrt-sales:EarnerSourceAttribution`
- `earningevent_create`: create on `@happyvertical/smrt-sales:EarningEvent`
- `earningevent_list`: list on `@happyvertical/smrt-sales:EarningEvent`
- `executedagreement_get`: get on `@happyvertical/smrt-sales:ExecutedAgreement`
- `executedagreement_list`: list on `@happyvertical/smrt-sales:ExecutedAgreement`
- `lead_create`: create on `@happyvertical/smrt-sales:Lead`
- `lead_get`: get on `@happyvertical/smrt-sales:Lead`
- `lead_list`: list on `@happyvertical/smrt-sales:Lead`
- `opportunity_get`: get on `@happyvertical/smrt-sales:Opportunity`
- `opportunity_list`: list on `@happyvertical/smrt-sales:Opportunity`
- `opportunityconversion_get`: get on `@happyvertical/smrt-sales:OpportunityConversion`
- `opportunityconversion_list`: list on `@happyvertical/smrt-sales:OpportunityConversion`
- `pipelinedefinition_get`: get on `@happyvertical/smrt-sales:PipelineDefinition`
- `pipelinedefinition_list`: list on `@happyvertical/smrt-sales:PipelineDefinition`
- `pipelinestage_get`: get on `@happyvertical/smrt-sales:PipelineStage`
- `pipelinestage_list`: list on `@happyvertical/smrt-sales:PipelineStage`
- `referral_get`: get on `@happyvertical/smrt-sales:Referral`
- `referral_list`: list on `@happyvertical/smrt-sales:Referral`
- `referralagreement_get`: get on `@happyvertical/smrt-sales:ReferralAgreement`
- `referralagreement_list`: list on `@happyvertical/smrt-sales:ReferralAgreement`
- `referrallink_create`: create on `@happyvertical/smrt-sales:ReferralLink`
- `referrallink_get`: get on `@happyvertical/smrt-sales:ReferralLink`
- `referrallink_list`: list on `@happyvertical/smrt-sales:ReferralLink`
- `referralprogram_get`: get on `@happyvertical/smrt-sales:ReferralProgram`
- `referralprogram_list`: list on `@happyvertical/smrt-sales:ReferralProgram`
- `referraltermsnapshot_get`: get on `@happyvertical/smrt-sales:ReferralTermSnapshot`
- `referraltermsnapshot_list`: list on `@happyvertical/smrt-sales:ReferralTermSnapshot`
- `referraltouch_create`: create on `@happyvertical/smrt-sales:ReferralTouch`
- `referraltouch_list`: list on `@happyvertical/smrt-sales:ReferralTouch`
- `referrer_create`: create on `@happyvertical/smrt-sales:Referrer`
- `referrer_get`: get on `@happyvertical/smrt-sales:Referrer`
- `referrer_list`: list on `@happyvertical/smrt-sales:Referrer`
- `referreridentifier_get`: get on `@happyvertical/smrt-sales:ReferrerIdentifier`
- `referreridentifier_list`: list on `@happyvertical/smrt-sales:ReferrerIdentifier`
- `salesactivity_create`: create on `@happyvertical/smrt-sales:SalesActivity`
- `salesactivity_list`: list on `@happyvertical/smrt-sales:SalesActivity`
- `salesrepresentative_get`: get on `@happyvertical/smrt-sales:SalesRepresentative`
- `salesrepresentative_list`: list on `@happyvertical/smrt-sales:SalesRepresentative`
