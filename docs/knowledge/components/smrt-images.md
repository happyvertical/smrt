---
type: "Component"
title: "@happyvertical/smrt-images"
description: "Image asset management with AI-powered categorization, search, editing, and metadata extraction for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T17:58:04Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d1c52a86c79f7779a4d7485ed81e9e0ea3243227870394fb3733bd8968fac23f"
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
- Object source: `domain-artifact`
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

- `Image` (collection `assets`, extends `Asset`, STI table)
- `ImageCollection` (collection `assets`, extends `SmrtCollection`)

## MCP tools

- `image_create`: create on `@happyvertical/smrt-images:Image`
- `image_generatealttext`: generateAltText on `@happyvertical/smrt-images:Image`
- `image_get`: get on `@happyvertical/smrt-images:Image`
- `image_list`: list on `@happyvertical/smrt-images:Image`
- `image_update`: update on `@happyvertical/smrt-images:Image`
