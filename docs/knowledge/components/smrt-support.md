---
type: "Component"
title: "@happyvertical/smrt-support"
description: "AI-first Support Cases: channel-neutral intake, lifecycle, routing, service targets, and service time for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:a796bb54766381a91f864a3cc6aa2871e225f720e011b519c718c80f162165fc"
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
- Object source: `scanner`
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
- `SupportAiRun` (collection `supportairuns`, extends `SmrtObject`)
- `SupportAvailability` (collection `supportavailabilities`, extends `SmrtObject`)
- `SupportCase` (collection `supportcases`, extends `SmrtObject`)
- `SupportCaseEvent` (collection `supportcaseevents`, extends `SmrtObject`)
- `SupportChannelBinding` (collection `supportchannelbindings`, extends `SmrtObject`)
- `SupportCharge` (collection `supportcharges`, extends `SmrtObject`)
- `SupportCompensation` (collection `supportcompensations`, extends `SmrtObject`)
- `SupportCompensationPlan` (collection `supportcompensationplans`, extends `SmrtObject`)
- `SupportEscalation` (collection `supportescalations`, extends `SmrtObject`)
- `SupportInteraction` (collection `supportinteractions`, extends `SmrtObject`)
- `SupportPlan` (collection `supportplans`, extends `SmrtObject`)
- `SupportPolicy` (collection `supportpolicies`, extends `SmrtObject`)
- `SupportQualification` (collection `supportqualifications`, extends `SmrtObject`)
- `SupportServiceTarget` (collection `supportservicetargets`, extends `SmrtObject`)
- `SupportSpecialist` (collection `supportspecialists`, extends `SmrtObject`)
- `SupportWorkLink` (collection `supportworklinks`, extends `SmrtObject`)

## MCP tools

- `get_servicetimeentries`: get on `@happyvertical/smrt-support:ServiceTimeEntry`
- `get_supportairuns`: get on `@happyvertical/smrt-support:SupportAiRun`
- `get_supportavailabilities`: get on `@happyvertical/smrt-support:SupportAvailability`
- `get_supportcaseevents`: get on `@happyvertical/smrt-support:SupportCaseEvent`
- `get_supportcases`: get on `@happyvertical/smrt-support:SupportCase`
- `get_supportchannelbindings`: get on `@happyvertical/smrt-support:SupportChannelBinding`
- `get_supportcharges`: get on `@happyvertical/smrt-support:SupportCharge`
- `get_supportcompensationplans`: get on `@happyvertical/smrt-support:SupportCompensationPlan`
- `get_supportcompensations`: get on `@happyvertical/smrt-support:SupportCompensation`
- `get_supportescalations`: get on `@happyvertical/smrt-support:SupportEscalation`
- `get_supportinteractions`: get on `@happyvertical/smrt-support:SupportInteraction`
- `get_supportplans`: get on `@happyvertical/smrt-support:SupportPlan`
- `get_supportpolicies`: get on `@happyvertical/smrt-support:SupportPolicy`
- `get_supportqualifications`: get on `@happyvertical/smrt-support:SupportQualification`
- `get_supportservicetargets`: get on `@happyvertical/smrt-support:SupportServiceTarget`
- `get_supportspecialists`: get on `@happyvertical/smrt-support:SupportSpecialist`
- `get_supportworklinks`: get on `@happyvertical/smrt-support:SupportWorkLink`
- `list_servicetimeentries`: list on `@happyvertical/smrt-support:ServiceTimeEntry`
- `list_supportairuns`: list on `@happyvertical/smrt-support:SupportAiRun`
- `list_supportavailabilities`: list on `@happyvertical/smrt-support:SupportAvailability`
- `list_supportcaseevents`: list on `@happyvertical/smrt-support:SupportCaseEvent`
- `list_supportcases`: list on `@happyvertical/smrt-support:SupportCase`
- `list_supportchannelbindings`: list on `@happyvertical/smrt-support:SupportChannelBinding`
- `list_supportcharges`: list on `@happyvertical/smrt-support:SupportCharge`
- `list_supportcompensationplans`: list on `@happyvertical/smrt-support:SupportCompensationPlan`
- `list_supportcompensations`: list on `@happyvertical/smrt-support:SupportCompensation`
- `list_supportescalations`: list on `@happyvertical/smrt-support:SupportEscalation`
- `list_supportinteractions`: list on `@happyvertical/smrt-support:SupportInteraction`
- `list_supportplans`: list on `@happyvertical/smrt-support:SupportPlan`
- `list_supportpolicies`: list on `@happyvertical/smrt-support:SupportPolicy`
- `list_supportqualifications`: list on `@happyvertical/smrt-support:SupportQualification`
- `list_supportservicetargets`: list on `@happyvertical/smrt-support:SupportServiceTarget`
- `list_supportspecialists`: list on `@happyvertical/smrt-support:SupportSpecialist`
- `list_supportworklinks`: list on `@happyvertical/smrt-support:SupportWorkLink`
