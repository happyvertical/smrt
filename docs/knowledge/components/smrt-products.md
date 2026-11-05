---
type: "Component"
title: "@happyvertical/smrt-products"
description: "SMRT products module: triple-purpose microservice template for standalone apps, federated modules, and NPM libraries"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:39:02Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:9bda36de8d0c6882e77b106a710aa82f3c87bea6243f032e01b80636e7c6917d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/products/package.json"
    title: "@happyvertical/smrt-products package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/products/AGENTS.md"
    title: "@happyvertical/smrt-products packages/products/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/products/agents/install-lifecycle.md"
    title: "@happyvertical/smrt-products packages/products/agents/install-lifecycle.md"
---

# @happyvertical/smrt-products

## Package

- Version: `0.60.8`
- Directory: `packages/products`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/products/AGENTS.md`
- `packages/products/agents/install-lifecycle.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)
- [smrt-web](/components/smrt-web.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./collections`
- `./components`
- `./generated`
- `./manifest`
- `./manifest.json`
- `./models`
- `./stores`
- `./stores/product-collection`
- `./utils`

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
- `BillingRelationship` (collection `billingrelationships`, extends `SmrtObject`)
- `BillingRelationshipCollection` (collection `billingrelationships`, extends `SmrtCollection`)
- `Category` (collection `categories`, extends `SmrtObject`, STI table)
- `CategoryCollection` (collection `categories`, extends `SmrtCollection`)
- `Folder` (collection `folders`, extends `SmrtHierarchical`)
- `FolderCollection` (collection `folders`, extends `SmrtCollection`)
- `Material` (collection `products`, extends `Product`, STI table)
- `MaterialCollection` (collection `products`, extends `ProductCollection`)
- `Product` (collection `products`, extends `SmrtObject`, STI table)
- `ProductAsset` (collection `productassets`, extends `SmrtObject`)
- `ProductAssetCollection` (collection `productassets`, extends `SmrtJunction`)
- `ProductCollection` (collection `products`, extends `SmrtCollection`)
- `ProductVariant` (collection `productvariants`, extends `SmrtObject`)
- `ProductVariantCollection` (collection `productvariants`, extends `SmrtCollection`)
- `Sku` (collection `skus`, extends `SmrtObject`)
- `SkuCollection` (collection `skus`, extends `SmrtCollection`)
- `SmrtClass` (collection `smrtclasses`)
- `SmrtCollection` (collection `smrtcollections`, extends `SmrtClass`)
- `SmrtHierarchical` (collection `smrthierarchicals`, extends `SmrtObject`)
- `SmrtJunction` (collection `smrtjunctions`, extends `SmrtJunctionBase`)
- `SmrtJunctionBase` (collection `smrtjunctionbases`, extends `SmrtCollection`)
- `SmrtObject` (collection `smrtobjects`, extends `SmrtClass`)
- `SmrtPolymorphicAssociation` (collection `smrtpolymorphicassociations`, extends `SmrtObject`)

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
- `category_get`: get on `@happyvertical/smrt-products:Category`
- `category_list`: list on `@happyvertical/smrt-products:Category`
- `folder_create`: create on `@happyvertical/smrt-assets:Folder`
- `folder_get`: get on `@happyvertical/smrt-assets:Folder`
- `folder_list`: list on `@happyvertical/smrt-assets:Folder`
- `folder_update`: update on `@happyvertical/smrt-assets:Folder`
- `material_get`: get on `@happyvertical/smrt-products:Material`
- `material_list`: list on `@happyvertical/smrt-products:Material`
- `product_get`: get on `@happyvertical/smrt-products:Product`
- `product_list`: list on `@happyvertical/smrt-products:Product`
- `productvariant_get`: get on `@happyvertical/smrt-products:ProductVariant`
- `productvariant_list`: list on `@happyvertical/smrt-products:ProductVariant`
- `sku_get`: get on `@happyvertical/smrt-products:Sku`
- `sku_list`: list on `@happyvertical/smrt-products:Sku`
