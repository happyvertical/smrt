# @happyvertical/smrt-messages

Unified multi-channel messaging with STI-based hierarchies. Supports email, Slack, Twitter/X, and extensible to any message channel. Stores message metadata, attachments, account configurations, and folder structures with credential management via smrt-secrets.

## Architecture

```
src/
  index.ts                    # Export barrel (base classes, email, providers, types)
  types.ts                    # All option interfaces, search filters, sync types
  ui.ts                       # ModuleUISlot declarations for registry
  models/
    Message.ts                # STI base: common message fields
    Account.ts                # STI base: common account fields
    Attachment.ts             # Generalized attachment (messageId)
    Email.ts                  # Email extending Message (RFC 822)
    EmailAccount.ts           # Email account extending Account
    EmailFolder.ts            # IMAP folder hierarchy
    EmailAttachment.ts        # Deprecated: re-exports from Attachment
    Tweet.ts                  # Twitter/X message extending Message
    SlackMessage.ts           # Slack message extending Message
    SlackAccount.ts           # Slack workspace extending Account
    TwitterAccount.ts         # Twitter account extending Account
  collections/
    MessageCollection.ts      # Polymorphic cross-type message queries
    AccountCollection.ts      # Polymorphic cross-type account queries
    AttachmentCollection.ts   # Generalized attachment queries (messageId)
    EmailCollection.ts        # Email-specific queries (extends MessageCollection)
    EmailAccountCollection.ts # Email account queries (extends AccountCollection)
    EmailFolderCollection.ts  # Folder hierarchy queries
    EmailAttachmentCollection.ts  # Deprecated: extends AttachmentCollection
  svelte/
    index.ts                  # Component barrel + ModuleUIRegistry auto-registration
    types.ts                  # UI-specific data interfaces (decoupled from ORM)
    components/
      MessageCard.svelte      # Message row with type-adaptive rendering
      MessageList.svelte      # Unified message list with selection
      MessageDetail.svelte    # Full message view with type-specific sections
      MessageFilters.svelte   # Search + filter/sort controls bar
      MessageToolbar.svelte   # Bulk action toolbar
      MessageTypeBadge.svelte # Type icon badge (email/tweet/slack)
      MessageStatusIndicator.svelte  # Read/flag/attachment indicators
      ThreadView.svelte       # Collapsible conversation thread
      AccountCard.svelte      # Account info with sync/activate/remove actions
      AccountList.svelte      # Grid of AccountCards
      AccountAvatar.svelte    # Provider icon with initials fallback
      FolderNav.svelte        # Folder navigation sidebar with unread badges
      AttachmentChip.svelte   # File chip with icon, name, size
```

## STI Class Hierarchy

The package uses Single Table Inheritance (STI) for both messages and accounts:

```
Message (@smrt({ tableStrategy: 'sti' }))
├── Email          — RFC 822 compliant email messages
├── Tweet          — Twitter/X posts with engagement metrics
└── SlackMessage   — Slack channel messages with reactions

Account (@smrt({ tableStrategy: 'sti' }))
├── EmailAccount     — IMAP/SMTP/POP3/Gmail accounts
├── SlackAccount     — Slack workspace connections
└── TwitterAccount   — Twitter/X API connections

Attachment (standalone, not STI)
└── EmailAttachment  — Deprecated wrapper, use Attachment directly
```

All subclasses share tables with their base class (`messages` table, `accounts` table) using the `_meta_type` discriminator column. Querying the base collection returns polymorphic results; querying a subclass collection returns only that type.

## Key Models

### Message (base)

Common fields for all message types:

| Field | Type | Description |
|-------|------|-------------|
| `tenantId` | `string \| null` | Optional tenant scoping |
| `accountId` | `string` | Owning account reference |
| `threadId` | `string` | Thread/conversation grouping |
| `subject` | `string` | Message subject line |
| `body` | `string` | Normalized plain text content |
| `fromAddress` | `string` | Sender address/handle |
| `fromName` | `string` | Sender display name |
| `toAddresses` | `string` | JSON array of `{address, name}` |
| `date` | `Date \| null` | Message timestamp |
| `isRead` | `boolean` | Read status |
| `isFlagged` | `boolean` | Flag/star status |
| `hasAttachments` | `boolean` | Attachment indicator |
| `size` | `number` | Message size in bytes |
| `metadata` | `string` | JSON extension bag for custom data |

Helper methods: `getToAddresses()`, `setToAddresses()`, `getMetadata()`, `setMetadata()`, `markRead()`, `markUnread()`, `toggleFlagged()`, `isUnread()`, `getPreview()`, `getAccount()`, `getThreadMessages()`, `getAttachments()`

### Email (extends Message)

