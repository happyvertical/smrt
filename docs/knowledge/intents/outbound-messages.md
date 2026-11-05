---
type: Capability
title: "Outbound email, SMS and chat messages"
description: "Reach for smrt-messages before calling a mailer or chat SDK directly from application code."
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
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/messages/src/services/PersonaMessagingService.ts
    path: packages/messages/src/services/PersonaMessagingService.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/messages/src/services/PersonaMessagingService.ts (PersonaMessagingService.send)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/messages/src/permissions.ts
    path: packages/messages/src/permissions.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/messages/src/permissions.ts (assertMessagingPermission, SEND_MESSAGES_PERMISSION)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/messages/src/senders/EmailSender.ts
    path: packages/messages/src/senders/EmailSender.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/messages/src/senders/EmailSender.ts (EmailSender.send)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/messages/src/index.ts
    path: packages/messages/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/messages/src/index.ts (public exports)"
---

# Outbound email, SMS and chat messages

# Entry point

Import from `@happyvertical/smrt-messages`. Send through `new PersonaMessagingService({ db, tenantId, principal }).send({ personaId, body, subject, attachments, routeId })`, which resolves a persona-owned route (account plus endpoint), persists a `Message` (or `Email`) row and delivers it. Channel transports are `EmailSender`, `SlackSender`, `TelegramSender`, `ZulipSender` and `TweetSender`; accounts and routes are managed through `MessagingSettingsService`, and in-app notices through `UserNotificationService`. Providers are registered with `registerMessagingProvider()`.[^s4]

# Why not hand-roll it

`PersonaMessagingService.send()` in `PersonaMessagingService.ts` checks `SEND_MESSAGES_PERMISSION` with `assertMessagingPermission` (a principal from another tenant is rejected), runs inside `withTenant`, refuses an account or endpoint that belongs to another tenant, is inactive, or whose channel does not match the route, rejects attachments on non-email routes, and saves the message with `sendStatus: 'pending'` before it calls the transport, so every send has a ledger row.[^s1][^s2] `EmailSender.send()` resolves every attachment before anything reaches the transport, so an unreadable file fails the send instead of leaving a message silently without it (#3808).[^s3] A direct SDK call skips the permission check, the tenant ownership checks and the persisted record.

# Component pages

- [smrt-messages](/components/smrt-messages.md)
- [smrt-tenancy](/components/smrt-tenancy.md)

# Detection signals

- `import:nodemailer`
- `import:@sendgrid/mail`
- `import:twilio`
- `import:@slack/web-api`
- `import:resend`
- `import:postmark`
- `import:mailgun.js`

[^s1]: `packages/messages/src/services/PersonaMessagingService.ts` at `478ae36900`: PersonaMessagingService.send.
[^s2]: `packages/messages/src/permissions.ts` at `478ae36900`: assertMessagingPermission, SEND_MESSAGES_PERMISSION.
[^s3]: `packages/messages/src/senders/EmailSender.ts` at `478ae36900`: EmailSender.send.
[^s4]: `packages/messages/src/index.ts` at `478ae36900`: public exports.
