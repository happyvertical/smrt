---
type: "Component"
title: "@happyvertical/smrt-tags"
description: "Reusable tagging system with hierarchies, contexts, and multi-language support for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:8aafbd784cd5ca464be069107247892c21241df81cdfb8c02441538f10ce403c"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/tags/package.json"
    title: "@happyvertical/smrt-tags package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/tags/AGENTS.md"
    title: "@happyvertical/smrt-tags packages/tags/AGENTS.md"
---

# @happyvertical/smrt-tags

## Package

- Directory: `packages/tags`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/tags/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./utils`

## Models

- `Tag` (collection `tags`, extends `SmrtHierarchical`, STI table)
- `TagAlias` (collection `tagaliases`, extends `SmrtObject`, STI table)
- `TagAliasCollection` (collection `tagaliases`, extends `SmrtCollection`)
- `TagCollection` (collection `tags`, extends `SmrtCollection`)

## MCP tools

- `tag_create`: create on `@happyvertical/smrt-tags:Tag`
- `tag_get`: get on `@happyvertical/smrt-tags:Tag`
- `tag_list`: list on `@happyvertical/smrt-tags:Tag`
- `tag_update`: update on `@happyvertical/smrt-tags:Tag`
- `tagalias_create`: create on `@happyvertical/smrt-tags:TagAlias`
- `tagalias_get`: get on `@happyvertical/smrt-tags:TagAlias`
- `tagalias_list`: list on `@happyvertical/smrt-tags:TagAlias`