Email-specific fields beyond Message: `messageId` (RFC 822), `inReplyTo`, `ccAddresses`, `bccAddresses`, `replyToAddress`, `replyToName`, `textBody`, `htmlBody`, `folderId`, `folderPath`, `labels`, `flags`, `isAnswered`, `isDraft`, `rawMessage`, `headers`

Constructor auto-populates `body` from `textBody` for unified cross-type access.

Helper methods: `getCcAddresses()`, `getBccAddresses()`, `getLabels()`, `setLabels()`, `getFlags()`, `setFlags()`, `getHeaders()`, `setHeaders()`, `getFolder()`, `getThreadEmails()`, overridden `getPreview()` (prefers textBody, strips HTML fallback), overridden `getAccount()` (returns typed EmailAccount)

### Tweet (extends Message)

Tweet-specific fields: `tweetId`, `retweetCount`, `likeCount`, `replyCount`, `isRetweet`, `isReply`, `mediaUrls` (JSON), `hashtags` (JSON), `mentions` (JSON)

Helper methods: `getMediaUrls()`, `getHashtags()`, `getMentions()`, `getEngagement()` (sum of retweet+like+reply)

### SlackMessage (extends Message)

Slack-specific fields: `channelId`, `channelName`, `slackTs`, `slackThreadTs`, `reactions` (JSON), `isEdited`, `messageType`, `blocks` (JSON)

Helper methods: `getReactions()`, `getBlocks()`, `isInThread()`, `getTotalReactions()`

### Account (base)

Common fields: `tenantId`, `name`, `providerType`, `credentialSecretId`, `isActive`, `lastSyncAt`, `settings` (JSON)

Helper methods: `getSettings()`, `setSettings()`, `activate()`, `deactivate()`, `setCredentials()` (stores via smrt-secrets), `getCredentials()` (retrieves from smrt-secrets, fallback to settings)

### EmailAccount (extends Account)

Email-specific fields: `email`, `syncIntervalMinutes`

Additional methods: `createClient()`, `syncFrom()`, `getFolders()`, `getEmails()`, `getUnreadCount()`, overridden `setCredentials()` with email-specific secret naming

### Attachment

Generalized for any message type (uses `messageId` instead of the old `emailId`):

Fields: `tenantId`, `messageId`, `filename`, `contentType`, `size`, `contentId`, `contentDisposition`, `filePath`, `sourceUrl`

Helper methods: `getMessage()`, `isImage()`, `isPdf()`, `isInline()`, `getExtension()`, `getFormattedSize()`, `hasExternalFile()`, `readContent()`

## Collections

### MessageCollection (polymorphic)

Returns mixed message types when queried. Methods:
- `search(query, filters?)` — Full-text search with `MessageSearchFilters`
- `getByAccounts(accountIds)` — Messages across multiple accounts
- `getByType(messageType)` — Filter by STI `_meta_type`
- `getUnread(accountId?)` — Unread messages
- `getFlagged(accountId?)` — Flagged messages
- `getRecent(limit, accountId?)` — Most recent messages
- `getByThread(threadId)` — Thread conversation
- `markAllRead(messageIds)` — Batch mark as read
- `getAccountStats(accountId)` — Stats with `byType` breakdown
- `findByTenant()`, `findGlobal()`, `findWithGlobals()` — Tenant helpers

### EmailCollection (extends MessageCollection)

Auto-filters to Email instances via STI. Additional methods:
- `getByMessageId(accountId, messageId)` — RFC 822 Message-ID lookup
- `getByAccount(accountId)`, `getByFolder(folderId)` — Email-specific queries
- `getWithAttachments(accountId?)` — Emails with attachments
- `countByFolder(folderId)`, `countUnreadByFolder(folderId)`, `countUnreadByAccount(accountId)`
- `searchEmails(query, filters?)` — Email-specific search with `EmailSearchFilters`
- `markFolderRead(folderId)`, `deleteByFolder(folderId)` — Batch operations

### AccountCollection (polymorphic)

Returns mixed account types. Methods:
- `getActive()`, `getInactive()` — Filter by active status
- `getByProviderType(type)` — Filter by provider
- `getByType(accountType)` — Filter by STI type
- `search(query, filters?)` — Search with `AccountSearchFilters`
- `getStats()` — Stats with `byType` breakdown

### AttachmentCollection

Generalized with `messageId`. Methods:
- `getByMessage(messageId)` — All attachments for a message
- `getByContentType(contentType)` — Filter by MIME type
- `getImages()`, `getPdfs()`, `getInline()`, `getRegular()` — Type helpers
- `getWithExternalFiles()` — Attachments stored on disk
- `getTotalSize(messageId)`, `getLargest(messageId)` — Size queries
- `searchByFilename(query)`, `getByExtension(ext)` — Filename queries
- `getStats(messageId)` — Attachment statistics
- `deleteByMessage(messageId)` — Batch delete

