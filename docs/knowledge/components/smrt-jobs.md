---
type: "Component"
title: "@happyvertical/smrt-jobs"
description: "Background job processing for SMRT objects with persistence and scheduling"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T23:43:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:e544be6e720e274b3e631842264fb8bf4f62db5d816513185c5570ee418a49ae"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/package.json"
    title: "@happyvertical/smrt-jobs package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/AGENTS.md"
    title: "@happyvertical/smrt-jobs packages/jobs/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/agents/provider-loading.md"
    title: "@happyvertical/smrt-jobs packages/jobs/agents/provider-loading.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/agents/scheduling.md"
    title: "@happyvertical/smrt-jobs packages/jobs/agents/scheduling.md"
---

# @happyvertical/smrt-jobs

## Package

- Directory: `packages/jobs`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/jobs/AGENTS.md`
- `packages/jobs/agents/provider-loading.md`
- `packages/jobs/agents/scheduling.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/jobs`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./runner`
- `./svelte`
- `./ui`
- `./worker-liveness-thread`

## Models

- `ForgeDelivery` (collection `forgedeliveries`, extends `SmrtObject`)
- `ForgeDeliveryCollection` (collection `forgedeliveries`, extends `SmrtCollection`)
- `ForgeProjectionCheckpoint` (collection `forgeprojectioncheckpoints`, extends `SmrtObject`)
- `SmrtJob` (collection `smrtjobs`, extends `SmrtObject`)
- `SmrtJobCollection` (collection `smrtjobs`, extends `SmrtCollection`)
- `SmrtJobDedupeSlot` (collection `smrtjobdedupeslots`, extends `SmrtObject`)
- `SmrtJobDedupeSlotCollection` (collection `smrtjobdedupeslots`, extends `SmrtCollection`)
- `SmrtJobEvent` (collection `smrtjobevents`, extends `SmrtObject`)
- `SmrtJobEventCollection` (collection `smrtjobevents`, extends `SmrtCollection`)
- `SmrtWorker` (collection `smrtworkers`, extends `SmrtObject`)
- `SmrtWorkerCollection` (collection `smrtworkers`, extends `SmrtCollection`)
