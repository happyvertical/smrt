---
type: "Component"
title: "@happyvertical/smrt-facts"
description: "Distributed memory and knowledge management with provenance tracking for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T18:33:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:460a057b5429a63c6d56979a7d593fbf84ee5130e1db5f727d52cfa02ed30674"
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
- Object source: `domain-artifact`
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
- `FactCollection` (collection `facts`, extends `SmrtCollection`)
- `FactContent` (collection `factcontents`, extends `SmrtObject`)
- `FactContentCollection` (collection `factcontents`, extends `SmrtJunction`)
- `FactEvidence` (collection `factevidences`, extends `SmrtObject`)
- `FactEvidenceCollection` (collection `factevidences`, extends `SmrtCollection`)
- `FactSource` (collection `factsources`, extends `SmrtObject`, STI table)
- `FactSourceCollection` (collection `factsources`, extends `SmrtCollection`)
- `FactSubject` (collection `factsubjects`, extends `SmrtObject`)
- `FactSubjectCollection` (collection `factsubjects`, extends `SmrtCollection`)
- `FactTag` (collection `facttags`, extends `SmrtObject`)
- `FactTagCollection` (collection `facttags`, extends `SmrtCollection`)

## MCP tools

- `fact_create`: create on `@happyvertical/smrt-facts:Fact`
- `fact_get`: get on `@happyvertical/smrt-facts:Fact`
- `fact_list`: list on `@happyvertical/smrt-facts:Fact`
- `fact_update`: update on `@happyvertical/smrt-facts:Fact`
- `factcontent_create`: create on `@happyvertical/smrt-facts:FactContent`
- `factcontent_get`: get on `@happyvertical/smrt-facts:FactContent`
- `factcontent_list`: list on `@happyvertical/smrt-facts:FactContent`
- `factevidence_create`: create on `@happyvertical/smrt-facts:FactEvidence`
- `factevidence_get`: get on `@happyvertical/smrt-facts:FactEvidence`
- `factevidence_list`: list on `@happyvertical/smrt-facts:FactEvidence`
- `factsource_create`: create on `@happyvertical/smrt-facts:FactSource`
- `factsource_get`: get on `@happyvertical/smrt-facts:FactSource`
- `factsource_list`: list on `@happyvertical/smrt-facts:FactSource`
- `factsubject_create`: create on `@happyvertical/smrt-facts:FactSubject`
- `factsubject_get`: get on `@happyvertical/smrt-facts:FactSubject`
- `factsubject_list`: list on `@happyvertical/smrt-facts:FactSubject`
- `facttag_create`: create on `@happyvertical/smrt-facts:FactTag`
- `facttag_get`: get on `@happyvertical/smrt-facts:FactTag`
- `facttag_list`: list on `@happyvertical/smrt-facts:FactTag`