## Export Subpaths

| Import Path | Contents |
|-------------|----------|
| `@happyvertical/smrt-messages` | All models, collections, and types |
| `@happyvertical/smrt-messages/svelte` | Svelte 5 UI components (optional) |
| `@happyvertical/smrt-messages/ui` | `MESSAGES_UI_SLOTS`, `MESSAGES_MODULE_META` |
| `@happyvertical/smrt-messages/manifest` | Generated manifest.json |

## Svelte Components

### Installation

The Svelte components require optional peer dependencies:

```bash
# Components are optional — install peers only if using the /svelte subpath
pnpm add svelte @happyvertical/smrt-svelte
```

### Usage

```typescript
import {
  MessageCard,
  MessageList,
  MessageDetail,
  MessageFilters,
  MessageToolbar,
  ThreadView,
  AccountCard,
  AccountList,
  AccountAvatar,
  FolderNav,
  AttachmentChip,
  MessageTypeBadge,
  MessageStatusIndicator,
} from '@happyvertical/smrt-messages/svelte';
```

### Component Reference

#### Atoms

| Component | Key Props | Purpose |
|-----------|-----------|---------|
| `MessageTypeBadge` | `type`, `size?` | Icon + label badge for email/tweet/slack |
| `MessageStatusIndicator` | `isRead`, `isFlagged`, `hasAttachments`, `isAnswered?`, `isDraft?` | Status icon row |
| `AccountAvatar` | `providerType`, `name`, `size?` | Provider icon with fallback initials |
| `AttachmentChip` | `attachment`, `onclick?` | File chip: icon + name + size |

#### Composites

| Component | Key Props | Purpose |
|-----------|-----------|---------|
| `MessageCard` | `message`, `selected?`, `compact?`, `showAccount?`, `showType?`, `onclick?`, `onselect?`, `onflag?`, `typeContent?` (snippet) | Single message row, type-adaptive |
| `MessageList` | `messages`, `selected?` (Set), `activeMessageId?`, `accounts?`, `loading?`, `emptyMessage?`, `onmessageclick?`, `card?` (snippet) | Message list with selection |
| `MessageDetail` | `message`, `attachments?`, `account?`, `showHtml?`, `onreply?`, `onforward?`, `ondelete?`, `typeDetail?` (snippet) | Full message view |
| `MessageFilters` | `filters?`, `sort?`, `accounts?`, `availableTypes?`, `onfilterchange?`, `onsearch?` | Filter/sort controls bar |
| `MessageToolbar` | `selectedCount`, `totalCount`, `onaction?`, `onselectall?`, `onclearselection?`, `extraActions?` (snippet) | Bulk action toolbar |
| `ThreadView` | `messages`, `activeMessageId?`, `collapsed?` (Set), `onmessageclick?`, `onreply?` | Collapsible conversation thread |
| `AccountCard` | `account`, `onsync?`, `onactivate?`, `ondeactivate?`, `onremove?` | Individual account card |
| `AccountList` | `accounts`, `loading?`, `onaccountclick?`, `onsync?`, `onremove?` | Grid of AccountCards |
| `FolderNav` | `folders`, `activeFolderId?`, `showCounts?`, `onfolderclick?` | Folder sidebar with unread badges |

### Type-Specific Rendering

`MessageCard` and `MessageDetail` use `$derived.by()` to switch rendering per message type:
- **Email**: To/CC recipients, folder path
- **Tweet**: Retweet/like/reply counts from `meta`
- **Slack**: Channel name, reactions from `meta`
- **Other**: Generic sender/body display

Override via `typeContent` snippet on `MessageCard` or `typeDetail` snippet on `MessageDetail`.

### UI Data Types

The Svelte components use their own data interfaces (`src/svelte/types.ts`), decoupled from the ORM models:

```typescript
import type {
  MessageData,       // id, type, subject, body, senderName, recipientAddresses, ...
  AccountData,       // id, name, email?, providerType, isActive, ...
  FolderData,        // id, name, path, specialUse?, messageCount, unreadCount
  AttachmentData,    // id, filename, contentType, size
  MessageFilterState, // type?, accountId?, isRead?, search?, ...
  MessageSort,       // field ('date'|'sender'|'subject'|'type'), direction
  BulkAction,        // 'markRead' | 'markUnread' | 'flag' | 'unflag' | 'delete' | 'archive'
} from '@happyvertical/smrt-messages/svelte';
```

### Auto-Registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-messages/svelte'; // Auto-registers all components

