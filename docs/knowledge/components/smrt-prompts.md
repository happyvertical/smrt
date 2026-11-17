---
type: "Component"
title: "@happyvertical/smrt-prompts"
description: "Typed prompt registry, override resolution, and tenant-aware prompt settings for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-17T02:21:12Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:9491f38b7b0afa49765933985af88e36a08d6c395eefa7374d3c58f5b9d54fa9"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/prompts/package.json"
    title: "@happyvertical/smrt-prompts package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/prompts/AGENTS.md"
    title: "@happyvertical/smrt-prompts packages/prompts/AGENTS.md"
---

# @happyvertical/smrt-prompts

## Package

- Directory: `packages/prompts`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/prompts/AGENTS.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `PromptOverride` (collection `promptoverrides`, extends `SmrtObject`)
- `PromptOverrideCollection` (collection `promptoverrides`, extends `SmrtCollection`)
