---
type: "Component"
title: "@happyvertical/smrt-products"
description: "SMRT products module: triple-purpose microservice template for standalone apps, federated modules, and NPM libraries"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:c278cfe9cbd484188adcf53f4742f80562054b518890593e76cfd2b54789b03c"
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

- `Category` (collection `categories`, extends `SmrtObject`, STI table)
- `CategoryCollection` (collection `categories`, extends `SmrtCollection`)
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

## MCP tools

- `category_get`: get on `@happyvertical/smrt-products:Category`
- `category_list`: list on `@happyvertical/smrt-products:Category`
- `material_get`: get on `@happyvertical/smrt-products:Material`
- `material_list`: list on `@happyvertical/smrt-products:Material`
- `product_get`: get on `@happyvertical/smrt-products:Product`
- `product_list`: list on `@happyvertical/smrt-products:Product`
- `productvariant_get`: get on `@happyvertical/smrt-products:ProductVariant`
- `productvariant_list`: list on `@happyvertical/smrt-products:ProductVariant`
- `sku_get`: get on `@happyvertical/smrt-products:Sku`
- `sku_list`: list on `@happyvertical/smrt-products:Sku`
