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
- With `principal`, enqueue, dispatch, `listUncertain`, and `reconcile` require
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

`dispatchDue({ tenantIds?, deliveryIds?, limit? })` (default 25, max 200) leases due rows —
`pending` with `nextAttemptAt <= now`, and `sending` rows whose lease lapsed —
for the given tenants, or every tenant (discovered under `withSystemContext`)
when `tenantIds` is omitted. Each row is processed under `withTenant(row.tenantId)`.
Run it from a scheduled job; several workers may run it concurrently.

`deliveryIds` restricts both pending and expired-lease queries before their limits
and before leases; an empty array selects nothing and malformed UUIDs are
rejected. A principal defaults to its own tenant when `tenantIds` is omitted;
a principal without a tenant must select explicit tenants. Every explicit scope
is authorized before discovery, and selected rows are authorized again before
dispatch. Trusted system code without a principal retains cross-tenant discovery.

`NotificationOutboxService.capabilities` exposes `deliverySelection: true` and
`attachments: true` so hosts requiring these contracts can refuse an older
library before leasing any row. This marker does not authorize any sender.

`resolveAttachments({delivery,message,idempotencyKey})` is an optional trusted-host
hook, called before each fresh provider handoff. It must reauthorize the approved
resource, immutable version/digest and recipient and return `SendEmailAttachment[]`
using actual bytes, never untrusted file paths or URLs. Malformed results or
resolver failures reject before handoff; attachments are copied into the transport
request and the default transport forwards them to existing `Email.send()`. The
outbox does not persist bytes or invent document/recipient authority. Omission
preserves ordinary no-attachment notifications; an explicit resolver returning
`undefined` fails instead of silently dropping an expected document. Prior-handoff
reconciliation runs without requiring document bytes; an accepted or uncertain
outcome does not cause another attachment resolution/send.

Protected documents enqueue with `kind: 'protected:<policyId>'`,
`requiredDispatchPolicy: '<policyId>'` and an approved `dispatchPolicyBinding`
object (resource/version/digest/recipient identities). The trusted constructor
map `dispatchPolicies[policyId].resolveAttachments` owns current authorization
and actual-byte verification. Protected kinds require their exact policy;
enqueue rejects unknown handlers or missing bindings. A broad dispatcher without
the matching policy reports `blocked`, persists a detectable `lastError`, and
leaves provider calls and lease attempts at zero. A protected policy must return
at least one valid attachment. Existing source, policy/binding, destination,
sender and message content cannot change through an ordinary model save;
protected clones retaining their kind cannot remove the policy. Missing policy
does not authorize a resend of an uncertain prior attempt. The capability marker
includes `requiredPolicy: true`.

The two additive columns require normal consumer migration. Old rows default to
an empty policy and retain legacy ordinary-mail behavior; no historical document
consent is invented. Never run old dispatcher binaries alongside newly protected
intents: old versions cannot enforce a contract they do not implement. Rollout
and real sends require separate authorization.

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
  `optIn(...)` are idempotent. With `principal: { userId, tenantId }` only
  `principal.userId === recipientUserId` may change the row, and only when
  `principal.tenantId` equals the request's tenant: a principal never acts in
  another tenant (`NotificationOptOutDeniedError`, reason `principal` or
  `tenant`). Without a principal the call is trusted host code that
  authenticated the recipient itself (e.g. a signed unsubscribe link, or a host
  route whose member belongs to a child tenant of the delivery tenant).
- `isOptedOut({ tenantId, recipientUserId, channel, scope })` is the trusted
  suppression read, under `withTenant`; a `*` row matches every scope.
- `listForRecipient({ tenantId, recipientUserId, principal })` returns only the
  recipient's own active opt-outs; any other principal is denied.

