---
type: "Component"
title: "@happyvertical/smrt-events"
description: "Hierarchical event management with participant tracking and SMRT framework support"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:41ec99384614fb3c4615eab838bde39cab4cb4d5cbe7cec734d8c438abb9b2be"
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

- Directory: `packages/events`
- Private: no
- Object source: `manifest`
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

- `create_eventparticipants`: create on `@happyvertical/smrt-events:EventParticipant`
- `create_eventparticipants`: create on `@happyvertical/smrt-events:EventParticipantCollection`
- `create_events`: create on `@happyvertical/smrt-events:Event`
- `create_events`: create on `@happyvertical/smrt-events:EventCollection`
- `create_eventserieses`: create on `@happyvertical/smrt-events:EventSeries`
- `create_eventserieses`: create on `@happyvertical/smrt-events:EventSeriesCollection`
- `create_eventtypes`: create on `@happyvertical/smrt-events:EventType`
- `create_eventtypes`: create on `@happyvertical/smrt-events:EventTypeCollection`
- `delete_eventparticipants`: delete on `@happyvertical/smrt-events:EventParticipantCollection`
- `delete_events`: delete on `@happyvertical/smrt-events:EventCollection`
- `delete_eventserieses`: delete on `@happyvertical/smrt-events:EventSeriesCollection`
- `delete_eventtypes`: delete on `@happyvertical/smrt-events:EventTypeCollection`
- `get_eventparticipants`: get on `@happyvertical/smrt-events:EventParticipant`
- `get_eventparticipants`: get on `@happyvertical/smrt-events:EventParticipantCollection`
- `get_events`: get on `@happyvertical/smrt-events:Event`
- `get_events`: get on `@happyvertical/smrt-events:EventCollection`
- `get_eventserieses`: get on `@happyvertical/smrt-events:EventSeries`
- `get_eventserieses`: get on `@happyvertical/smrt-events:EventSeriesCollection`
- `get_eventtypes`: get on `@happyvertical/smrt-events:EventType`
- `get_eventtypes`: get on `@happyvertical/smrt-events:EventTypeCollection`
- `list_eventparticipants`: list on `@happyvertical/smrt-events:EventParticipant`
- `list_eventparticipants`: list on `@happyvertical/smrt-events:EventParticipantCollection`
- `list_events`: list on `@happyvertical/smrt-events:Event`
- `list_events`: list on `@happyvertical/smrt-events:EventCollection`
- `list_eventserieses`: list on `@happyvertical/smrt-events:EventSeries`
- `list_eventserieses`: list on `@happyvertical/smrt-events:EventSeriesCollection`
- `list_eventtypes`: list on `@happyvertical/smrt-events:EventType`
- `list_eventtypes`: list on `@happyvertical/smrt-events:EventTypeCollection`
- `update_eventparticipants`: update on `@happyvertical/smrt-events:EventParticipant`
- `update_eventparticipants`: update on `@happyvertical/smrt-events:EventParticipantCollection`
- `update_events`: update on `@happyvertical/smrt-events:Event`
- `update_events`: update on `@happyvertical/smrt-events:EventCollection`
- `update_eventserieses`: update on `@happyvertical/smrt-events:EventSeries`
- `update_eventserieses`: update on `@happyvertical/smrt-events:EventSeriesCollection`
- `update_eventtypes`: update on `@happyvertical/smrt-events:EventTypeCollection`
