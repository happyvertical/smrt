---
type: "Component"
title: "@happyvertical/smrt-ads"
description: "Advertising delivery and tracking models for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:c1c82207bb60c26f1be88ca25e8923ea7989d75cd8ab53acb2ddffd009854e28"
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
- Object source: `domain-artifact`
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

- `addeliverytier_get`: get on `@happyvertical/smrt-ads:AdDeliveryTier`
- `addeliverytier_list`: list on `@happyvertical/smrt-ads:AdDeliveryTier`
- `adevent_create`: create on `@happyvertical/smrt-ads:AdEvent`
- `adformat_get`: get on `@happyvertical/smrt-ads:AdFormat`
- `adformat_list`: list on `@happyvertical/smrt-ads:AdFormat`
- `adgroup_create`: create on `@happyvertical/smrt-ads:AdGroup`
- `adgroup_get`: get on `@happyvertical/smrt-ads:AdGroup`
- `adgroup_list`: list on `@happyvertical/smrt-ads:AdGroup`
- `advariation_create`: create on `@happyvertical/smrt-ads:AdVariation`
- `advariation_get`: get on `@happyvertical/smrt-ads:AdVariation`
- `advariation_list`: list on `@happyvertical/smrt-ads:AdVariation`
