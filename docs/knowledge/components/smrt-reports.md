---
type: "Component"
title: "@happyvertical/smrt-reports"
description: "Materialized aggregate report models for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:cc021f94f8d84b1a460cf5d40b4dec2b0d371421df75d0915eeda70061841782"
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
- Object source: `domain-artifact`
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
- `RuntimeReportCollection` (collection `runtimereports`, extends `SmrtCollection`)
- `SmrtPrincipalReportRefreshTask` (collection `smrtprincipalreportrefreshtasks`, extends `SmrtReportRefreshTask`)
- `SmrtReport` (collection `smrtreports`, extends `SmrtObject`)
- `SmrtReportCollection` (collection `smrtreports`, extends `SmrtCollection`)
- `SmrtReportLock` (collection `smrtreportlocks`, extends `SmrtObject`)
- `SmrtReportLockCollection` (collection `smrtreportlocks`, extends `SmrtCollection`)
- `SmrtReportRefreshTask` (collection `smrtreportrefreshtasks`, extends `SmrtObject`)
- `SmrtReportRun` (collection `smrtreportruns`, extends `SmrtObject`)
- `SmrtReportRunCollection` (collection `smrtreportruns`, extends `SmrtCollection`)
- `SmrtReportSchedule` (collection `smrtreportschedules`, extends `SmrtObject`)
- `SmrtReportScheduleCollection` (collection `smrtreportschedules`, extends `SmrtCollection`)
- `SmrtReportWatermark` (collection `smrtreportwatermarks`, extends `SmrtObject`)
- `SmrtReportWatermarkCollection` (collection `smrtreportwatermarks`, extends `SmrtCollection`)

## MCP tools

- `runtimereport_archive`: archive on `@happyvertical/smrt-reports:RuntimeReport`
- `runtimereport_get`: get on `@happyvertical/smrt-reports:RuntimeReport`
- `runtimereport_list`: list on `@happyvertical/smrt-reports:RuntimeReport`
- `runtimereport_run`: run on `@happyvertical/smrt-reports:RuntimeReport`
