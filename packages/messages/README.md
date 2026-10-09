# @happyvertical/smrt-messages

Unified multi-channel messaging with persona routes, encrypted credentials, and
provider adapters. Outbound delivery supports email, Zulip, and Telegram; SMS is
a reserved channel ready for a provider adapter.

## Installation

```bash
pnpm add @happyvertical/smrt-messages
```

## Usage

```typescript
import {
  Email, EmailCollection,
  EmailAccount, EmailAccountCollection,
  EmailSender,
  MessageCollection,
} from '@happyvertical/smrt-messages';

// Create an email account with encrypted credentials
const accounts = await EmailAccountCollection.create({ db });
const account = await accounts.create({
  name: 'Support',
  providerType: 'smtp',
});
await account.setCredentials({
  host: 'smtp.example.com',
  user: 'support@example.com',
  pass: process.env.SMTP_PASSWORD,
});

// Send an email through the send lifecycle
const emails = await EmailCollection.create({ db });
const email = await emails.create({
  accountId: account.id,
  subject: 'Welcome',
  toAddresses: JSON.stringify([{ address: 'user@example.com' }]),
  textBody: 'Thanks for signing up!',
});
const result = await email.send();
// sendStatus transitions: draft -> sending -> sent (or failed)

// Retry a failed message (respects maxRetries budget)
if (!result.success) {
  await email.retrySend();
}

// Query messages across all channels via base collection
const messages = await MessageCollection.create({ db });
const recent = await messages.list({ orderBy: 'createdAt DESC', limit: 20 });
```

## API

### Models (STI Hierarchy)

Messages and accounts each use single-table inheritance. STI discriminators use qualified names (e.g., `@happyvertical/smrt-messages:Email`).

| Export | Description |
|--------|------------|
| `Message` | Base message with send lifecycle (draft/sending/sent/failed) |
| `Email` | Email with RFC 822 threading, cc/bcc, htmlBody/textBody, folders |
| `SlackMessage` | Slack message with channelId, slackTs, reactions, blocks |
| `Tweet` | Twitter message with tweetId, retweetCount, likeCount, hashtags |
| `Account` | Base account with `setCredentials()`/`getCredentials()` via smrt-secrets |
| `EmailAccount` | Email account (SMTP/IMAP provider) |
| `SlackAccount` | Slack workspace account |
| `TwitterAccount` | Twitter API account |
| `Attachment` | Message attachment |
| `EmailAttachment` | Email-specific attachment |
| `EmailFolder` | Email folder/label |

### Collections

`MessageCollection`, `EmailCollection`, `AccountCollection`, `EmailAccountCollection`, `AttachmentCollection`, `EmailAttachmentCollection`, `EmailFolderCollection`

### Senders

Each channel has a dedicated sender implementing `MessageSenderInterface`.

| Export | Description |
|--------|------------|
| `EmailSender` | Send emails via `@happyvertical/email` client |
| `SlackSender` | Send Slack messages via API |
| `TweetSender` | Post tweets via Twitter API |
| `ZulipSender` | Send stream or private Zulip messages via bot credentials |
| `TelegramSender` | Send Telegram bot messages to a chat/topic |

### Persona-scoped outbound messaging

`MessagingSettingsService` is the permission-gated server boundary for saving
accounts, write-only credentials, destinations, and persona routes.
`PersonaMessagingService` selects the highest-priority matching route, persists
the message, then runs the normal send lifecycle.

Schema changes are manifest-driven. After upgrading an application, run
`smrt db:diff` and `smrt db:migrate` to add the account/message columns and the
`messaging_endpoints` / `persona_message_routes` tables.

When constructing `MessagingSettingsService`, provide
`resolvePersonaTenantId(personaId)` from the host's persona collection. Route
writes fail closed unless it proves the persona belongs to the same tenant.

```typescript
import {
  messagingPrincipalFromPermissions,
  PersonaMessagingService,
} from '@happyvertical/smrt-messages';

const messaging = new PersonaMessagingService({
  db,
  tenantId,
  principal: messagingPrincipalFromPermissions(['messages.send'], { tenantId }),
});

await messaging.send({
  personaId,
  channel: 'telegram', // optional; default route otherwise
  body: 'The scheduled report is ready.',
});
```

Agents receive the persona-fixed tool from `@happyvertical/smrt-personas`:

```typescript
const tool = createPersonaMessagingTool({ db, tenantId, personaId });
```

The tool only accepts message content and route intent. Persona, account,
endpoint, and credential ids remain trusted server state.

Apps can render `MessagingSettingsPanel` from
`@happyvertical/smrt-messages/svelte` using the sanitized view returned by
`MessagingSettingsService.list()` and wiring its save callbacks back to the
service.

### In-app notifications

`UserNotification` stores one notification per person with read state;
`UserNotificationService` creates, lists, and updates them for one recipient.

```typescript
import { UserNotificationService } from '@happyvertical/smrt-messages';

const notifications = new UserNotificationService({ db });

// Idempotent per (tenant, recipient, sourceRef).
await notifications.notify({
  tenantId,
  recipientUserId: post.createdByUserId,
  kind: 'social-post.failed',
  title: "A post to X didn't go out",
  href: `/sites/${slug}/social-posts`,
  severity: 'error',
  sourceRef: `social-post:${post.id}:failed`,
});

const items = await notifications.listForUser(userId, { tenantIds });
const unread = await notifications.countUnread(userId, { tenantIds });
await notifications.markRead(userId, [id], { tenantId });
await notifications.dismiss(userId, [id], { tenantId });
await notifications.markAllRead(userId, { tenantIds });
```

The generated REST/MCP/CLI surfaces are off; expose host routes that pass the
signed-in user's id. The table is new: run `db:migrate`.

### Credential Security

Account credentials are stored via `credentialSecretId` pointing to smrt-secrets envelope encryption. Use `account.setCredentials()` and `account.getCredentials()` -- never store passwords as plain fields.

### Key Types

`MessageType`, `ProviderType`, `SendStatus`, `SendMessageOptions`, `SendEmailOptions`, `SendSlackOptions`, `SendTweetOptions`, `MessageSendResult`, `MessageSenderInterface`, `SyncOptions`, `SyncResult`, `SyncProgress`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-secrets` -- credential encryption (envelope encryption)
- `@happyvertical/smrt-tenancy` -- optional multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/email` -- SMTP/IMAP email client
- Peer: `@happyvertical/smrt-svelte` (optional)

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.

### Notification bell and mailbox recipes

`Messages` exports `NotificationsRecipe` (`messages.notifications`) and `MailboxRecipe`
(`messages.mailbox`). The mailbox playground offers an interactive fictional inbox;
its compose action reports a mock send and never calls a mail transport.

For a server-rendered authorized host, construct `createUserNotificationBellProvider`
from `@happyvertical/smrt-messages/svelte` with a `UserNotificationService`, the signed-in
`userId`, and the authorized `tenantIds`. Pass that provider to `NotificationBell`
from `@happyvertical/smrt-svelte/notifications`. Browser hosts implement the same
provider interface over authenticated server endpoints; never send database services
to a browser. Replace the provider when the user or tenant context changes. Optional
`subscribe` connects a host-owned transport; the UI unsubscribes on disposal.

The Messaging feature card offers mailbox and notification controls independently.
Mailbox navigation includes a stable Drafts entry filtered by `sendStatus = draft`.
Notifications deliberately declare no generic model navigation: recipient-scoped
provider access remains required.
