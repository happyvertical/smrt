---
type: "Component"
title: "@happyvertical/smrt-ads"
description: "Advertising delivery and tracking models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:f511e6bdeccc99349d7987e167e95d8875e71eb9973874d2d243e70d310b682d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ads/package.json"
    title: "@happyvertical/smrt-ads package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/ads/AGENTS.md"
    title: "@happyvertical/smrt-ads packages/ads/AGENTS.md"
---

# @happyvertical/smrt-ads

## Package

- Directory: `packages/ads`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/ads/AGENTS.md`

## Framework dependencies

- [smrt-commerce](/components/smrt-commerce.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `AdDeliveryTier` (collection `addeliverytiers`, extends `SmrtObject`)
- `AdDeliveryTierCollection` (collection `addeliverytiers`, extends `SmrtCollection`)
- `AdEvent` (collection `adevents`, extends `SmrtObject`, STI table)
- `AdEventCollection` (collection `adevents`, extends `SmrtCollection`)
- `AdFormat` (collection `adformats`, extends `SmrtObject`)
- `AdFormatCollection` (collection `adformats`, extends `SmrtCollection`)
- `AdGroup` (collection `adgroups`, extends `SmrtObject`, STI table)
- `AdGroupCollection` (collection `adgroups`, extends `SmrtCollection`)
- `AdVariation` (collection `advariations`, extends `SmrtObject`, STI table)
- `AdVariationCollection` (collection `advariations`, extends `SmrtCollection`)

## MCP tools

- `create_addeliverytiers`: create on `@happyvertical/smrt-ads:AdDeliveryTierCollection`
- `create_adevents`: create on `@happyvertical/smrt-ads:AdEvent`
- `create_adevents`: create on `@happyvertical/smrt-ads:AdEventCollection`
- `create_adformats`: create on `@happyvertical/smrt-ads:AdFormatCollection`
- `create_adgroups`: create on `@happyvertical/smrt-ads:AdGroup`
- `create_adgroups`: create on `@happyvertical/smrt-ads:AdGroupCollection`
- `create_advariations`: create on `@happyvertical/smrt-ads:AdVariation`
- `create_advariations`: create on `@happyvertical/smrt-ads:AdVariationCollection`
- `delete_addeliverytiers`: delete on `@happyvertical/smrt-ads:AdDeliveryTierCollection`
- `delete_adevents`: delete on `@happyvertical/smrt-ads:AdEventCollection`
- `delete_adformats`: delete on `@happyvertical/smrt-ads:AdFormatCollection`
- `delete_adgroups`: delete on `@happyvertical/smrt-ads:AdGroupCollection`
- `delete_advariations`: delete on `@happyvertical/smrt-ads:AdVariationCollection`
- `get_addeliverytiers`: get on `@happyvertical/smrt-ads:AdDeliveryTier`
- `get_addeliverytiers`: get on `@happyvertical/smrt-ads:AdDeliveryTierCollection`
- `get_adevents`: get on `@happyvertical/smrt-ads:AdEventCollection`
- `get_adformats`: get on `@happyvertical/smrt-ads:AdFormat`
- `get_adformats`: get on `@happyvertical/smrt-ads:AdFormatCollection`
- `get_adgroups`: get on `@happyvertical/smrt-ads:AdGroup`
- `get_adgroups`: get on `@happyvertical/smrt-ads:AdGroupCollection`
- `get_advariations`: get on `@happyvertical/smrt-ads:AdVariation`
- `get_advariations`: get on `@happyvertical/smrt-ads:AdVariationCollection`
- `list_addeliverytiers`: list on `@happyvertical/smrt-ads:AdDeliveryTier`
- `list_addeliverytiers`: list on `@happyvertical/smrt-ads:AdDeliveryTierCollection`
- `list_adevents`: list on `@happyvertical/smrt-ads:AdEventCollection`
- `list_adformats`: list on `@happyvertical/smrt-ads:AdFormat`
- `list_adformats`: list on `@happyvertical/smrt-ads:AdFormatCollection`
- `list_adgroups`: list on `@happyvertical/smrt-ads:AdGroup`
- `list_adgroups`: list on `@happyvertical/smrt-ads:AdGroupCollection`
- `list_advariations`: list on `@happyvertical/smrt-ads:AdVariation`
- `list_advariations`: list on `@happyvertical/smrt-ads:AdVariationCollection`
- `update_addeliverytiers`: update on `@happyvertical/smrt-ads:AdDeliveryTierCollection`
- `update_adevents`: update on `@happyvertical/smrt-ads:AdEventCollection`
- `update_adformats`: update on `@happyvertical/smrt-ads:AdFormatCollection`
- `update_adgroups`: update on `@happyvertical/smrt-ads:AdGroupCollection`
- `update_advariations`: update on `@happyvertical/smrt-ads:AdVariationCollection`
