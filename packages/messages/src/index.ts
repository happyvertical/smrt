/**
 * @happyvertical/smrt-messages
 *
 * Unified multi-channel messaging with STI-based hierarchies
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__';

// ─────────────────────────────────────────────────────────────────────────
// Base classes (new)
// ─────────────────────────────────────────────────────────────────────────

export { AccountCollection } from './collections/AccountCollection';
export { AttachmentCollection } from './collections/AttachmentCollection';
// Base collections
export { MessageCollection } from './collections/MessageCollection';
export { Account } from './models/Account';
export { Attachment } from './models/Attachment';
// Base models
export { Message } from './models/Message';

// ─────────────────────────────────────────────────────────────────────────
// Email (backward-compatible)
// ─────────────────────────────────────────────────────────────────────────

export { EmailAccountCollection } from './collections/EmailAccountCollection';
export { EmailAttachmentCollection } from './collections/EmailAttachmentCollection';
// Email collections
export { EmailCollection } from './collections/EmailCollection';
export { EmailFolderCollection } from './collections/EmailFolderCollection';
// Email models
export { Email } from './models/Email';
export { EmailAccount } from './models/EmailAccount';
export { EmailAttachment } from './models/EmailAttachment';
export { EmailFolder } from './models/EmailFolder';

// ─────────────────────────────────────────────────────────────────────────
// Email filtering (whitelist/blacklist)
// ─────────────────────────────────────────────────────────────────────────

export { BlacklistCollection } from './collections/BlacklistCollection';
export { WhitelistCollection } from './collections/WhitelistCollection';
export { Blacklist } from './models/Blacklist';
export { Whitelist } from './models/Whitelist';

// ─────────────────────────────────────────────────────────────────────────
// Provider stubs
// ─────────────────────────────────────────────────────────────────────────

// Account types
export { SlackAccount } from './models/SlackAccount';
export { SlackMessage } from './models/SlackMessage';
// Message types
export { Tweet } from './models/Tweet';
export { TwitterAccount } from './models/TwitterAccount';

// ─────────────────────────────────────────────────────────────────────────
// Senders
// ─────────────────────────────────────────────────────────────────────────

export { EmailSender } from './senders/EmailSender';
export { SlackSender } from './senders/SlackSender';
export { TweetSender } from './senders/TweetSender';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type {
  AccountOptions,
  AccountSearchFilters,
  AccountType,
  AttachmentOptions,
  // Email options (backward compat)
  EmailAccountOptions,
  EmailAccountSearchFilters,
  EmailAttachmentOptions,
  EmailFolderOptions,
  EmailFolderSearchFilters,
  EmailOptions,
  EmailSearchFilters,
  // Base options
  MessageOptions,
  // Search filters
  MessageSearchFilters,
  MessageSenderInterface,
  // Send types
  MessageSendResult,
  // Discriminator types
  MessageType,
  ProviderType,
  SendEmailOptions,
  SendMessageOptions,
  SendSlackOptions,
  SendStatus,
  SendTweetOptions,
  SlackAccountOptions,
  SlackMessageOptions,
  // Sync types
  SyncOptions,
  SyncProgress,
  SyncResult,
  // Provider options
  TweetOptions,
  TwitterAccountOptions,
} from './types';
