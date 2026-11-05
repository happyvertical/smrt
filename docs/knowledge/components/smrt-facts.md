---
type: "Component"
title: "@happyvertical/smrt-facts"
description: "Distributed memory and knowledge management with provenance tracking for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:2e1844ae3183cf150df8f81f85c6a6bb7863b67b34aa7ebdd1ab47b165a23d54"
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

- Version: `0.60.8`
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
