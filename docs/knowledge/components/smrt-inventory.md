---
type: "Component"
title: "@happyvertical/smrt-inventory"
description: "Multi-location stock tracking for the SMRT framework — Sku, InventoryLocation, StockLevel, StockMovement, lot and serial tracking, and stock-mutation and lot services"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:f9eebca328566928365174d6e0fc36c0d21d4d23970b63f4768b77f4ae3ad63f"
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
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/inventory/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
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
- `Lot` (collection `lots`, extends `SmrtObject`)
- `LotCorrection` (collection `lotcorrections`, extends `SmrtObject`)
- `LotDocument` (collection `lotdocuments`, extends `SmrtObject`)
- `LotStockLevel` (collection `lotstocklevels`, extends `SmrtObject`)
- `LotUsage` (collection `lotusages`, extends `SmrtObject`)
- `StockLevel` (collection `stocklevels`, extends `SmrtObject`)
- `StockMovement` (collection `stockmovements`, extends `SmrtObject`)

## MCP tools

- `get_inventorylocations`: get on `@happyvertical/smrt-inventory:InventoryLocation`
- `get_lotcorrections`: get on `@happyvertical/smrt-inventory:LotCorrection`
- `get_lotdocuments`: get on `@happyvertical/smrt-inventory:LotDocument`
- `get_lots`: get on `@happyvertical/smrt-inventory:Lot`
- `get_lotstocklevels`: get on `@happyvertical/smrt-inventory:LotStockLevel`
- `get_lotusages`: get on `@happyvertical/smrt-inventory:LotUsage`
- `get_stocklevels`: get on `@happyvertical/smrt-inventory:StockLevel`
- `get_stockmovements`: get on `@happyvertical/smrt-inventory:StockMovement`
- `list_inventorylocations`: list on `@happyvertical/smrt-inventory:InventoryLocation`
- `list_lotcorrections`: list on `@happyvertical/smrt-inventory:LotCorrection`
- `list_lotdocuments`: list on `@happyvertical/smrt-inventory:LotDocument`
- `list_lots`: list on `@happyvertical/smrt-inventory:Lot`
- `list_lotstocklevels`: list on `@happyvertical/smrt-inventory:LotStockLevel`
- `list_lotusages`: list on `@happyvertical/smrt-inventory:LotUsage`
- `list_stocklevels`: list on `@happyvertical/smrt-inventory:StockLevel`
- `list_stockmovements`: list on `@happyvertical/smrt-inventory:StockMovement`
