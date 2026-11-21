---
type: "Component"
title: "@happyvertical/smrt-assets"
description: "Asset management system with versioning, metadata, and AI-powered operations for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T10:47:34Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:cc75810206b77ef1559b6b3275de2470d68e1715510be2820611e29112d56c91"
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
- Object source: `manifest`
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
- `AssetAssociationCollection` (collection `assetassociations`, extends `SmrtJunction`)
- `AssetCollection` (collection `assets`, extends `SmrtCollection`)
- `AssetMetafield` (collection `assetmetafields`, extends `SmrtObject`, STI table)
- `AssetMetafieldCollection` (collection `assetmetafields`, extends `SmrtCollection`)
- `AssetStatus` (collection `assetstatuses`, extends `SmrtObject`, STI table)
- `AssetStatusCollection` (collection `assetstatuses`, extends `SmrtCollection`)
- `AssetType` (collection `assettypes`, extends `SmrtObject`, STI table)
- `AssetTypeCollection` (collection `assettypes`, extends `SmrtCollection`)
- `Folder` (collection `folders`, extends `SmrtHierarchical`)
- `FolderCollection` (collection `folders`, extends `SmrtCollection`)

## MCP tools

- `create_assetassociations`: create on `@happyvertical/smrt-assets:AssetAssociation`
- `create_assetassociations`: create on `@happyvertical/smrt-assets:AssetAssociationCollection`
- `create_assetmetafields`: create on `@happyvertical/smrt-assets:AssetMetafield`
- `create_assetmetafields`: create on `@happyvertical/smrt-assets:AssetMetafieldCollection`
- `create_assets`: create on `@happyvertical/smrt-assets:Asset`
- `create_assets`: create on `@happyvertical/smrt-assets:AssetCollection`
- `create_assetstatuses`: create on `@happyvertical/smrt-assets:AssetStatus`
- `create_assetstatuses`: create on `@happyvertical/smrt-assets:AssetStatusCollection`
- `create_assettypes`: create on `@happyvertical/smrt-assets:AssetType`
- `create_assettypes`: create on `@happyvertical/smrt-assets:AssetTypeCollection`
- `create_folders`: create on `@happyvertical/smrt-assets:Folder`
- `create_folders`: create on `@happyvertical/smrt-assets:FolderCollection`
- `delete_assetassociations`: delete on `@happyvertical/smrt-assets:AssetAssociationCollection`
- `delete_assetmetafields`: delete on `@happyvertical/smrt-assets:AssetMetafieldCollection`
- `delete_assets`: delete on `@happyvertical/smrt-assets:AssetCollection`
- `delete_assetstatuses`: delete on `@happyvertical/smrt-assets:AssetStatusCollection`
- `delete_assettypes`: delete on `@happyvertical/smrt-assets:AssetTypeCollection`
- `delete_folders`: delete on `@happyvertical/smrt-assets:FolderCollection`
- `get_assetassociations`: get on `@happyvertical/smrt-assets:AssetAssociation`
- `get_assetassociations`: get on `@happyvertical/smrt-assets:AssetAssociationCollection`
- `get_assetmetafields`: get on `@happyvertical/smrt-assets:AssetMetafield`
- `get_assetmetafields`: get on `@happyvertical/smrt-assets:AssetMetafieldCollection`
- `get_assets`: get on `@happyvertical/smrt-assets:Asset`
- `get_assets`: get on `@happyvertical/smrt-assets:AssetCollection`
- `get_assetstatuses`: get on `@happyvertical/smrt-assets:AssetStatus`
- `get_assetstatuses`: get on `@happyvertical/smrt-assets:AssetStatusCollection`
- `get_assettypes`: get on `@happyvertical/smrt-assets:AssetType`
- `get_assettypes`: get on `@happyvertical/smrt-assets:AssetTypeCollection`
- `get_folders`: get on `@happyvertical/smrt-assets:Folder`
- `get_folders`: get on `@happyvertical/smrt-assets:FolderCollection`
- `list_assetassociations`: list on `@happyvertical/smrt-assets:AssetAssociation`
- `list_assetassociations`: list on `@happyvertical/smrt-assets:AssetAssociationCollection`
- `list_assetmetafields`: list on `@happyvertical/smrt-assets:AssetMetafield`
- `list_assetmetafields`: list on `@happyvertical/smrt-assets:AssetMetafieldCollection`
- `list_assets`: list on `@happyvertical/smrt-assets:Asset`
- `list_assets`: list on `@happyvertical/smrt-assets:AssetCollection`
- `list_assetstatuses`: list on `@happyvertical/smrt-assets:AssetStatus`
- `list_assetstatuses`: list on `@happyvertical/smrt-assets:AssetStatusCollection`
- `list_assettypes`: list on `@happyvertical/smrt-assets:AssetType`
- `list_assettypes`: list on `@happyvertical/smrt-assets:AssetTypeCollection`
- `list_folders`: list on `@happyvertical/smrt-assets:Folder`
- `list_folders`: list on `@happyvertical/smrt-assets:FolderCollection`
- `update_assetassociations`: update on `@happyvertical/smrt-assets:AssetAssociationCollection`
- `update_assetmetafields`: update on `@happyvertical/smrt-assets:AssetMetafieldCollection`
- `update_assets`: update on `@happyvertical/smrt-assets:Asset`
- `update_assets`: update on `@happyvertical/smrt-assets:AssetCollection`
- `update_assetstatuses`: update on `@happyvertical/smrt-assets:AssetStatusCollection`
- `update_assettypes`: update on `@happyvertical/smrt-assets:AssetTypeCollection`
- `update_folders`: update on `@happyvertical/smrt-assets:Folder`
- `update_folders`: update on `@happyvertical/smrt-assets:FolderCollection`