// Later, retrieve from registry
import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
const MessageCard = ModuleUIRegistry.get('@happyvertical/smrt-messages', 'message-card');
```

Registered slots: `message-card`, `message-list`, `message-detail`, `message-filters`, `account-list`, `thread-view`

### Styling

All components use `--smrt-*` MD3 design tokens from `@happyvertical/smrt-svelte`. CSS is scoped per component. Key token prefixes:
- `--smrt-color-*` — Surface, primary, error, outline colors
- `--smrt-typography-*` — Font stacks (body, label, title)
- `--smrt-radius-*` — Border radii
- `--smrt-duration-*`, `--smrt-easing-*` — Transitions

## Key Patterns

- **Credential security**: Uses `credentialSecretId` reference to `@happyvertical/smrt-secrets` (never stores passwords directly). `Account.setCredentials()` and `Account.getCredentials()` handle the integration.
- **Thread tracking**: Messages linked via `threadId` for conversation view across all types
- **Sync tracking**: Last sync timestamps on Account for incremental sync
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped({ mode: 'optional' })` on Message, Account, and Attachment
- **Polymorphic queries**: `MessageCollection.list({})` returns mixed Email/Tweet/SlackMessage instances with correct subclass methods
- **JSON field pattern**: Fields like `toAddresses`, `metadata`, `reactions`, `hashtags` store JSON strings with paired `getX()`/`setX()` helper methods that handle parse errors gracefully

## Backward Compatibility

All existing email imports continue to work unchanged:

```typescript
// These all still work exactly as before
import { Email, EmailAccount, EmailFolder, EmailAttachment } from '@happyvertical/smrt-messages';
import { EmailCollection, EmailAccountCollection, EmailFolderCollection } from '@happyvertical/smrt-messages';
```

- `Email` extends `Message` — inherits common fields, keeps all email-specific fields
- `EmailAccount` extends `Account` — inherits common fields, keeps sync methods
- `EmailAttachment` extends `Attachment` — provides `emailId` getter/setter mapped to `messageId`
- `EmailCollection` extends `MessageCollection` — adds email-specific query methods
- `EmailAccountCollection` extends `AccountCollection` — adds sync methods
- `EmailFolder` and `EmailFolderCollection` are unchanged (not part of STI hierarchy)

## Dependencies

**Required:**
- `@happyvertical/smrt-core`, `@happyvertical/smrt-types`, `@happyvertical/smrt-tenancy`, `@happyvertical/smrt-secrets`
- `@happyvertical/ai`, `@happyvertical/email`, `@happyvertical/files`, `@happyvertical/sql`

**Optional peers (for Svelte components):**
- `svelte` (^5.18.0)
- `@happyvertical/smrt-svelte` (workspace)
- `@happyvertical/encryption` (for credential encryption)

## Testing

```bash
npx vitest run                    # Run all tests
npx vitest run --reporter=verbose # Verbose output
```

Test files:
- `__tests__/message-sti.test.ts` — Message STI discriminators, save/load, inheritance chains (23 tests)
- `__tests__/account-sti.test.ts` — Account STI discriminators, save/load, inheritance chains (18 tests)
- `__tests__/models.test.ts` — Unit tests for all model helper methods (38 tests)
- `__tests__/email-account-secrets.test.ts` — EmailAccount secrets integration (skipped, see #717)

## Adding New Message Types

To add a new message channel (e.g., Discord):

1. Create `src/models/DiscordMessage.ts` extending `Message`:
   ```typescript
   @smrt({ tableStrategy: 'sti', api: { include: ['list', 'get', 'create'] }, cli: true })
   export class DiscordMessage extends Message {
     serverId = '';
     channelId = '';
     // ... discord-specific fields
   }
   ```

2. Create `src/models/DiscordAccount.ts` extending `Account` (if needed)

3. Add option interfaces to `src/types.ts`:
   ```typescript
   export interface DiscordMessageOptions extends MessageOptions {
     serverId?: string;
     channelId?: string;
   }
   ```

4. Add exports to `src/index.ts`

5. The STI framework handles table sharing, polymorphic queries, and `_meta_type` discrimination automatically. No migration needed for the new columns — SMRT stores unknown fields in `_meta_data`.

## Migration Notes

When migrating from the email-only version:

- Table renames: `emails` → `messages`, `email_accounts` → `accounts`, `email_attachments` → `attachments`
- New columns: `body`, `metadata` on `messages`; `_meta_type` discriminator on both tables
- Column rename: `email_id` → `message_id` on attachments
- Backfill `_meta_type` as `'@happyvertical/smrt-messages:Email'` for existing email rows
- Existing email-specific columns remain as-is (SMRT tolerates both column and `_meta_data` storage)
