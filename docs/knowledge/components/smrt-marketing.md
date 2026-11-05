---
type: "Component"
title: "@happyvertical/smrt-marketing"
description: "Cross-channel campaign coordination, immutable performance evidence, budget pacing, and reusable Svelte marketing surfaces for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:7d5c3fb774a2b5ece7c5ed5e70cce61e9b4f8053ae323a6ac59f6722eefa55ae"
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

- Version: `0.60.8`
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
