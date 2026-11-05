# Notification email outbox (#4237)

`NotificationOutboxService` turns a host event into at most one outbound email
per recipient and delivers it from a crash-safe, leased outbox. It pairs with
`UserNotificationService`: hosts that tell someone in-app and by email pass the
same `sourceRef` to both.

Source: `src/models/NotificationDelivery.ts`,
`src/services/NotificationOutboxService.ts`,
tests `src/__tests__/notification-outbox*.test.ts`.

## Enqueue

`enqueueEmail({ tenantId, recipientUserId, sourceRef, kind, subject, text, path, notBefore? })`
stores one `NotificationDelivery` (`notification_deliveries`) per
`(tenant_id, recipient_user_id, channel, source_ref)`, the conflict identity. A
repeat (or a concurrent duplicate that loses the insert) returns the stored row
untouched with `created: false`. Encode each distinct event in `sourceRef`, e.g.
`project-question:<id>:asked` and `project-question:<id>:reminder:<n>`.

Host authorization, all checked before anything is stored:

- `resolveRecipient({ tenantId, recipientUserId, channel })` returns the address
  the host allows for that user in that tenant, or `null` (denied with
  `NotificationOutboxDeniedError`, reason `recipient`). Callers never pass an
  address; the resolved one is snapshotted on the row.
- `resolveSenderAccountId({ tenantId })` names an active `EmailAccount` owned by
  the same tenant (reason `sender` otherwise). Configuring that account is
  deployment setup; the outbox has no mail transport of its own.
- With `principal`, enqueue, `listUncertain`, and `reconcile` require
  `messages.send` in the tenant (reason `permission`). Omit it only for trusted
  system code that authorizes itself.