```ts
const optOuts = new NotificationOptOutService({ db });
new NotificationOutboxService({
  // ...
  // `scopeOf` maps the host's own event to a scope; null = not opt-out-able.
  // A question's sourceRef names the question, not its project, so the host
  // resolves the project itself (scopeOf may be async).
  isSuppressed: optOutSuppression(optOuts, async (request) => {
    const projectId = await projectIdForSourceRef(request.tenantId, request.sourceRef);
    return projectId ? `project:${projectId}` : null;
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

## Protected canonical Message handoff

`capabilities.protectedCanonicalSend` advertises the canonical-send guard in
addition to `requiredPolicy`. A protected delivery's single canonical Email has
a durable `metadata.__smrtProtectedOutbox` marker, backed by the delivery's
`messageId`. The marker is not authorization. Protected rows cannot clear or
change their marker, correlation, original identity, body, sender/recipients,
cc/bcc, HTML, raw content or headers through ordinary saves. Constructor-captured
original identity plus persisted old-row inspection also protect a loaded object
whose public id/correlation/metadata fields were changed and clones retaining
protected provenance. Ordinary model/collection deletion retains that evidence.
An existing protected canonical row receives the marker before dispatch; this is
non-authorizing migration of metadata, not permission to send.

Direct `Message.send`, `retrySend`, and default `EmailSender.send` refuse protected
mail without the outbox's private, exact, one-use handoff scope. The scope is
created only after the trusted named policy resolves/authorizes actual bytes.
It binds tenant, delivery, canonical message, lease, attempt/state version,
approved content/destinations and attachment names/types/IDs/dispositions/digests.
No capability mint is exported from the package root. Custom trusted transports
receive bytes only after a fresh durable lease check. The canonical sender and
actual default EmailClient boundary repeat that check after attachment I/O;
effective account-default sender and all destinations/body parts must match.
Send-time attachment buffers are privately copied before the SDK receives them.

Concurrent/reentrant second calls and detached tasks using an inherited async
context fail closed: scope state is deactivated when its transport callback
returns. A local guard denial is a definite pre-provider refusal, not an unknown
acceptance. Protected lifecycle/unknown-outcome metadata cannot be rewritten by
ordinary saves to make reconciliation mistake a prior uncertain handoff for a
safe retry. Existing unknown outcomes retain the normal reconciliation barrier.
Ordinary unprotected messages, including unsaved direct-sender drafts, retain
their existing contract.

The trusted-provider boundary is explicit: these guards constrain public package
Message/EmailSender and outbox paths. Arbitrary trusted server code calling a
provider SDK outside this package, or a custom transport deliberately sending
through its own SDK, remains responsible for that code's authority and behavior.

## Typed external contacts

Protected email also accepts exactly one `recipientProfileId` instead of a User. See [profile recipients](profile-recipients.md) for reserved profile policy identity, current Profile/host relationship checks, explicit schema plan/apply prerequisites and compatibility evidence. No auth account is fabricated.

## Browser/server boundary (#4747)

Protected notifications add no Node-only imports to the browser graph. Existing
package/dependency browser-capability declarations still apply. Protected canonical
handoff and schema maintenance require the server host: private SHA-256, strict
binding comparison, async-local scope, Core migration rebuild operations and
public Profile lookup/normalization live behind stable package
`host.js` / `host.browser.js` entries, following Core's
existing browser-map pattern. The browser counterpart never mints or inherits
handoff authority and throws before protected operations or maintenance; it does
not install a global context, skip durable guards or approximate hashing. Public
server APIs and canonical persisted association/lease/one-use checks are unchanged.
The owning dist browser bundle gate must remain green without a ratchet waiver.

## Blocked-prefix liveness and final-write protection

The dispatch limit bounds acquired leases, rather than blocked diagnostics.
Discovery walks bounded pages ordered by physical due/lease timestamp and UUID,
recovering expired leases before pending rows. Its cursor captures timestamp text
in the database before hydration, preserving PostgreSQL microseconds. A blocked
policy or Profile cannot repeatedly fill the first page and starve eligible mail
in its own tenant or another authorized scope. Explicit delivery selectors and
pre-discovery tenant authorization apply to every page. Repeated identical
blocked errors do not rewrite the row; no backoff, cancellation or lease is added,
so a currently authorized configured host can deliver immediately.

Public delivery saves bind their checked snapshot through Core's mandatory
`CollectionInterceptor.writeGuard` at the final persistence operation. An ordinary
save cannot adopt a protected natural identity inserted after its initial lookup.
Protected saves bind tenant, typed recipient, source, policy/binding, content and
lifecycle version/transition; a concurrent transition wins without being undone.
The private per-instance snapshot exists only during the save, and concurrent
saves of one instance are refused. Existing revision/sync options, ordinary
natural-key upsert and identical protected clones keep their normal contracts.
SQLite uses Core's existing serialized compare/write; PostgreSQL places the
mandatory predicate on its final UPDATE. No runtime schema or provider changes.
