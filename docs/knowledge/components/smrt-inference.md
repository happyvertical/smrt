---
type: "Component"
title: "@happyvertical/smrt-inference"
description: "Inference alias chains with classified failures, recorded fallback and ladder degradation, the smrt doctor --ai binding check, layered app/tenant binding storage and the InferenceSettingsPanel, for SMRT inference tiers"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T15:38:17Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:1efa4f708cf9aa5ddefe1869f1162d3313d7be446d29017369f6451682ab1b6e"
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
- `./server`
- `./svelte`

## Models

- `InferenceOverride` (collection `inferenceoverrides`, extends `SmrtObject`)
- `InferenceOverrideCollection` (collection `inferenceoverrides`, extends `SmrtCollection`)
