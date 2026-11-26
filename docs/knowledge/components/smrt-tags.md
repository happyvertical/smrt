---
type: "Component"
title: "@happyvertical/smrt-tags"
description: "Reusable tagging system with hierarchies, contexts, and multi-language support for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-26T18:24:00Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:dd184572bebb97c5d0c14ffb20b50093898a4f8446676eaf549043dc7837a1a5"
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
- Object source: `manifest`
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

- `create_tagaliases`: create on `@happyvertical/smrt-tags:TagAlias`
- `create_tagaliases`: create on `@happyvertical/smrt-tags:TagAliasCollection`
- `create_tags`: create on `@happyvertical/smrt-tags:Tag`
- `create_tags`: create on `@happyvertical/smrt-tags:TagCollection`
- `delete_tagaliases`: delete on `@happyvertical/smrt-tags:TagAliasCollection`
- `delete_tags`: delete on `@happyvertical/smrt-tags:TagCollection`
- `get_tagaliases`: get on `@happyvertical/smrt-tags:TagAlias`
- `get_tagaliases`: get on `@happyvertical/smrt-tags:TagAliasCollection`
- `get_tags`: get on `@happyvertical/smrt-tags:Tag`
- `get_tags`: get on `@happyvertical/smrt-tags:TagCollection`
- `list_tagaliases`: list on `@happyvertical/smrt-tags:TagAlias`
- `list_tagaliases`: list on `@happyvertical/smrt-tags:TagAliasCollection`
- `list_tags`: list on `@happyvertical/smrt-tags:Tag`
- `list_tags`: list on `@happyvertical/smrt-tags:TagCollection`
- `update_tagaliases`: update on `@happyvertical/smrt-tags:TagAliasCollection`
- `update_tags`: update on `@happyvertical/smrt-tags:Tag`
- `update_tags`: update on `@happyvertical/smrt-tags:TagCollection`
