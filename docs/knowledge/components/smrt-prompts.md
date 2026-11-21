---
type: "Component"
title: "@happyvertical/smrt-prompts"
description: "Typed prompt registry, override resolution, and tenant-aware prompt settings for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T10:47:34Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:e4b759233f0c1058cbdb6c167fa2e4dc56817688a8a46d68161e890b5f319695"
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
- Object source: `scanner`
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
