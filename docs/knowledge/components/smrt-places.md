---
type: "Component"
title: "@happyvertical/smrt-places"
description: "Hierarchical place management with geo integration and SMRT framework support"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:9cc7840fa53f0ce4b3b0f729dc20865e02daa7f896a3625f12ba0292216bdbf4"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/places/package.json"
    title: "@happyvertical/smrt-places package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/places/AGENTS.md"
    title: "@happyvertical/smrt-places packages/places/AGENTS.md"
---

# @happyvertical/smrt-places

## Package

- Directory: `packages/places`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/places/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/cache`
- `@happyvertical/files`
- `@happyvertical/geo`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./utils`

## Models

- `Place` (collection `places`, extends `SmrtHierarchical`, STI table)
- `PlaceAsset` (collection `placeassets`, extends `SmrtObject`)
- `PlaceAssetCollection` (collection `placeassets`, extends `SmrtJunction`)
- `PlaceCollection` (collection `places`, extends `SmrtCollection`)
- `PlaceType` (collection `placetypes`, extends `SmrtObject`, STI table)
- `PlaceTypeCollection` (collection `placetypes`, extends `SmrtCollection`)

## MCP tools

- `place_create`: create on `@happyvertical/smrt-places:Place`
- `place_get`: get on `@happyvertical/smrt-places:Place`
- `place_list`: list on `@happyvertical/smrt-places:Place`
- `place_update`: update on `@happyvertical/smrt-places:Place`
- `placetype_create`: create on `@happyvertical/smrt-places:PlaceType`
- `placetype_get`: get on `@happyvertical/smrt-places:PlaceType`
- `placetype_list`: list on `@happyvertical/smrt-places:PlaceType`