- `isSuppressed(...)` (optional) is the opt-out hook. A suppressed enqueue stores
  a `cancelled` row (so the event stays deduplicated); suppression at dispatch
  cancels before handoff. The package's own preference store is the
  [opt-out ledger](#opt-out-ledger); wire it with `optOutSuppression`.

Deep links: `path` must be host-relative (`/portal/...`); it is joined to
`linkBaseUrl` (absolute http(s), no credentials/query/fragment, validated at
construction) and must stay on that origin — `//host`, backslashes, whitespace,
and control characters are refused (reason `link`). The link is stored on the
row, so a duplicate enqueue keeps the first link. Links carry no tokens: they
lead to the host's normal authenticated route. Subjects must be one line.

## Dispatch

`dispatchDue({ tenantIds?, limit? })` (default 25, max 200) leases due rows —
`pending` with `nextAttemptAt <= now`, and `sending` rows whose lease lapsed —
for the given tenants, or every tenant (discovered under `withSystemContext`)
when `tenantIds` is omitted. Each row is processed under `withTenant(row.tenantId)`.
Run it from a scheduled job; several workers may run it concurrently.

Every state change is `NotificationDelivery.transition()`: a compare-and-set on
`stateVersion` (and the lease token for a lease holder) that writes a unique
`transitionId` and re-reads the row to prove the write won. PostgreSQL and
remote LibSQL use one conditional `UPDATE`; local embedded engines use the
process write queue, like `Message.send()`'s claim.

Per row:

1. Acquire: `status = sending`, new `leaseToken`, `leaseExpiresAt = now + leaseMs`
   (default 5 min; must exceed the slowest provider call), `attempts + 1`.
2. Create the single outbound `Email` and record `messageId`. Its id is
   `notificationDeliveryMessageId(deliveryId)` (a name-based uuid) and it is
   inserted insert-only, so a crashed or stale dispatcher finds or collides
   with the stored row instead of creating a second email; its correlation id
   is `notification-delivery:<deliveryId>`.
3. Record `handedOffAt`, then call `transport.send({ delivery, message, idempotencyKey })`.
4. Settle with the lease token: `accepted` → `sent`; `rejected` + `retryable`
   → `pending` after `retryDelayMs(attempts)` (default 1 min · 2ⁿ⁻¹, capped at
   1 h) until `maxAttempts` (default 5), then `failed`; non-retryable → `failed`;
   `unknown` (including a thrown send) → `uncertain`. A holder whose lease was
   taken over gets `lease-lost` and writes nothing.

## Provider idempotency and reconciliation policy

Delivery is at-most-once once a provider may have seen the message.

- A lapsed lease with no `handedOffAt` never reached the provider: it is resent.
- Ambiguous provider failures are not rejections. `EmailSender` sets
  `MessageSendResult.outcomeUnknown` unless `isDefiniteSendRejection()` proves
  the send was refused (an SMTP reply code, an SDK auth/validation error, a
  send error that accepted no recipient, or a connection that was never made);
  `Message.send()` sets it when a sender throws. `Message` persists the marker
  in `metadata.sendOutcomeUnknown` with the `failed` status
  (`Message.isSendOutcomeUnknown()`), and `messageSendTransport` maps it to
  `unknown`, so the delivery becomes `uncertain` instead of being retried.
- A lapsed lease after `handedOffAt` asks `transport.reconcile()`. The default
  `messageSendTransport` reads the canonical `Message.sendStatus`: `sent` →
  delivery `sent` (no resend), `failed` → normal retry (or `uncertain` when the
  failure carries the outcome-unknown marker), `draft`/`pending` → resend,
  anything else (e.g. still `sending`) → `uncertain`.
- `uncertain` rows are never resent automatically. Operators list them with
  `listUncertain({ tenantId })` and settle them with
  `reconcile({ tenantId, deliveryId, outcome: 'sent' | 'failed' | 'retry', note? })`
  after checking the provider; `retry` accepts the risk of a duplicate. It
  first releases a message a dead sender left `sending`
  (`Message.abandonSendAttempt()`, a compare-and-set to `failed`) so the next
  lease can send it, and refuses when the message is recorded as `sent`.
- A transport with `idempotent: true` declares that its provider deduplicates on
  `idempotencyKey` (stable per delivery); unknown outcomes are then retried
  instead of parked. SMTP and the current SDK email providers take no key, so
  `messageSendTransport` is not idempotent.

## Transport seam

`NotificationTransport { name; idempotent?; send(request); reconcile?(request) }`.
The default delivers through `Message.send()` → account → registered provider
sender (import `@happyvertical/smrt-messages/providers/email` at server
startup). Tests inject a fake; nothing in the outbox reaches a provider SDK.

## Opt-out ledger

`NotificationOptOut` (`notification_opt_outs`, tenant-required, generated
REST/MCP/CLI off) records one row per `(tenant_id, recipient_user_id, channel,
scope)`: `channel` is `email`; `scope` is `*` (all notification email in the
tenant) or a host key such as `project:<uuid>` (lowercase prefix, `:`, then
`[A-Za-z0-9._:-]{1,200}`; malformed scopes throw). `optedOutAt` is set while
opted out and cleared by an opt-in (the row stays as history); `updatedBy` is
the person's user id, or `system` for host code. It exists because
`smrt-preferences` is owner-read only, while suppression runs where the recipient
is not the caller (a manager enqueues, a worker dispatches).

`NotificationOptOutService({ db })`:

- `optOut({ tenantId, recipientUserId, channel, scope, principal? })` and
  `optIn(...)` are idempotent. With `principal: { userId, tenantId? }` only
  `principal.userId === recipientUserId` may change the row
  (`NotificationOptOutDeniedError`, reason `principal` or `tenant`); without
  one the call is trusted host code that authenticated the recipient (e.g. a
  signed unsubscribe link).
- `isOptedOut({ tenantId, recipientUserId, channel, scope })` is the trusted
  suppression read, under `withTenant`; a `*` row matches every scope.
- `listForRecipient({ tenantId, recipientUserId, principal })` returns only the
  recipient's own active opt-outs; any other principal is denied.

```ts
const optOuts = new NotificationOptOutService({ db });
new NotificationOutboxService({
  // ...
  isSuppressed: optOutSuppression(optOuts, (request) => {
    const project = /^project-question:([^:]+):/.exec(request.sourceRef)?.[1];
    return project ? `project:${project}` : null; // null = not opt-out-able
  }),
});
```

Because the outbox re-checks at dispatch, an opt-out recorded after enqueue
cancels the pending delivery before handoff. Tests:
`src/__tests__/notification-opt-out*.test.ts`.

## Schema

New tables `notification_opt_outs` (same rules) and `notification_deliveries` (tenant-required, generated REST/MCP/CLI
off): consumers run `db:migrate`. `recipient_user_id` is a cross-package uuid
ref to `smrt-users:User`; `account_id`/`message_id` are FKs to `accounts` and
`messages`.
