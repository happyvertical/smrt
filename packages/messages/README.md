# @happyvertical/smrt-messages

Unified multi-channel messaging with STI-based channel hierarchies for the SMRT framework. Supports email, Slack, and Twitter as message subtypes, with per-channel sender implementations and encrypted credential storage.

## Installation

```bash
pnpm add @happyvertical/smrt-messages
```

## Usage

```typescript
import {
  Message, MessageCollection,
  Email, EmailCollection,
  EmailSender, SlackSender, TweetSender,
  EmailAccount, EmailAccountCollection
} from '@happyvertical/smrt-messages';

// Create an email account
const accounts = new EmailAccountCollection(db);
const account = await accounts.create({
  name: 'Support',
  address: 'support@example.com',
  provider: 'smtp',
});
await account.save();

// Send an email
const sender = new EmailSender(account);
await sender.send({
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Thanks for signing up!',
});

// Query messages across channels
const messages = new MessageCollection(db);
const recent = await messages.list({
  orderBy: 'createdAt DESC',
  limit: 20,
});
```

## API

### Models (STI Hierarchy)

| Export | Description |
|--------|------------|
| `Message` | Base message (STI base) |
| `Email` | Email message (STI subclass) |
| `SlackMessage` | Slack message (STI subclass) |
| `Tweet` | Twitter message (STI subclass) |
| `Account` | Base messaging account (STI base) |
| `EmailAccount` | Email account (STI subclass) |
| `SlackAccount` | Slack account (STI subclass) |
| `TwitterAccount` | Twitter account (STI subclass) |
| `Attachment` | Message attachment |
| `EmailAttachment` | Email-specific attachment |
| `EmailFolder` | Email folder/label |

### Collections

`MessageCollection`, `EmailCollection`, `AccountCollection`, `EmailAccountCollection`, `AttachmentCollection`, `EmailAttachmentCollection`, `EmailFolderCollection`

### Senders

| Export | Description |
|--------|------------|
| `EmailSender` | Send emails via SMTP/API |
| `SlackSender` | Send Slack messages via API |
| `TweetSender` | Post tweets via Twitter API |

### Key Types

`MessageType`, `ProviderType`, `SendStatus`, `SendMessageOptions`, `SendEmailOptions`, `SendSlackOptions`, `SendTweetOptions`, `SyncOptions`, `SyncResult`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-secrets` — credential encryption
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-svelte`
