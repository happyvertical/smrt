---
type: "Component"
title: "@happyvertical/smrt-products"
description: "SMRT products module: triple-purpose microservice template for standalone apps, federated modules, and NPM libraries"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T17:49:43Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:afb10309ba6a400ea1c391c68402ecacfaba28c0444dfd38b20447dc7e9853a2"
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

- Directory: `packages/products`
- Private: no
- Object source: `scanner`
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
- `Material` (collection `materials`, extends `Product`)
- `Product` (collection `products`, extends `SmrtObject`, STI table)
- `ProductAsset` (collection `productassets`, extends `SmrtObject`)
- `ProductAssetCollection` (collection `productassetcollections`, extends `SmrtJunction`)
- `ProductVariant` (collection `productvariants`, extends `SmrtObject`)
- `Sku` (collection `skus`, extends `SmrtObject`)

## MCP tools

- `get_categories`: get on `@happyvertical/smrt-products:Category`
- `get_materials`: get on `@happyvertical/smrt-products:Material`
- `get_products`: get on `@happyvertical/smrt-products:Product`
- `get_productvariants`: get on `@happyvertical/smrt-products:ProductVariant`
- `get_skus`: get on `@happyvertical/smrt-products:Sku`
- `list_categories`: list on `@happyvertical/smrt-products:Category`
- `list_materials`: list on `@happyvertical/smrt-products:Material`
- `list_products`: list on `@happyvertical/smrt-products:Product`
- `list_productvariants`: list on `@happyvertical/smrt-products:ProductVariant`
- `list_skus`: list on `@happyvertical/smrt-products:Sku`
