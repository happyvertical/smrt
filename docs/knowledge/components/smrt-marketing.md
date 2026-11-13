---
type: "Component"
title: "@happyvertical/smrt-marketing"
description: "Cross-channel campaign coordination, immutable performance evidence, budget pacing, and reusable Svelte marketing surfaces for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T22:32:35Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:e128fbefd0504a038ef657ab4b8fd8bcfef2f4ab56fe72d1e36237b35c769fc9"
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
- Object source: `domain-artifact`
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
- `CampaignChannelCollection` (collection `campaignchannels`, extends `SmrtCollection`)
- `CampaignCollection` (collection `campaigns`, extends `SmrtCollection`)
- `CampaignMetricSnapshot` (collection `campaignmetricsnapshots`, extends `SmrtObject`)
- `CampaignMetricSnapshotCollection` (collection `campaignmetricsnapshots`, extends `SmrtCollection`)

## MCP tools

- `campaign_create`: create on `@happyvertical/smrt-marketing:Campaign`
- `campaign_get`: get on `@happyvertical/smrt-marketing:Campaign`
- `campaign_list`: list on `@happyvertical/smrt-marketing:Campaign`
- `campaign_update`: update on `@happyvertical/smrt-marketing:Campaign`
- `campaignchannel_create`: create on `@happyvertical/smrt-marketing:CampaignChannel`
- `campaignchannel_get`: get on `@happyvertical/smrt-marketing:CampaignChannel`
- `campaignchannel_list`: list on `@happyvertical/smrt-marketing:CampaignChannel`
- `campaignchannel_update`: update on `@happyvertical/smrt-marketing:CampaignChannel`
- `campaignmetricsnapshot_create`: create on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
- `campaignmetricsnapshot_get`: get on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
- `campaignmetricsnapshot_list`: list on `@happyvertical/smrt-marketing:CampaignMetricSnapshot`
