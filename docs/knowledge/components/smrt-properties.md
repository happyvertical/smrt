---
type: "Component"
title: "@happyvertical/smrt-properties"
description: "Digital property and zone management models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:da1eb8b1d187f0af04481f796831ba7326f9a087ee911a13739ef16c48b36108"
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
- Object source: `manifest`
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

- `create_properties`: create on `@happyvertical/smrt-properties:Property`
- `create_properties`: create on `@happyvertical/smrt-properties:PropertyCollection`
- `create_zones`: create on `@happyvertical/smrt-properties:Zone`
- `create_zones`: create on `@happyvertical/smrt-properties:ZoneCollection`
- `delete_properties`: delete on `@happyvertical/smrt-properties:PropertyCollection`
- `delete_zones`: delete on `@happyvertical/smrt-properties:ZoneCollection`
- `get_properties`: get on `@happyvertical/smrt-properties:Property`
- `get_properties`: get on `@happyvertical/smrt-properties:PropertyCollection`
- `get_zones`: get on `@happyvertical/smrt-properties:Zone`
- `get_zones`: get on `@happyvertical/smrt-properties:ZoneCollection`
- `list_properties`: list on `@happyvertical/smrt-properties:Property`
- `list_properties`: list on `@happyvertical/smrt-properties:PropertyCollection`
- `list_zones`: list on `@happyvertical/smrt-properties:Zone`
- `list_zones`: list on `@happyvertical/smrt-properties:ZoneCollection`
- `update_properties`: update on `@happyvertical/smrt-properties:PropertyCollection`
- `update_zones`: update on `@happyvertical/smrt-properties:ZoneCollection`
