---
type: "Component"
title: "@happyvertical/smrt-images"
description: "Image asset management with AI-powered categorization, search, editing, and metadata extraction for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:2b18249094a1d6af10a0e49e0f8152b4e42b125f378e3542559f477328adc1cd"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/images/package.json"
    title: "@happyvertical/smrt-images package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/images/AGENTS.md"
    title: "@happyvertical/smrt-images packages/images/AGENTS.md"
---

# @happyvertical/smrt-images

## Package

- Directory: `packages/images`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/images/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-playground](/components/smrt-playground.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/images`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./ui`
- `./workbench`

## Models

- `Image` (collection `images`, extends `Asset`)

## MCP tools

- `create_images`: create on `@happyvertical/smrt-images:Image`
- `generateAltText_images`: generateAltText on `@happyvertical/smrt-images:Image`
- `get_images`: get on `@happyvertical/smrt-images:Image`
- `list_images`: list on `@happyvertical/smrt-images:Image`
- `update_images`: update on `@happyvertical/smrt-images:Image`
