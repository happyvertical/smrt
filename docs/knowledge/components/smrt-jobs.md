---
type: "Component"
title: "@happyvertical/smrt-jobs"
description: "Background job processing for SMRT objects with persistence and scheduling"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:2b3e5ba10b5ee9f2a597912a00e16d26e1e519d95ef33a85dabcecb6a177fd44"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/package.json"
    title: "@happyvertical/smrt-jobs package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/jobs/AGENTS.md"
    title: "@happyvertical/smrt-jobs packages/jobs/AGENTS.md"
---

# @happyvertical/smrt-jobs

## Package

- Directory: `packages/jobs`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/jobs/AGENTS.md`

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
- `SmrtJobEvent` (collection `smrtjobevents`, extends `SmrtObject`)
- `SmrtJobEventCollection` (collection `smrtjobevents`, extends `SmrtCollection`)
- `SmrtWorker` (collection `smrtworkers`, extends `SmrtObject`)
- `SmrtWorkerCollection` (collection `smrtworkers`, extends `SmrtCollection`)
