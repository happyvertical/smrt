---
type: "Component"
title: "@happyvertical/smrt-reports"
description: "Materialized aggregate report models for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-17T17:27:50Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:ddb0ad350e091315b90382762d7427444223307567d6da5eb9549bb21c354747"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reports/package.json"
    title: "@happyvertical/smrt-reports package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reports/AGENTS.md"
    title: "@happyvertical/smrt-reports packages/reports/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reports/README.md"
    title: "@happyvertical/smrt-reports packages/reports/README.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reports/agents/runtime-report-browser.md"
    title: "@happyvertical/smrt-reports packages/reports/agents/runtime-report-browser.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/reports/agents/runtime-reports.md"
    title: "@happyvertical/smrt-reports packages/reports/agents/runtime-reports.md"
---

# @happyvertical/smrt-reports

## Package

- Directory: `packages/reports`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/reports/AGENTS.md`
- `packages/reports/README.md`
- `packages/reports/agents/runtime-report-browser.md`
- `packages/reports/agents/runtime-reports.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./aggregate`
- `./compiler`
- `./decorators`
- `./display`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./refresh`
- `./scheduler`
- `./spec`
- `./state`
- `./svelte`

## Models

- `RuntimeReport` (collection `runtimereports`, extends `SmrtObject`)
- `SmrtPrincipalReportRefreshTask` (collection `smrtprincipalreportrefreshtasks`, extends `SmrtReportRefreshTask`)
- `SmrtReportLock` (collection `smrtreportlocks`, extends `SmrtObject`)
- `SmrtReportRefreshTask` (collection `smrtreportrefreshtasks`, extends `SmrtObject`)
- `SmrtReportRun` (collection `smrtreportruns`, extends `SmrtObject`)
- `SmrtReportSchedule` (collection `smrtreportschedules`, extends `SmrtObject`)
- `SmrtReportWatermark` (collection `smrtreportwatermarks`, extends `SmrtObject`)

## MCP tools

- `archive_runtimereports`: archive on `@happyvertical/smrt-reports:RuntimeReport`
- `get_runtimereports`: get on `@happyvertical/smrt-reports:RuntimeReport`
- `list_runtimereports`: list on `@happyvertical/smrt-reports:RuntimeReport`
- `run_runtimereports`: run on `@happyvertical/smrt-reports:RuntimeReport`
