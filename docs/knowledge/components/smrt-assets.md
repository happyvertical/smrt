---
type: "Component"
title: "@happyvertical/smrt-assets"
description: "Asset management system with versioning, metadata, and AI-powered operations for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-06T01:23:41Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:73bdc0cbe39f1720505c0abd7438920e0e7d167f84e8ca629c3cb40127d8027c"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/assets/package.json"
    title: "@happyvertical/smrt-assets package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/assets/AGENTS.md"
    title: "@happyvertical/smrt-assets packages/assets/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/assets/README.md"
    title: "@happyvertical/smrt-assets packages/assets/README.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/assets/agents/private-assets.md"
    title: "@happyvertical/smrt-assets packages/assets/agents/private-assets.md"
---

# @happyvertical/smrt-assets

## Package

- Directory: `packages/assets`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/assets/AGENTS.md`
- `packages/assets/README.md`
- `packages/assets/agents/private-assets.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-playground](/components/smrt-playground.md)
- [smrt-tags](/components/smrt-tags.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./filesystem`
- `./locator`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./ui`
- `./workbench`

## Models

- `Asset` (collection `assets`, extends `SmrtObject`, STI table)
- `AssetAssociation` (collection `assetassociations`, extends `SmrtPolymorphicAssociation`)
- `AssetAssociationCollection` (collection `assetassociations`, extends `SmrtJunctionBase`)
- `AssetCollection` (collection `assets`, extends `SmrtCollection`)
- `AssetMetafield` (collection `assetmetafields`, extends `SmrtObject`, STI table)
- `AssetMetafieldCollection` (collection `assetmetafields`, extends `SmrtCollection`)
- `AssetStatus` (collection `assetstatuses`, extends `SmrtObject`, STI table)
- `AssetStatusCollection` (collection `assetstatuses`, extends `SmrtCollection`)
- `AssetTag` (collection `assettags`, extends `SmrtObject`)
- `AssetTagCollection` (collection `assettags`, extends `SmrtJunction`)
- `AssetType` (collection `assettypes`, extends `SmrtObject`, STI table)
- `AssetTypeCollection` (collection `assettypes`, extends `SmrtCollection`)
- `Folder` (collection `folders`, extends `SmrtHierarchical`)
- `FolderCollection` (collection `folders`, extends `SmrtCollection`)

## MCP tools

- `asset_create`: create on `@happyvertical/smrt-assets:Asset`
- `asset_get`: get on `@happyvertical/smrt-assets:Asset`
- `asset_list`: list on `@happyvertical/smrt-assets:Asset`
- `asset_update`: update on `@happyvertical/smrt-assets:Asset`
- `assetassociation_create`: create on `@happyvertical/smrt-assets:AssetAssociation`
- `assetassociation_get`: get on `@happyvertical/smrt-assets:AssetAssociation`
- `assetassociation_list`: list on `@happyvertical/smrt-assets:AssetAssociation`
- `assetmetafield_create`: create on `@happyvertical/smrt-assets:AssetMetafield`
- `assetmetafield_get`: get on `@happyvertical/smrt-assets:AssetMetafield`
- `assetmetafield_list`: list on `@happyvertical/smrt-assets:AssetMetafield`
- `assetstatus_create`: create on `@happyvertical/smrt-assets:AssetStatus`
- `assetstatus_get`: get on `@happyvertical/smrt-assets:AssetStatus`
- `assetstatus_list`: list on `@happyvertical/smrt-assets:AssetStatus`
- `assettype_create`: create on `@happyvertical/smrt-assets:AssetType`
- `assettype_get`: get on `@happyvertical/smrt-assets:AssetType`
- `assettype_list`: list on `@happyvertical/smrt-assets:AssetType`
- `folder_create`: create on `@happyvertical/smrt-assets:Folder`
- `folder_get`: get on `@happyvertical/smrt-assets:Folder`
- `folder_list`: list on `@happyvertical/smrt-assets:Folder`
- `folder_update`: update on `@happyvertical/smrt-assets:Folder`
