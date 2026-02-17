/**
 * @happyvertical/smrt-messages
 *
 * Unified multi-channel messaging with STI-based hierarchies
 *
 * @packageDocumentation
 */

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
