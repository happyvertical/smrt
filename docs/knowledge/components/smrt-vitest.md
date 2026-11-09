---
type: "Component"
title: "@happyvertical/smrt-vitest"
description: "Vitest plugin for automatic cross-package manifest loading in SMRT tests"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T05:48:04Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:bf6bbb0917af25f31ab26331ecd344a3d366b94e2ba49d55318f1105838bf08d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/vitest/package.json"
    title: "@happyvertical/smrt-vitest package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/vitest/AGENTS.md"
    title: "@happyvertical/smrt-vitest packages/vitest/AGENTS.md"
---

# @happyvertical/smrt-vitest

## Package

- Directory: `packages/vitest`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/vitest/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./a11y`
- `./setup`
- `./svelte`
- `./svelte-setup`

## Models

- `ConvNote` (collection `convnotes`, extends `SmrtObject`)
- `Gadget` (collection `gadgets`, extends `SmrtObject`)
- `InlineProbeGadget` (collection `inlineprobegadgets`, extends `SmrtObject`)
- `Issue2427Widget` (collection `issue2427widgets`, extends `SmrtObject`)
- `Issue2429Widget` (collection `issue2429widgets`, extends `SmrtObject`)
- `Issue2890Alpha` (collection `issue2890alphas`, extends `SmrtObject`)
- `Issue2890Beta` (collection `issue2890betas`, extends `SmrtObject`)
- `Issue2890Gamma` (collection `issue2890gammas`, extends `SmrtObject`)
- `Issue2890WideWidget` (collection `issue2890widewidgets`, extends `SmrtObject`)
- `Note` (collection `notes`, extends `SmrtObject`)
- `TreeNode` (collection `treenodes`, extends `SmrtHierarchical`)
- `Widget` (collection `widgets`, extends `SmrtObject`)

## MCP tools

- `create_convnotes`: create on `@happyvertical/smrt-vitest:ConvNote`
- `create_inlineprobegadgets`: create on `@happyvertical/smrt-vitest:InlineProbeGadget`
- `create_issue2427widgets`: create on `@happyvertical/smrt-vitest:Issue2427Widget`
- `create_issue2429widgets`: create on `@happyvertical/smrt-vitest:Issue2429Widget`
- `create_issue2890alphas`: create on `@happyvertical/smrt-vitest:Issue2890Alpha`
- `create_issue2890betas`: create on `@happyvertical/smrt-vitest:Issue2890Beta`
- `create_issue2890gammas`: create on `@happyvertical/smrt-vitest:Issue2890Gamma`
- `create_issue2890widewidgets`: create on `@happyvertical/smrt-vitest:Issue2890WideWidget`
- `create_notes`: create on `@happyvertical/smrt-vitest:Note`
- `create_treenodes`: create on `@happyvertical/smrt-vitest:TreeNode`
- `delete_convnotes`: delete on `@happyvertical/smrt-vitest:ConvNote`
- `delete_inlineprobegadgets`: delete on `@happyvertical/smrt-vitest:InlineProbeGadget`
- `delete_issue2427widgets`: delete on `@happyvertical/smrt-vitest:Issue2427Widget`
- `delete_issue2429widgets`: delete on `@happyvertical/smrt-vitest:Issue2429Widget`
- `delete_issue2890alphas`: delete on `@happyvertical/smrt-vitest:Issue2890Alpha`
- `delete_issue2890betas`: delete on `@happyvertical/smrt-vitest:Issue2890Beta`
- `delete_issue2890gammas`: delete on `@happyvertical/smrt-vitest:Issue2890Gamma`
- `delete_issue2890widewidgets`: delete on `@happyvertical/smrt-vitest:Issue2890WideWidget`
- `delete_notes`: delete on `@happyvertical/smrt-vitest:Note`
- `delete_treenodes`: delete on `@happyvertical/smrt-vitest:TreeNode`
- `get_convnotes`: get on `@happyvertical/smrt-vitest:ConvNote`
- `get_inlineprobegadgets`: get on `@happyvertical/smrt-vitest:InlineProbeGadget`
- `get_issue2427widgets`: get on `@happyvertical/smrt-vitest:Issue2427Widget`
- `get_issue2429widgets`: get on `@happyvertical/smrt-vitest:Issue2429Widget`
- `get_issue2890alphas`: get on `@happyvertical/smrt-vitest:Issue2890Alpha`
- `get_issue2890betas`: get on `@happyvertical/smrt-vitest:Issue2890Beta`
- `get_issue2890gammas`: get on `@happyvertical/smrt-vitest:Issue2890Gamma`
- `get_issue2890widewidgets`: get on `@happyvertical/smrt-vitest:Issue2890WideWidget`
- `get_notes`: get on `@happyvertical/smrt-vitest:Note`
- `get_treenodes`: get on `@happyvertical/smrt-vitest:TreeNode`
- `list_convnotes`: list on `@happyvertical/smrt-vitest:ConvNote`
- `list_inlineprobegadgets`: list on `@happyvertical/smrt-vitest:InlineProbeGadget`
- `list_issue2427widgets`: list on `@happyvertical/smrt-vitest:Issue2427Widget`
- `list_issue2429widgets`: list on `@happyvertical/smrt-vitest:Issue2429Widget`
- `list_issue2890alphas`: list on `@happyvertical/smrt-vitest:Issue2890Alpha`
- `list_issue2890betas`: list on `@happyvertical/smrt-vitest:Issue2890Beta`
- `list_issue2890gammas`: list on `@happyvertical/smrt-vitest:Issue2890Gamma`
- `list_issue2890widewidgets`: list on `@happyvertical/smrt-vitest:Issue2890WideWidget`
- `list_notes`: list on `@happyvertical/smrt-vitest:Note`
- `list_treenodes`: list on `@happyvertical/smrt-vitest:TreeNode`
- `list_widgets`: list on `@happyvertical/smrt-vitest:Widget`
- `update_convnotes`: update on `@happyvertical/smrt-vitest:ConvNote`
- `update_inlineprobegadgets`: update on `@happyvertical/smrt-vitest:InlineProbeGadget`
- `update_issue2427widgets`: update on `@happyvertical/smrt-vitest:Issue2427Widget`
- `update_issue2429widgets`: update on `@happyvertical/smrt-vitest:Issue2429Widget`
- `update_issue2890alphas`: update on `@happyvertical/smrt-vitest:Issue2890Alpha`
- `update_issue2890betas`: update on `@happyvertical/smrt-vitest:Issue2890Beta`
- `update_issue2890gammas`: update on `@happyvertical/smrt-vitest:Issue2890Gamma`
- `update_issue2890widewidgets`: update on `@happyvertical/smrt-vitest:Issue2890WideWidget`
- `update_notes`: update on `@happyvertical/smrt-vitest:Note`
- `update_treenodes`: update on `@happyvertical/smrt-vitest:TreeNode`
