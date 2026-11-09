# @happyvertical/smrt-messages

Multi-channel messaging with STI hierarchies for both messages and accounts. Credential encryption via smrt-secrets.

## STI Hierarchies

**Messages** (share `messages` table):
- `Message` (base): accountId, personaId, endpointId, correlationId, threadId, subject, body, fromAddress, toAddresses (JSON), sendStatus (draft/sending/sent/failed), retryCount
- `Email`: messageId (RFC 822), inReplyTo, ccAddresses, bccAddresses, htmlBody, textBody, folderId, labels, headers
- `Tweet`: tweetId, retweetCount, likeCount, mediaUrls, hashtags, mentions
- `SlackMessage`: channelId, slackTs, slackThreadTs, reactions, blocks

**Accounts** (share `accounts` table):
- `Account` (base): channelType, providerType, public configuration,
  credentialSecretId, isActive, lastSyncAt, deprecated sensitive settings
- `EmailAccount`, `TwitterAccount`, `SlackAccount`, `ZulipAccount`,
  `TelegramAccount`: provider-specific identity/sender behavior

## Persona messaging

- `MessagingEndpoint`: tenant-owned, write-only destination JSON with masked
  display helper.
- `PersonaMessageRoute`: persona → account + endpoint, selected by purpose and
  descending priority.
- `PersonaMessagingService`: persists and sends through an enabled route.
- Provider registry: public setup descriptors + optional sender factory. Keep
  channel (`sms`) separate from provider (`twilio`).
- Permissions: `messages.send`, `messages.manage-routes`,
  `messages.manage-credentials`.
- `MessagingSettingsService` is the permissioned server boundary;
  its host-supplied `resolvePersonaTenantId` proves cross-package ownership.
  `MessagingSettingsPanel` is the callback-driven Svelte surface.
- Account, endpoint, and route generated surfaces are read-only. Do not add
  generated mutations around the settings service or make secret fields writable.
- **Recipe `messages.slack`** (`src/recipes.ts`, help in `src/help/slack.md`): lists Slack messages and workspaces beside the Mailbox and Notifications recipes; workspaces stay read-only and sending goes through the senders, not generated routes. Fields it shows carry `@field({ description })` in plain words; keep them when editing the models.

## In-app notifications (`UserNotification`)

The in-app channel: one stored row per person, with read state.
`user_notifications`: `tenantId` (required), `recipientUserId`
(`@crossPackageRef` smrt-users:User, uuid), `kind`, `title`, `body`, `href`,
`severity` (info/success/warning/error), `sourceRef`, `occurredAt`, `readAt`,
`dismissedAt`. Conflict identity `(tenant_id, recipient_user_id, source_ref)`.

- `UserNotificationService` is the only access path: `notify()` /
  `notifyMany()` (dedupe on `sourceRef`, existing row returned untouched;
  a unique ref is generated when omitted), `listForUser()` / `countUnread()`
  across explicit `tenantIds` (each read under `withTenant`), `markRead()`,
  `dismiss()` (also marks read), `markAllRead()`. Every write filters on the
  recipient, so another user's id matches nothing.
- Generated REST/MCP/CLI are off (`api`/`mcp`/`cli: false`): a tenant-scoped
  list would expose every member's rows. Hosts expose their own routes that
  pass the signed-in user's id, never a request-chosen one.
- Hosts decide who is told (e.g. `SocialPost.createdByUserId` for a failed
  post). New table: consumers run `db:migrate`.

## Notification email outbox (`NotificationDelivery`)

`NotificationOutboxService` is the external-channel counterpart of
`UserNotificationService`: `enqueueEmail()` stores one delivery per
`(tenant, recipient, channel, sourceRef)` after the host resolves the
recipient address and same-tenant sender account (callers never choose an
address); `dispatchDue()` leases due rows by compare-and-set
(`NotificationDelivery.transition()`), creates the single outbound `Email`
under the lease, and settles sent/retry/failed/uncertain. Never resend an
`uncertain` row automatically. Contract, retry, and reconciliation policy:
[agents/notification-outbox.md](agents/notification-outbox.md). New table:
consumers run `db:migrate`.

`NotificationOptOut` (`notification_opt_outs`, tenant-required, generated
surfaces off) is the per-recipient opt-out ledger for the outbox's
`isSuppressed` hook, keyed `(tenant, recipient, channel, scope)` with scope `*`
or `project:<uuid>`-style keys. `NotificationOptOutService`: idempotent
`optOut`/`optIn` (with a `principal` only `userId === recipientUserId` may
change a row, and only in the principal's own `tenantId`, else
`NotificationOptOutDeniedError`; no principal = trusted host code), trusted `isOptedOut` (a `*` row matches every scope), `listForRecipient`
(principal required). `optOutSuppression(service, scopeOf)` builds the
`isSuppressed` function. Details in the outbox doc; consumers run `db:migrate`.

## Credential Security

Account credentials stored via tenant-bound `credentialSecretId` →
smrt-secrets. Use `setCredentials()`/`getCredentials()` — never store passwords
directly. Credential descriptor schemas contain field definitions, never values.

## Send Lifecycle

