---
type: "Component"
title: "@happyvertical/smrt-events"
description: "Hierarchical event management with participant tracking and SMRT framework support"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:dc16285ad58faade67478df80071acf26c83ae75d3cc6fd6892339bab9cf4896"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/events/package.json"
    title: "@happyvertical/smrt-events package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/events/AGENTS.md"
    title: "@happyvertical/smrt-events packages/events/AGENTS.md"
---

# @happyvertical/smrt-events

## Package

- Version: `0.60.8`
- Directory: `packages/events`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/events/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-places](/components/smrt-places.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/files`
- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./ui`
- `./utils`

## Models

- `Event` (collection `events`, extends `SmrtHierarchical`, STI table)
- `EventAsset` (collection `eventassets`, extends `SmrtObject`)
- `EventAssetCollection` (collection `eventassets`, extends `SmrtJunction`)
- `EventCollection` (collection `events`, extends `SmrtCollection`)
- `EventParticipant` (collection `eventparticipants`, extends `SmrtObject`)
- `EventParticipantCollection` (collection `eventparticipants`, extends `SmrtJunction`)
- `EventSeries` (collection `eventserieses`, extends `SmrtObject`, STI table)
- `EventSeriesCollection` (collection `eventserieses`, extends `SmrtCollection`)
- `EventType` (collection `eventtypes`, extends `SmrtObject`, STI table)
- `EventTypeCollection` (collection `eventtypes`, extends `SmrtCollection`)

## MCP tools

- `event_create`: create on `@happyvertical/smrt-events:Event`
- `event_get`: get on `@happyvertical/smrt-events:Event`
- `event_list`: list on `@happyvertical/smrt-events:Event`
- `event_update`: update on `@happyvertical/smrt-events:Event`
- `eventparticipant_create`: create on `@happyvertical/smrt-events:EventParticipant`
- `eventparticipant_get`: get on `@happyvertical/smrt-events:EventParticipant`
- `eventparticipant_list`: list on `@happyvertical/smrt-events:EventParticipant`
- `eventparticipant_update`: update on `@happyvertical/smrt-events:EventParticipant`
- `eventseries_create`: create on `@happyvertical/smrt-events:EventSeries`
- `eventseries_get`: get on `@happyvertical/smrt-events:EventSeries`
- `eventseries_list`: list on `@happyvertical/smrt-events:EventSeries`
- `eventseries_update`: update on `@happyvertical/smrt-events:EventSeries`
- `eventtype_create`: create on `@happyvertical/smrt-events:EventType`
- `eventtype_get`: get on `@happyvertical/smrt-events:EventType`
- `eventtype_list`: list on `@happyvertical/smrt-events:EventType`
