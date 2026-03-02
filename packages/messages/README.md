# @happyvertical/smrt-messages

Unified multi-channel messaging with STI-based channel hierarchies for the SMRT framework. Supports email, Slack, and Twitter as message subtypes, with per-channel sender implementations and encrypted credential storage.

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
const accounts = new EmailAccountCollection(db);
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
const emails = new EmailCollection(db);
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
const messages = new MessageCollection(db);
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