`message.send()`: resolves account → creates provider sender → updates sendStatus. Retry support with `maxRetries` budget.
A failure the provider may still have accepted carries
`MessageSendResult.outcomeUnknown` (set by `EmailSender` unless
`isDefiniteSendRejection()` proves a refusal, and when a sender throws) and is
persisted as `metadata.sendOutcomeUnknown`; never auto-resend it.
`EmailSender` attaches the message's stored `Attachment` rows (read through
`Attachment.readContent()`, under the message's tenant context) plus
`SendEmailOptions.attachments` bytes; an unreadable or file-less row fails the
send with the error on `sendError`, never a silent drop (#3808).
`PersonaMessagingService.send({ attachments })` accepts them on email routes only.

## Provider entry points (bundle boundary, #1979)

The package root is provider-neutral: models, collections, services,
permissions, and the provider registry carry **zero provider-SDK weight**.
Provider SDK wrappers (`@happyvertical/email`, `@happyvertical/messages`) are
reachable only through explicit entry points, imported once at server startup:

```ts
import '@happyvertical/smrt-messages/providers/email';   // smtp/imap/pop3/gmail
import '@happyvertical/smrt-messages/providers/slack';
import '@happyvertical/smrt-messages/providers/twitter';
import '@happyvertical/smrt-messages/providers/all';     // all of the above
```

- Without the matching entry, `EmailAccount.createClient()` (send + mailbox
  sync) throws an actionable error and `SlackSender`/`TweetSender` return a
  failure result naming the entry to import. Telegram and Zulip are
  fetch-based and always work from the root.
- Builtin registry definitions stay metadata-only (setup fields for UIs); the
  entries upgrade them with `createEmailClient`/`createMessageClient`/
  `createSender` hooks. Never import a provider SDK from any module reachable
  from `src/index.ts` — the consumer bundle gate (`packages/bundle-gate`)
  fails CI when one becomes reachable.
- `Attachment.readContent()` loads `@happyvertical/files` through core's
  `importOptionalDependency` boundary and keeps its null-on-failure contract
  in builds where the SDK is absent.

## Gotchas

- **Manifest before decorators**: every decorated model imports
  `../__smrt-register__.js`, and `package.json#sideEffects` lists
  `./src/__smrt-register__.ts`. Without both, the library build dropped or
  reordered the self-registration, so dist classes registered with only their
  decorated fields and could adopt smrt-ledgers' same-named `Account` (#3098).
- **`Account` is not unique**: smrt-ledgers also declares `Account` (on
  `ledger_accounts`). Resolve by constructor or qualified name; the
  coexistence tests (`ledger-account-identity-*`, and the PostgreSQL lane
  `pnpm test:postgres`) load both packages in both orders.
  Both declare the `accounts` collection, so registering the ledgers `Account`
  auto-loads this family from its manifest as STI siblings. Core loads this
  base with them and never takes the ledgers `Account` for it (#4735,
  `ledger-account-identity-sti-siblings.test.ts`).
- **STI `_meta_type`**: qualified format `@happyvertical/smrt-messages:Email`
- **JSON fields**: all address/metadata fields are JSON strings with `getX()`/`setX()` helpers
- **RFC 822 threading**: Email uses `inReplyTo`/`messageId`/`references` — manual management required
- **Attachment.messageId**: use this field (not `emailId`); old getter/setter mapped via deprecation wrapper
- **Optional tenancy**: `@TenantScoped({ mode: 'optional' })` on Message, Account, Attachment
- **Required tenancy**: endpoints and persona routes are always tenant scoped
- **Secrets are write-only**: never serialize credentials or endpoint.address to an app

## Intake byte snapshots

`EmailAccount.readIntakeMessage(providerLookup, maxBytes, imapIdentity?)` is the authorized host seam for
opt-in ingestion. It copies full-message attachment bytes from the registered
email provider and fails when only attachment metadata is available; it never
reads provider-supplied paths or advances sync checkpoints. Keep this path
provider-neutral and exclude arbitrary headers/credentials from its snapshot.
IMAP lookup must include folder/UIDVALIDITY/UID verification; sender Message-ID
is a lookup hint, never the durable delivery identity.

Protected notification Emails carry durable delivery provenance. Their canonical
`send`/`retrySend`, ordinary save/delete, and default EmailSender handoff are
constrained by `protected-notification-handoff.ts` (package-private, never a root
export). Only the outbox enters its exact one-use scope after current trusted
policy/byte validation. Preserve old-row/constructor identity checks, current
persisted lease checks at the actual provider boundary, copied byte buffers and
unknown-outcome marker protection. See the outbox contract and shared protected
handoff suite (SQLite and migrated PostgreSQL).

## Protected external contacts

Profile email uses exclusive `recipientProfileId` plus `resolveProfileRecipient`, a reserved `profileNotificationPolicy` and exact current tenant-owned public Profile email. No User account is required. Before activating profiles, run normal framework schema migration and public `planNotificationProfileRecipients` / `migrateNotificationProfileRecipients`; runtime verifies physical constraints and never applies DDL. Legacy User notification and opt-out paths remain User-only. See [profile recipient contract and matrix](agents/profile-recipients.md).
