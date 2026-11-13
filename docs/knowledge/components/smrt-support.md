---
type: "Component"
title: "@happyvertical/smrt-support"
description: "AI-first Support Cases: channel-neutral intake, lifecycle, routing, service targets, and service time for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T23:43:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:00390b98e4c9a392563b3a05c881f0426250c25a1c3d4977358fe88a42769dd8"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/support/package.json"
    title: "@happyvertical/smrt-support package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/support/AGENTS.md"
    title: "@happyvertical/smrt-support packages/support/AGENTS.md"
---

# @happyvertical/smrt-support

## Package

- Directory: `packages/support`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/support/AGENTS.md`

## Framework dependencies

- [smrt-chat](/components/smrt-chat.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-messages](/components/smrt-messages.md)
- [smrt-projects](/components/smrt-projects.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-timesheets](/components/smrt-timesheets.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `ServiceTimeEntry` (collection `servicetimeentries`, extends `ServiceTimeEntry`)
- `ServiceTimeEntryCollection` (collection `servicetimeentries`, extends `SmrtCollection`)
- `SupportAiRun` (collection `supportairuns`, extends `SmrtObject`)
- `SupportAiRunCollection` (collection `supportairuns`, extends `SmrtCollection`)
- `SupportAvailability` (collection `supportavailabilities`, extends `SmrtObject`)
- `SupportAvailabilityCollection` (collection `supportavailabilities`, extends `SmrtCollection`)
- `SupportCase` (collection `supportcases`, extends `SmrtObject`)
- `SupportCaseCollection` (collection `supportcases`, extends `SmrtCollection`)
- `SupportCaseEvent` (collection `supportcaseevents`, extends `SmrtObject`)
- `SupportCaseEventCollection` (collection `supportcaseevents`, extends `SmrtCollection`)
- `SupportChannelBinding` (collection `supportchannelbindings`, extends `SmrtObject`)
- `SupportChannelBindingCollection` (collection `supportchannelbindings`, extends `SmrtCollection`)
- `SupportCharge` (collection `supportcharges`, extends `SmrtObject`)
- `SupportChargeCollection` (collection `supportcharges`, extends `SmrtCollection`)
- `SupportCompensation` (collection `supportcompensations`, extends `SmrtObject`)
- `SupportCompensationCollection` (collection `supportcompensations`, extends `SmrtCollection`)
- `SupportCompensationPlan` (collection `supportcompensationplans`, extends `SmrtObject`)
- `SupportCompensationPlanCollection` (collection `supportcompensationplans`, extends `SmrtCollection`)
- `SupportEscalation` (collection `supportescalations`, extends `SmrtObject`)
- `SupportEscalationCollection` (collection `supportescalations`, extends `SmrtCollection`)
- `SupportInteraction` (collection `supportinteractions`, extends `SmrtObject`)
- `SupportInteractionCollection` (collection `supportinteractions`, extends `SmrtCollection`)
- `SupportPlan` (collection `supportplans`, extends `SmrtObject`)
- `SupportPlanCollection` (collection `supportplans`, extends `SmrtCollection`)
- `SupportPolicy` (collection `supportpolicies`, extends `SmrtObject`)
- `SupportPolicyCollection` (collection `supportpolicies`, extends `SmrtCollection`)
- `SupportQualification` (collection `supportqualifications`, extends `SmrtObject`)
- `SupportQualificationCollection` (collection `supportqualifications`, extends `SmrtCollection`)
- `SupportServiceTarget` (collection `supportservicetargets`, extends `SmrtObject`)
- `SupportServiceTargetCollection` (collection `supportservicetargets`, extends `SmrtCollection`)
- `SupportSpecialist` (collection `supportspecialists`, extends `SmrtObject`)
- `SupportSpecialistCollection` (collection `supportspecialists`, extends `SmrtCollection`)
- `SupportWorkLink` (collection `supportworklinks`, extends `SmrtObject`)
- `SupportWorkLinkCollection` (collection `supportworklinks`, extends `SmrtCollection`)

## MCP tools

- `servicetimeentry_get`: get on `@happyvertical/smrt-support:ServiceTimeEntry`
- `servicetimeentry_list`: list on `@happyvertical/smrt-support:ServiceTimeEntry`
- `supportairun_get`: get on `@happyvertical/smrt-support:SupportAiRun`
- `supportairun_list`: list on `@happyvertical/smrt-support:SupportAiRun`
- `supportavailability_get`: get on `@happyvertical/smrt-support:SupportAvailability`
- `supportavailability_list`: list on `@happyvertical/smrt-support:SupportAvailability`
- `supportcase_get`: get on `@happyvertical/smrt-support:SupportCase`
- `supportcase_list`: list on `@happyvertical/smrt-support:SupportCase`
- `supportcaseevent_get`: get on `@happyvertical/smrt-support:SupportCaseEvent`
- `supportcaseevent_list`: list on `@happyvertical/smrt-support:SupportCaseEvent`
- `supportchannelbinding_get`: get on `@happyvertical/smrt-support:SupportChannelBinding`
- `supportchannelbinding_list`: list on `@happyvertical/smrt-support:SupportChannelBinding`
- `supportcharge_get`: get on `@happyvertical/smrt-support:SupportCharge`
- `supportcharge_list`: list on `@happyvertical/smrt-support:SupportCharge`
- `supportcompensation_get`: get on `@happyvertical/smrt-support:SupportCompensation`
- `supportcompensation_list`: list on `@happyvertical/smrt-support:SupportCompensation`
- `supportcompensationplan_get`: get on `@happyvertical/smrt-support:SupportCompensationPlan`
- `supportcompensationplan_list`: list on `@happyvertical/smrt-support:SupportCompensationPlan`
- `supportescalation_get`: get on `@happyvertical/smrt-support:SupportEscalation`
- `supportescalation_list`: list on `@happyvertical/smrt-support:SupportEscalation`
- `supportinteraction_get`: get on `@happyvertical/smrt-support:SupportInteraction`
- `supportinteraction_list`: list on `@happyvertical/smrt-support:SupportInteraction`
- `supportplan_get`: get on `@happyvertical/smrt-support:SupportPlan`
- `supportplan_list`: list on `@happyvertical/smrt-support:SupportPlan`
- `supportpolicy_get`: get on `@happyvertical/smrt-support:SupportPolicy`
- `supportpolicy_list`: list on `@happyvertical/smrt-support:SupportPolicy`
- `supportqualification_get`: get on `@happyvertical/smrt-support:SupportQualification`
- `supportqualification_list`: list on `@happyvertical/smrt-support:SupportQualification`
- `supportservicetarget_get`: get on `@happyvertical/smrt-support:SupportServiceTarget`
- `supportservicetarget_list`: list on `@happyvertical/smrt-support:SupportServiceTarget`
- `supportspecialist_get`: get on `@happyvertical/smrt-support:SupportSpecialist`
- `supportspecialist_list`: list on `@happyvertical/smrt-support:SupportSpecialist`
- `supportworklink_get`: get on `@happyvertical/smrt-support:SupportWorkLink`
- `supportworklink_list`: list on `@happyvertical/smrt-support:SupportWorkLink`
