---
type: "Component"
title: "@happyvertical/smrt-inventory"
description: "Multi-location stock tracking for the SMRT framework — Sku, InventoryLocation, StockLevel, StockMovement, lot and serial tracking, and stock-mutation and lot services"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-11T16:32:59Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:28c18302458e79d5835af4573950dadb509a86c3b1b05da29a7b4676a03913b3"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inventory/package.json"
    title: "@happyvertical/smrt-inventory package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inventory/AGENTS.md"
    title: "@happyvertical/smrt-inventory packages/inventory/AGENTS.md"
---

# @happyvertical/smrt-inventory

## Package

- Directory: `packages/inventory`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/inventory/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-products](/components/smrt-products.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `InventoryLocation` (collection `inventorylocations`, extends `SmrtObject`)
- `InventoryLocationCollection` (collection `inventorylocations`, extends `SmrtCollection`)
- `Lot` (collection `lots`, extends `SmrtObject`)
- `LotCollection` (collection `lots`, extends `SmrtCollection`)
- `LotCorrection` (collection `lotcorrections`, extends `SmrtObject`)
- `LotCorrectionCollection` (collection `lotcorrections`, extends `SmrtCollection`)
- `LotDocument` (collection `lotdocuments`, extends `SmrtObject`)
- `LotDocumentCollection` (collection `lotdocuments`, extends `SmrtCollection`)
- `LotStockLevel` (collection `lotstocklevels`, extends `SmrtObject`)
- `LotStockLevelCollection` (collection `lotstocklevels`, extends `SmrtCollection`)
- `LotUsage` (collection `lotusages`, extends `SmrtObject`)
- `LotUsageCollection` (collection `lotusages`, extends `SmrtCollection`)
- `StockLevel` (collection `stocklevels`, extends `SmrtObject`)
- `StockLevelCollection` (collection `stocklevels`, extends `SmrtCollection`)
- `StockMovement` (collection `stockmovements`, extends `SmrtObject`)
- `StockMovementCollection` (collection `stockmovements`, extends `SmrtCollection`)

## MCP tools

- `inventorylocation_get`: get on `@happyvertical/smrt-inventory:InventoryLocation`
- `inventorylocation_list`: list on `@happyvertical/smrt-inventory:InventoryLocation`
- `lot_get`: get on `@happyvertical/smrt-inventory:Lot`
- `lot_list`: list on `@happyvertical/smrt-inventory:Lot`
- `lotcorrection_get`: get on `@happyvertical/smrt-inventory:LotCorrection`
- `lotcorrection_list`: list on `@happyvertical/smrt-inventory:LotCorrection`
- `lotdocument_get`: get on `@happyvertical/smrt-inventory:LotDocument`
- `lotdocument_list`: list on `@happyvertical/smrt-inventory:LotDocument`
- `lotstocklevel_get`: get on `@happyvertical/smrt-inventory:LotStockLevel`
- `lotstocklevel_list`: list on `@happyvertical/smrt-inventory:LotStockLevel`
- `lotusage_get`: get on `@happyvertical/smrt-inventory:LotUsage`
- `lotusage_list`: list on `@happyvertical/smrt-inventory:LotUsage`
- `stocklevel_get`: get on `@happyvertical/smrt-inventory:StockLevel`
- `stocklevel_list`: list on `@happyvertical/smrt-inventory:StockLevel`
- `stockmovement_get`: get on `@happyvertical/smrt-inventory:StockMovement`
- `stockmovement_list`: list on `@happyvertical/smrt-inventory:StockMovement`
