---
type: "Component"
title: "@happyvertical/smrt-webhooks"
description: "Outbound webhook subscriptions, signed delivery, and durable retries"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:1b74aa9805572c009b01a58ef57db277f67897bede188c3163b7a752d2467cfe"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/webhooks/package.json"
    title: "@happyvertical/smrt-webhooks package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/webhooks/AGENTS.md"
    title: "@happyvertical/smrt-webhooks packages/webhooks/AGENTS.md"
---

# @happyvertical/smrt-webhooks

## Package

- Directory: `packages/webhooks`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/webhooks/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./admin`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `WebhookCursor` (collection `webhookcursors`, extends `SmrtObject`)
- `WebhookDelivery` (collection `webhookdeliveries`, extends `SmrtObject`)
- `WebhookDeliveryTask` (collection `webhookdeliverytasks`, extends `SmrtObject`)
- `WebhookSubscription` (collection `webhooksubscriptions`, extends `SmrtObject`)
