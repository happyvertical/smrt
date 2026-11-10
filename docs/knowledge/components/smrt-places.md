---
type: "Component"
title: "@happyvertical/smrt-places"
description: "Hierarchical place management with geo integration and SMRT framework support"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:dacaf7c449000bd878e9f66e333e1663f37ebe78d26237f0c40a1cb1279f10e4"
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
- Object source: `manifest`
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

- `create_places`: create on `@happyvertical/smrt-places:Place`
- `create_places`: create on `@happyvertical/smrt-places:PlaceCollection`
- `create_placetypes`: create on `@happyvertical/smrt-places:PlaceType`
- `create_placetypes`: create on `@happyvertical/smrt-places:PlaceTypeCollection`
- `delete_places`: delete on `@happyvertical/smrt-places:PlaceCollection`
- `delete_placetypes`: delete on `@happyvertical/smrt-places:PlaceTypeCollection`
- `get_places`: get on `@happyvertical/smrt-places:Place`
- `get_places`: get on `@happyvertical/smrt-places:PlaceCollection`
- `get_placetypes`: get on `@happyvertical/smrt-places:PlaceType`
- `get_placetypes`: get on `@happyvertical/smrt-places:PlaceTypeCollection`
- `list_places`: list on `@happyvertical/smrt-places:Place`
- `list_places`: list on `@happyvertical/smrt-places:PlaceCollection`
- `list_placetypes`: list on `@happyvertical/smrt-places:PlaceType`
- `list_placetypes`: list on `@happyvertical/smrt-places:PlaceTypeCollection`
- `update_places`: update on `@happyvertical/smrt-places:Place`
- `update_places`: update on `@happyvertical/smrt-places:PlaceCollection`
- `update_placetypes`: update on `@happyvertical/smrt-places:PlaceTypeCollection`
