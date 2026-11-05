---
type: "Component"
title: "@happyvertical/smrt-mcp-conformance-fixture"
description: "Workspace package @happyvertical/smrt-mcp-conformance-fixture"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.0.69"
source_revision: "sha256:7598be8bc8a59f7d10d14fd391b38c41388f95b553da0b24f899da8cdb66d6d9"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/mcp-conformance-fixture/package.json"
    title: "@happyvertical/smrt-mcp-conformance-fixture package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/mcp-conformance-fixture/AGENTS.md"
    title: "@happyvertical/smrt-mcp-conformance-fixture packages/mcp-conformance-fixture/AGENTS.md"
---

# @happyvertical/smrt-mcp-conformance-fixture

## Package

- Version: `0.0.69`
- Directory: `packages/mcp-conformance-fixture`
- Private: yes
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/mcp-conformance-fixture/AGENTS.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-mcp-apps](/components/smrt-mcp-apps.md)
- [smrt-mcp-openai](/components/smrt-mcp-openai.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/files`
- `@happyvertical/sql`

## Models

- `ConformanceAnimal` (collection `conformanceanimals`, extends `SmrtObject`, STI table)
- `ConformanceCat` (collection `conformancecats`, extends `ConformanceAnimal`)
- `ConformanceGadget` (collection `conformancegadgets`, extends `SmrtObject`)
- `ConformanceTaskWidget` (collection `conformancetaskwidgets`, extends `SmrtObject`)
- `ConformanceWidget` (collection `conformancewidgets`, extends `SmrtObject`)
- `IolausApplication` (collection `iolausapplications`, extends `SmrtObject`)

## MCP tools

- `create_conformanceanimals`: create on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceAnimal`
- `create_conformancecats`: create on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat`
- `create_conformancegadgets`: create on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceGadget`
- `delete_conformancecats`: delete on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat`
- `get_conformanceanimals`: get on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceAnimal`
- `get_conformancecats`: get on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat`
- `get_conformancegadgets`: get on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceGadget`
- `get_conformancewidgets`: get on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceWidget`
- `list_conformancecats`: list on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat`
- `list_conformancegadgets`: list on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceGadget`
- `list_conformancewidgets`: list on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceWidget`
- `prepare_iolausapplications`: prepare on `@happyvertical/smrt-mcp-conformance-fixture:IolausApplication`
- `slowGenerate_conformancetaskwidgets`: slowGenerate on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceTaskWidget`
- `update_conformancecats`: update on `@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat`
