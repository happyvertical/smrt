---
type: "Component"
title: "@happyvertical/smrt-ingestion"
description: "Durable tenant-scoped intake and evidence foundations"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:55:44Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:ec8f69f2bf9aa0295dd582ba5e0f7920249b21e3b8661b8148358bcb41509cba"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/package.json"
    title: "@happyvertical/smrt-ingestion package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/AGENTS.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/EXTRACTION.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/EXTRACTION.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/FEEDBACK.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/FEEDBACK.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/PROPOSALS.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/PROPOSALS.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/README.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/README.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/REVIEW.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/REVIEW.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ingestion/agents/execution.md"
    title: "@happyvertical/smrt-ingestion packages/ingestion/agents/execution.md"
---

# @happyvertical/smrt-ingestion

## Package

- Directory: `packages/ingestion`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/ingestion/AGENTS.md`
- `packages/ingestion/EXTRACTION.md`
- `packages/ingestion/FEEDBACK.md`
- `packages/ingestion/PROPOSALS.md`
- `packages/ingestion/README.md`
- `packages/ingestion/REVIEW.md`
- `packages/ingestion/agents/execution.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-assets](/components/smrt-assets.md)
- [smrt-content](/components/smrt-content.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-messages](/components/smrt-messages.md)
- [smrt-playbooks](/components/smrt-playbooks.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/email`
- `@happyvertical/ocr`
- `@happyvertical/pdf`
- `@happyvertical/sql`

## Exports

- `.`
- `./dto`
- `./execution`
- `./manifest`
- `./manifest.json`
- `./models`
- `./proposals`
- `./server`
- `./svelte`

## Models

- `IntakeAction` (collection `intakeactions`, extends `SmrtObject`)
- `IntakeAnalysis` (collection `intakeanalysises`, extends `SmrtObject`)
- `IntakeAnalysisAttempt` (collection `intakeanalysisattempts`, extends `SmrtObject`)
- `IntakeDeletion` (collection `intakedeletions`, extends `SmrtObject`)
- `IntakeDispatch` (collection `intakedispatches`, extends `SmrtObject`)
- `IntakeDisposition` (collection `intakedispositions`, extends `SmrtObject`)
- `IntakeEvidence` (collection `intakeevidences`, extends `SmrtObject`)
- `IntakeExecution` (collection `intakeexecutions`, extends `SmrtObject`)
- `IntakeFeedback` (collection `intakefeedbacks`, extends `SmrtObject`)
- `IntakeItem` (collection `intakeitems`, extends `SmrtObject`)
- `IntakePlan` (collection `intakeplans`, extends `SmrtObject`)
- `IntakeProposal` (collection `intakeproposals`, extends `SmrtObject`)
- `IntakeReviewDecision` (collection `intakereviewdecisions`, extends `SmrtObject`)

## Agent surface diagnostics

- Non-static declarations: 7
