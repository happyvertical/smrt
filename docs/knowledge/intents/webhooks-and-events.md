---
type: Capability
title: "Webhooks and events"
description: "Reach for smrt-webhooks for outbound signed delivery and the core DispatchBus for in-process events; there is no generic inbound webhook receiver at this revision."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/webhooks/src/security.ts
    path: packages/webhooks/src/security.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/webhooks/src/security.ts (assertWebhookUrl, assertHmacSecret, sendPublicWebhook)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/webhooks/src/dispatcher.ts
    path: packages/webhooks/src/dispatcher.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/webhooks/src/dispatcher.ts (WebhookDispatcher.deliver)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/dispatch/bus.ts
    path: packages/core/src/dispatch/bus.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/dispatch/bus.ts (DispatchBus.emit, process)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/forge-projection.ts
    path: packages/jobs/src/forge-projection.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/forge-projection.ts (ForgeDelivery inbox)"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/events/package.json
    path: packages/events/package.json
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/events/package.json (description)"
---

# Webhooks and events

# Entry point

Outbound: `@happyvertical/smrt-webhooks` is server-only. Subscribers are `WebhookSubscription` rows managed through `WebhookAdminService`; publish from the change feed with `WebhookChangeFeed` (preferred) or `registerWebhookModelEvents()` (never both for one model), and run deliveries with `runWebhookDeliveryJob` on the smrt-jobs queue. In-process events: `createDispatchBus()` / `DispatchBus` (`emit()`, `on()`, `subscribe()`, `process()`) in `@happyvertical/smrt-core`. Corrections to the expected home: [smrt-events](/components/smrt-events.md) is the calendar and event-hierarchy model, not an event bus; and no package provides a generic inbound webhook receiver at this revision. The closest inbound pattern is the provider-neutral forge delivery inbox in smrt-jobs (`ForgeDelivery`, `ForgeProjectionRuntime`).[^s4][^s5]

# Why not hand-roll it

`sendPublicWebhook()` in `security.ts` validates every DNS answer as a public address, pins the socket lookup to the validated answer so a second resolution cannot rebind, follows no redirects, uses no proxy or pooled sockets, and bounds DNS (5 s) and request (10 s) time; `assertWebhookUrl()` rejects non-HTTPS, ports other than 443, embedded credentials and localhost, and `assertHmacSecret()` requires a 32 to 4096 byte secret.[^s1] `WebhookDispatcher.deliver()` signs `timestamp.payload` with HMAC-SHA256 over the exact stored bytes and sends a stable `x-smrt-delivery` id because HTTP delivery is at-least-once and receivers must deduplicate.[^s2] `DispatchBus` derives the tenant server-side from the active context and claims a dispatch with a conditional UPDATE on `status = 'pending'`, so a subscriber in one tenant cannot see another tenant's dispatches.[^s3]

# Component pages

- [smrt-webhooks](/components/smrt-webhooks.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-events](/components/smrt-events.md)

# Detection signals

- `import:svix`
- `regex:createHmac\(`
- `regex:x-[a-z-]*signature`

[^s1]: `packages/webhooks/src/security.ts` at `478ae36900`: assertWebhookUrl, assertHmacSecret, sendPublicWebhook.
[^s2]: `packages/webhooks/src/dispatcher.ts` at `478ae36900`: WebhookDispatcher.deliver.
[^s3]: `packages/core/src/dispatch/bus.ts` at `478ae36900`: DispatchBus.emit, process.
[^s4]: `packages/jobs/src/forge-projection.ts` at `478ae36900`: ForgeDelivery inbox.
[^s5]: `packages/events/package.json` at `478ae36900`: description.
