---
type: "Component"
title: "@happyvertical/smrt-marketing"
description: "Cross-channel campaign coordination, immutable performance evidence, budget pacing, and reusable Svelte marketing surfaces for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:514b5e943cb001d58eab399e3b8cf539f76727c96503ff0208eab62f25648c9d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/marketing/package.json"
    title: "@happyvertical/smrt-marketing package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/marketing/AGENTS.md"
    title: "@happyvertical/smrt-marketing packages/marketing/AGENTS.md"
---

# @happyvertical/smrt-marketing

## Package

- Directory: `packages/marketing`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/marketing/AGENTS.md`

## Framework dependencies

- [smrt-commerce](/components/smrt-commerce.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `Campaign` (collection `campaigns`, extends `SmrtObject`)
- `CampaignChannel` (collection `campaignchannels`, extends `SmrtObject`)
- `CampaignMetricSnapshot` (collection `campaignmetricsnapshots`, extends `SmrtObject`)

## MCP tools

- `create_campaignchannels`: create on `@happyvertical/smrt-marketing:CampaignChannel`
- `create_campaignmetricsnapshots`: create on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
- `create_campaigns`: create on `@happyvertical/smrt-marketing:Campaign`
- `get_campaignchannels`: get on `@happyvertical/smrt-marketing:CampaignChannel`
- `get_campaignmetricsnapshots`: get on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
- `get_campaigns`: get on `@happyvertical/smrt-marketing:Campaign`
- `list_campaignchannels`: list on `@happyvertical/smrt-marketing:CampaignChannel`
- `list_campaignmetricsnapshots`: list on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
- `list_campaigns`: list on `@happyvertical/smrt-marketing:Campaign`
- `update_campaignchannels`: update on `@happyvertical/smrt-marketing:CampaignChannel`
- `update_campaigns`: update on `@happyvertical/smrt-marketing:Campaign`
