---
type: "Component"
title: "@happyvertical/smrt-inference"
description: "Inference alias chains with classified failures, recorded fallback and ladder degradation, consumer-defined fusions, per-user and per-tenant bindings, the InferenceSettingsPanel, hosted provisioning and spend gate, and the smrt doctor --ai binding check, for SMRT inference tiers"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T05:12:16Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:3129a76ac8f58acf7b9532217f9fca12562c629cb2aed8afb0d33ce8b649ad80"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/package.json"
    title: "@happyvertical/smrt-inference package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/AGENTS.md"
    title: "@happyvertical/smrt-inference packages/inference/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/design-runs.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/design-runs.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/engines.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/engines.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/fusions.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/fusions.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/hosted.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/hosted.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/resolver.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/resolver.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/agents/settings.md"
    title: "@happyvertical/smrt-inference packages/inference/agents/settings.md"
---

# @happyvertical/smrt-inference

## Package

- Directory: `packages/inference`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/inference/AGENTS.md`
- `packages/inference/agents/design-runs.md`
- `packages/inference/agents/engines.md`
- `packages/inference/agents/fusions.md`
- `packages/inference/agents/hosted.md`
- `packages/inference/agents/resolver.md`
- `packages/inference/agents/settings.md`

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
- `./gate`
- `./manifest`
- `./manifest.json`
- `./models`
- `./node`
- `./resolver`
- `./server`
- `./svelte`
- `./test-support`

## Models

- `DesignRunRecord` (collection `designrunrecords`, extends `SmrtObject`)
- `InferenceOverride` (collection `inferenceoverrides`, extends `SmrtObject`)
- `InferenceOverrideCollection` (collection `inferenceoverrides`, extends `SmrtCollection`)
