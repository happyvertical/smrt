---
type: "Component"
title: "@happyvertical/smrt-analytics"
description: "Analytics integration models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-17T17:40:06Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d515e72beae35064cbac3649f5d7df71c79fc2756639b3c28782b8f21ae1e404"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/analytics/package.json"
    title: "@happyvertical/smrt-analytics package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/analytics/AGENTS.md"
    title: "@happyvertical/smrt-analytics packages/analytics/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/analytics/agents/browser.md"
    title: "@happyvertical/smrt-analytics packages/analytics/agents/browser.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/analytics/agents/observability.md"
    title: "@happyvertical/smrt-analytics packages/analytics/agents/observability.md"
---

# @happyvertical/smrt-analytics

## Package

- Directory: `packages/analytics`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/analytics/AGENTS.md`
- `packages/analytics/agents/browser.md`
- `packages/analytics/agents/observability.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./browser`
- `./manifest`
- `./manifest.json`
- `./observability`
- `./playground`
- `./svelte`
- `./ui`

## Models

- `AnalyticsDataStream` (collection `analyticsdatastreams`, extends `SmrtObject`, STI table)
- `AnalyticsDataStreamCollection` (collection `analyticsdatastreams`, extends `SmrtCollection`)
- `AnalyticsEvent` (collection `analyticsevents`, extends `SmrtObject`, STI table)
- `AnalyticsEventCollection` (collection `analyticsevents`, extends `SmrtCollection`)
- `AnalyticsProperty` (collection `analyticsproperties`, extends `SmrtObject`, STI table)
- `AnalyticsPropertyCollection` (collection `analyticsproperties`, extends `SmrtCollection`)
- `AnalyticsReport` (collection `analyticsreports`, extends `SmrtObject`, STI table)
- `AnalyticsReportCollection` (collection `analyticsreports`, extends `SmrtCollection`)

## MCP tools

- `analyze_analyticsreports`: analyze on `@happyvertical/smrt-analytics:AnalyticsReport`
- `create_analyticsdatastreams`: create on `@happyvertical/smrt-analytics:AnalyticsDataStreamCollection`
- `create_analyticsevents`: create on `@happyvertical/smrt-analytics:AnalyticsEventCollection`
- `create_analyticsproperties`: create on `@happyvertical/smrt-analytics:AnalyticsPropertyCollection`
- `create_analyticsreports`: create on `@happyvertical/smrt-analytics:AnalyticsReportCollection`
- `delete_analyticsdatastreams`: delete on `@happyvertical/smrt-analytics:AnalyticsDataStreamCollection`
- `delete_analyticsevents`: delete on `@happyvertical/smrt-analytics:AnalyticsEventCollection`
- `delete_analyticsproperties`: delete on `@happyvertical/smrt-analytics:AnalyticsPropertyCollection`
- `delete_analyticsreports`: delete on `@happyvertical/smrt-analytics:AnalyticsReportCollection`
- `get_analyticsdatastreams`: get on `@happyvertical/smrt-analytics:AnalyticsDataStream`
- `get_analyticsdatastreams`: get on `@happyvertical/smrt-analytics:AnalyticsDataStreamCollection`
- `get_analyticsevents`: get on `@happyvertical/smrt-analytics:AnalyticsEvent`
- `get_analyticsevents`: get on `@happyvertical/smrt-analytics:AnalyticsEventCollection`
- `get_analyticsproperties`: get on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `get_analyticsproperties`: get on `@happyvertical/smrt-analytics:AnalyticsPropertyCollection`
- `get_analyticsreports`: get on `@happyvertical/smrt-analytics:AnalyticsReport`
- `get_analyticsreports`: get on `@happyvertical/smrt-analytics:AnalyticsReportCollection`
- `list_analyticsdatastreams`: list on `@happyvertical/smrt-analytics:AnalyticsDataStream`
- `list_analyticsdatastreams`: list on `@happyvertical/smrt-analytics:AnalyticsDataStreamCollection`
- `list_analyticsevents`: list on `@happyvertical/smrt-analytics:AnalyticsEvent`
- `list_analyticsevents`: list on `@happyvertical/smrt-analytics:AnalyticsEventCollection`
- `list_analyticsproperties`: list on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `list_analyticsproperties`: list on `@happyvertical/smrt-analytics:AnalyticsPropertyCollection`
- `list_analyticsreports`: list on `@happyvertical/smrt-analytics:AnalyticsReport`
- `list_analyticsreports`: list on `@happyvertical/smrt-analytics:AnalyticsReportCollection`
- `runReport_analyticsproperties`: runReport on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `run_analyticsreports`: run on `@happyvertical/smrt-analytics:AnalyticsReport`
- `sync_analyticsproperties`: sync on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `track_analyticsevents`: track on `@happyvertical/smrt-analytics:AnalyticsEvent`
- `update_analyticsdatastreams`: update on `@happyvertical/smrt-analytics:AnalyticsDataStreamCollection`
- `update_analyticsevents`: update on `@happyvertical/smrt-analytics:AnalyticsEventCollection`
- `update_analyticsproperties`: update on `@happyvertical/smrt-analytics:AnalyticsPropertyCollection`
- `update_analyticsreports`: update on `@happyvertical/smrt-analytics:AnalyticsReportCollection`
