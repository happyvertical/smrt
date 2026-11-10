---
type: "Component"
title: "@happyvertical/smrt-manufacturing"
description: "Bills of materials, cost rollup, and production-order operations for the SMRT framework — strictly industry-neutral"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:c456acefa7fc212b1ca0a42e128599ce6ae45081e15d868ad368447f7c2536e0"
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

- Directory: `packages/manufacturing`
- Private: no
- Object source: `scanner`
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

- `Assembly` (collection `assemblies`, extends `Product`)
- `BillOfMaterials` (collection `billofmaterialses`, extends `SmrtObject`)
- `BomLine` (collection `bomlines`, extends `SmrtObject`)
- `Operation` (collection `operations`, extends `SmrtObject`)
- `ProductionRun` (collection `productionruns`, extends `SmrtObject`)
- `ProductionRunCompletion` (collection `productionruncompletions`, extends `SmrtObject`)
- `RoutingStep` (collection `routingsteps`, extends `SmrtObject`)

## MCP tools

- `get_assemblies`: get on `@happyvertical/smrt-manufacturing:Assembly`
- `get_billofmaterialses`: get on `@happyvertical/smrt-manufacturing:BillOfMaterials`
- `get_bomlines`: get on `@happyvertical/smrt-manufacturing:BomLine`
- `get_operations`: get on `@happyvertical/smrt-manufacturing:Operation`
- `get_productionruncompletions`: get on `@happyvertical/smrt-manufacturing:ProductionRunCompletion`
- `get_productionruns`: get on `@happyvertical/smrt-manufacturing:ProductionRun`
- `get_routingsteps`: get on `@happyvertical/smrt-manufacturing:RoutingStep`
- `list_assemblies`: list on `@happyvertical/smrt-manufacturing:Assembly`
- `list_billofmaterialses`: list on `@happyvertical/smrt-manufacturing:BillOfMaterials`
- `list_bomlines`: list on `@happyvertical/smrt-manufacturing:BomLine`
- `list_operations`: list on `@happyvertical/smrt-manufacturing:Operation`
- `list_productionruncompletions`: list on `@happyvertical/smrt-manufacturing:ProductionRunCompletion`
- `list_productionruns`: list on `@happyvertical/smrt-manufacturing:ProductionRun`
- `list_routingsteps`: list on `@happyvertical/smrt-manufacturing:RoutingStep`
