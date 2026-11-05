---
type: "Component"
title: "@happyvertical/smrt-webhooks"
description: "Outbound webhook subscriptions, signed delivery, and durable retries"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:f5282701ffdaa4f354a923d02010316c5c5d7ec8f1d65ec3b2cca1cfdd187690"
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
- Object source: `domain-artifact`
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
- `WebhookDeliveryCollection` (collection `webhookdeliveries`, extends `SmrtCollection`)
- `WebhookDeliveryTask` (collection `webhookdeliverytasks`, extends `SmrtObject`)
- `WebhookSubscription` (collection `webhooksubscriptions`, extends `SmrtObject`)
- `WebhookSubscriptionCollection` (collection `webhooksubscriptions`, extends `SmrtCollection`)
