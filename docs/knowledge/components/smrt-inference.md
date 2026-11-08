---
type: "Component"
title: "@happyvertical/smrt-inference"
description: "Inference alias chains with classified failures, recorded fallback and ladder degradation, the smrt doctor --ai binding check, layered app/tenant binding storage and the InferenceSettingsPanel, for SMRT inference tiers"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T23:10:26Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d8f95f9198994ee1196c4da0640d0feae84936b8f20ad6114883a415e8651998"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/package.json"
    title: "@happyvertical/smrt-inference package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/AGENTS.md"
    title: "@happyvertical/smrt-inference packages/inference/AGENTS.md"
---

# @happyvertical/smrt-inference

## Package

- Directory: `packages/inference`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/inference/AGENTS.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./models`
- `./node`
- `./resolver`
- `./server`
- `./svelte`

## Models

- `InferenceOverride` (collection `inferenceoverrides`, extends `SmrtObject`)
- `InferenceOverrideCollection` (collection `inferenceoverrides`, extends `SmrtCollection`)
