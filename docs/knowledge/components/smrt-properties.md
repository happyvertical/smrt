---
type: "Component"
title: "@happyvertical/smrt-properties"
description: "Digital property and zone management models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T22:32:35Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:94a16946748aba9c645a34208782cfa21d7912e655df9574806a21b5f546626b"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/properties/package.json"
    title: "@happyvertical/smrt-properties package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/properties/AGENTS.md"
    title: "@happyvertical/smrt-properties packages/properties/AGENTS.md"
---

# @happyvertical/smrt-properties

## Package

- Directory: `packages/properties`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/properties/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `Property` (collection `properties`, extends `SmrtObject`, STI table)
- `PropertyCollection` (collection `properties`, extends `SmrtCollection`)
- `Zone` (collection `zones`, extends `SmrtHierarchical`)
- `ZoneCollection` (collection `zones`, extends `SmrtCollection`)

## MCP tools

- `property_create`: create on `@happyvertical/smrt-properties:Property`
- `property_get`: get on `@happyvertical/smrt-properties:Property`
- `property_list`: list on `@happyvertical/smrt-properties:Property`
- `zone_create`: create on `@happyvertical/smrt-properties:Zone`
- `zone_get`: get on `@happyvertical/smrt-properties:Zone`
- `zone_list`: list on `@happyvertical/smrt-properties:Zone`
