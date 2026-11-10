---
type: "Component"
title: "@happyvertical/smrt-analytics"
description: "Analytics integration models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:55:44Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:da9625dcc5cd080352c83d4a4df595e3fe351beae9958b165611bfccf341f60f"
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
---

# @happyvertical/smrt-analytics

## Package

- Directory: `packages/analytics`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/analytics/AGENTS.md`
- `packages/analytics/agents/browser.md`

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

- `analyticsdatastream_get`: get on `@happyvertical/smrt-analytics:AnalyticsDataStream`
- `analyticsdatastream_list`: list on `@happyvertical/smrt-analytics:AnalyticsDataStream`
- `analyticsevent_get`: get on `@happyvertical/smrt-analytics:AnalyticsEvent`
- `analyticsevent_list`: list on `@happyvertical/smrt-analytics:AnalyticsEvent`
- `analyticsproperty_get`: get on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `analyticsproperty_list`: list on `@happyvertical/smrt-analytics:AnalyticsProperty`
- `analyticsreport_get`: get on `@happyvertical/smrt-analytics:AnalyticsReport`
- `analyticsreport_list`: list on `@happyvertical/smrt-analytics:AnalyticsReport`
