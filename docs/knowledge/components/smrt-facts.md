---
type: "Component"
title: "@happyvertical/smrt-facts"
description: "Distributed memory and knowledge management with provenance tracking for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:763ac0c60c494cda65b1f4383d0e2c5e43e1fc747cb997df3e39d3951ca88f3f"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/facts/package.json"
    title: "@happyvertical/smrt-facts package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/facts/AGENTS.md"
    title: "@happyvertical/smrt-facts packages/facts/AGENTS.md"
---

# @happyvertical/smrt-facts

## Package

- Directory: `packages/facts`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/facts/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

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

## Models

- `Fact` (collection `facts`, extends `SmrtObject`, STI table)
- `FactContent` (collection `factcontents`, extends `SmrtObject`)
- `FactContentCollection` (collection `factcontentcollections`, extends `SmrtJunction`)
- `FactEvidence` (collection `factevidences`, extends `SmrtObject`)
- `FactSource` (collection `factsources`, extends `SmrtObject`, STI table)
- `FactSubject` (collection `factsubjects`, extends `SmrtObject`)
- `FactTag` (collection `facttags`, extends `SmrtObject`)

## MCP tools

- `create_factcontentcollections`: create on `@happyvertical/smrt-facts:FactContentCollection`
- `create_factcontents`: create on `@happyvertical/smrt-facts:FactContent`
- `create_factevidences`: create on `@happyvertical/smrt-facts:FactEvidence`
- `create_facts`: create on `@happyvertical/smrt-facts:Fact`
- `create_factsources`: create on `@happyvertical/smrt-facts:FactSource`
- `create_factsubjects`: create on `@happyvertical/smrt-facts:FactSubject`
- `create_facttags`: create on `@happyvertical/smrt-facts:FactTag`
- `delete_factcontentcollections`: delete on `@happyvertical/smrt-facts:FactContentCollection`
- `get_factcontentcollections`: get on `@happyvertical/smrt-facts:FactContentCollection`
- `get_factcontents`: get on `@happyvertical/smrt-facts:FactContent`
- `get_factevidences`: get on `@happyvertical/smrt-facts:FactEvidence`
- `get_facts`: get on `@happyvertical/smrt-facts:Fact`
- `get_factsources`: get on `@happyvertical/smrt-facts:FactSource`
- `get_factsubjects`: get on `@happyvertical/smrt-facts:FactSubject`
- `get_facttags`: get on `@happyvertical/smrt-facts:FactTag`
- `list_factcontentcollections`: list on `@happyvertical/smrt-facts:FactContentCollection`
- `list_factcontents`: list on `@happyvertical/smrt-facts:FactContent`
- `list_factevidences`: list on `@happyvertical/smrt-facts:FactEvidence`
- `list_facts`: list on `@happyvertical/smrt-facts:Fact`
- `list_factsources`: list on `@happyvertical/smrt-facts:FactSource`
- `list_factsubjects`: list on `@happyvertical/smrt-facts:FactSubject`
- `list_facttags`: list on `@happyvertical/smrt-facts:FactTag`
- `update_factcontentcollections`: update on `@happyvertical/smrt-facts:FactContentCollection`
- `update_facts`: update on `@happyvertical/smrt-facts:Fact`
