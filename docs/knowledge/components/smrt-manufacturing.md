---
type: "Component"
title: "@happyvertical/smrt-manufacturing"
description: "Bills of materials, cost rollup, and production-order operations for the SMRT framework — strictly industry-neutral"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:a91e8069fb20f9bcebfcb7a0a37109c369e6474322574ea2d46dc368d30efc03"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/manufacturing/package.json"
    title: "@happyvertical/smrt-manufacturing package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/manufacturing/AGENTS.md"
    title: "@happyvertical/smrt-manufacturing packages/manufacturing/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/manufacturing/agents/multilevel-and-runs.md"
    title: "@happyvertical/smrt-manufacturing packages/manufacturing/agents/multilevel-and-runs.md"
---

# @happyvertical/smrt-manufacturing

## Package

- Version: `0.60.8`
- Directory: `packages/manufacturing`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/manufacturing/AGENTS.md`
- `packages/manufacturing/agents/multilevel-and-runs.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-inventory](/components/smrt-inventory.md)
- [smrt-products](/components/smrt-products.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
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
- `./ui`
- `./views`

## Models

- `Assembly` (collection `products`, extends `Product`, STI table)
- `BillOfMaterials` (collection `billofmaterialses`, extends `SmrtObject`)
- `BillOfMaterialsCollection` (collection `billofmaterialses`, extends `SmrtCollection`)
- `BomLine` (collection `bomlines`, extends `SmrtObject`)
- `BomLineCollection` (collection `bomlines`, extends `SmrtCollection`)
- `Operation` (collection `operations`, extends `SmrtObject`)
- `OperationCollection` (collection `operations`, extends `SmrtCollection`)
- `ProductionRun` (collection `productionruns`, extends `SmrtObject`)
- `ProductionRunCollection` (collection `productionruns`, extends `SmrtCollection`)
- `ProductionRunCompletion` (collection `productionruncompletions`, extends `SmrtObject`)
- `ProductionRunCompletionCollection` (collection `productionruncompletions`, extends `SmrtCollection`)
- `RoutingStep` (collection `routingsteps`, extends `SmrtObject`)
- `RoutingStepCollection` (collection `routingsteps`, extends `SmrtCollection`)

## MCP tools

- `assembly_get`: get on `@happyvertical/smrt-manufacturing:Assembly`
- `assembly_list`: list on `@happyvertical/smrt-manufacturing:Assembly`
- `billofmaterials_get`: get on `@happyvertical/smrt-manufacturing:BillOfMaterials`
- `billofmaterials_list`: list on `@happyvertical/smrt-manufacturing:BillOfMaterials`
- `bomline_get`: get on `@happyvertical/smrt-manufacturing:BomLine`
- `bomline_list`: list on `@happyvertical/smrt-manufacturing:BomLine`
- `operation_get`: get on `@happyvertical/smrt-manufacturing:Operation`
- `operation_list`: list on `@happyvertical/smrt-manufacturing:Operation`
- `productionrun_get`: get on `@happyvertical/smrt-manufacturing:ProductionRun`
- `productionrun_list`: list on `@happyvertical/smrt-manufacturing:ProductionRun`
- `productionruncompletion_get`: get on `@happyvertical/smrt-manufacturing:ProductionRunCompletion`
- `productionruncompletion_list`: list on `@happyvertical/smrt-manufacturing:ProductionRunCompletion`
- `routingstep_get`: get on `@happyvertical/smrt-manufacturing:RoutingStep`
- `routingstep_list`: list on `@happyvertical/smrt-manufacturing:RoutingStep`
