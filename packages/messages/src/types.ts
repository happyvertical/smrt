/**
 * Type definitions for @happyvertical/smrt-messages
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

export type KnownMessagingChannel =
  | 'email'
  | 'zulip'
  | 'telegram'
  | 'slack'
  | 'twitter'
  | 'sms';

/** Open-ended so downstream packages can add channels without changing SMRT. */
export type MessagingChannel = KnownMessagingChannel | (string & {});

// ─────────────────────────────────────────────────────────────────────────
// Send Status & Sender Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Status of a message in the send lifecycle
 */
export type SendStatus =
  | 'draft'
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'scheduled';

/**
 * Interface for channel-specific message senders
 */
export interface MessageSenderInterface {
  send(
    message: unknown,
    options?: SendMessageOptions,
  ): Promise<MessageSendResult>;
  isReady(): boolean;
  readonly providerType: string;
}

/**
 * Base send options
 */
export interface SendMessageOptions {
  trackSend?: boolean;
  retry?: { maxRetries?: number; backoffMs?: number };
  scheduledAt?: Date;
}

/**
 * Email-specific send options
 */
export interface SendEmailOptions extends SendMessageOptions {
  saveToCopy?: boolean;
  sentFolder?: string;
}

/**
 * Slack-specific send options
 */
export interface SendSlackOptions extends SendMessageOptions {
  unfurlLinks?: boolean;
  unfurlMedia?: boolean;
}

/**
 * Tweet-specific send options
 */
export interface SendTweetOptions extends SendMessageOptions {
  quoteTweetId?: string;
}

/**
 * Result of sending a message
 */
export interface MessageSendResult {
  success: boolean;
  providerMessageId?: string;
  accepted?: string[];
  rejected?: string[];
  error?: string;
  providerResponse?: Record<string, unknown>;
  sentAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider transport factories (#1979)
// ─────────────────────────────────────────────────────────────────────────
//
// Structural view of the SDK message clients used by senders. Kept structural
// (rather than typed against @happyvertical/messages) so the provider-neutral
// package surface carries no reference to the SDK wrappers whose roots import
// googleapis/nodemailer/@slack/web-api. Concrete factories are registered on
// MessagingProviderDefinition by the explicit provider entry points
// (`@happyvertical/smrt-messages/providers/*`).

/** Result shape returned by SDK message-client `send()` implementations. */
export interface MessagingTransportSendResult {
  success: boolean;
  messageId?: string;
  providerResponse?: Record<string, unknown>;
  timestamp?: Date;
}

/** Minimal structural contract of an SDK message client (Slack, Twitter, …). */
export interface MessagingTransportClient {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown>;
  send(
    message: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<MessagingTransportSendResult>;
}

/** Creates a connected-capable SDK message client for a provider config. */
export type MessageClientFactory = (
  config: { type: string } & Record<string, unknown>,
) => Promise<MessagingTransportClient>;

// ─────────────────────────────────────────────────────────────────────────
// Discriminator Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Known message types (STI discriminator values)
 */
export type MessageType = 'Message' | 'Email' | 'Tweet' | 'SlackMessage';

/**
 * Known account types (STI discriminator values)
 */
export type AccountType =
  | 'EmailAccount'
  | 'SlackAccount'
  | 'TwitterAccount'
  | 'TelegramAccount'
  | 'ZulipAccount';

/**
 * Email provider type
 */
export type ProviderType = 'smtp' | 'imap' | 'pop3' | 'gmail';

// ─────────────────────────────────────────────────────────────────────────
// Base Options
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for creating Message (base)
 */
export interface MessageOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  accountId?: string;
  personaId?: string | null;
  endpointId?: string | null;
  correlationId?: string;
  threadId?: string;
  subject?: string;
  body?: string;
  fromAddress?: string;
  fromName?: string;
  toAddresses?: string;
  date?: Date | null;
  isRead?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  size?: number;
  metadata?: string;
  createdAt?: Date;
  updatedAt?: Date;

  // Send fields
  sendStatus?: SendStatus;
  sentAt?: Date | null;
  sendError?: string;
  retryCount?: number;
  maxRetries?: number;
  scheduledSendAt?: Date | null;
  inReplyToMessageId?: string;
}

/**
 * Options for creating Account (base)
 */
export interface AccountOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  name?: string;
  providerType?: string;
  channelType?: MessagingChannel;
  credentialSecretId?: string | null;
  isActive?: boolean;
  lastSyncAt?: Date | null;
  settings?: string;
  configuration?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MessagingEndpointOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string;
  profileId?: string | null;
  label?: string;
  channel?: MessagingChannel;
  address?: string;
  isActive?: boolean;
  verifiedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PersonaMessageRouteOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string;
  personaId?: string;
  accountId?: string;
  endpointId?: string;
  purpose?: string;
  priority?: number;
  enabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface SendPersonaMessageOptions {
  personaId: string;
  body: string;
  subject?: string;
  channel?: MessagingChannel;
  purpose?: string;
  routeId?: string;
  correlationId?: string;
}

/**
 * Options for creating Attachment
 */
export interface AttachmentOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  messageId?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  contentId?: string;
  contentDisposition?: 'attachment' | 'inline';
  filePath?: string;
  sourceUrl?: string;
  createdAt?: Date;
}

// ─────────────────────────────────────────────────────────────────────────
// Email-Specific Options (backward compat)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for creating Email
 */
export interface EmailOptions extends MessageOptions {
  messageId?: string; // RFC 822 Message-ID
  inReplyTo?: string;
  ccAddresses?: string;
  bccAddresses?: string;
  replyToAddress?: string;
  replyToName?: string;
  textBody?: string;
  htmlBody?: string;
  folderId?: string;
  folderPath?: string;
  labels?: string;
  flags?: string;
  isAnswered?: boolean;
  isDraft?: boolean;
  rawMessage?: string;
  headers?: string;
}

/**
 * Options for creating EmailAccount
 */
export interface EmailAccountOptions extends AccountOptions {
  email?: string;
  providerType?: ProviderType;
  syncIntervalMinutes?: number;
}

/**
 * Options for creating EmailFolder
 */
export interface EmailFolderOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  accountId?: string;
  name?: string;
  path?: string;
  delimiter?: string;
  specialUse?: string;
  messageCount?: number;
  unreadCount?: number;
  subscribed?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating EmailAttachment
 * @deprecated Use AttachmentOptions instead
 */
export interface EmailAttachmentOptions extends AttachmentOptions {
  emailId?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Provider-Specific Options
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for creating Tweet
 */
export interface TweetOptions extends MessageOptions {
  tweetId?: string;
  retweetCount?: number;
  likeCount?: number;
  replyCount?: number;
  isRetweet?: boolean;
  isReply?: boolean;
  mediaUrls?: string;
  hashtags?: string;
  mentions?: string;
}

/**
 * Options for creating SlackMessage
 */
export interface SlackMessageOptions extends MessageOptions {
  channelId?: string;
  channelName?: string;
  slackTs?: string;
  slackThreadTs?: string;
  reactions?: string;
  isEdited?: boolean;
  messageType?: string;
  blocks?: string;
}

/**
 * Options for creating SlackAccount
 */
export interface SlackAccountOptions extends AccountOptions {
  workspaceId?: string;
  workspaceName?: string;
  botUserId?: string;
}

/**
 * Options for creating TwitterAccount
 */
export interface TwitterAccountOptions extends AccountOptions {
  handle?: string;
  twitterUserId?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Filter List Options
// ─────────────────────────────────────────────────────────────────────────

/**
 * Options for creating Blacklist
 */
export interface BlacklistOptions extends SmrtObjectOptions {
  pattern?: string;
  type?: 'email' | 'domain' | 'regex';
  reason?: string;
  autoArchive?: boolean;
}

/**
 * Options for creating Whitelist
 */
export interface WhitelistOptions extends SmrtObjectOptions {
  pattern?: string;
  type?: 'email' | 'domain' | 'regex';
  category?: string | null;
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Search Filters
// ─────────────────────────────────────────────────────────────────────────

/**
 * Search filters for messages (cross-type)
 */
export interface MessageSearchFilters {
  accountIds?: string[];
  messageType?: string;
  from?: string;
  to?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  sinceDate?: Date;
  beforeDate?: Date;
  query?: string;
}

/**
 * Search filters for accounts (cross-type)
 */
export interface AccountSearchFilters {
  providerType?: string;
  isActive?: boolean;
  accountType?: string;
}

/**
 * Search filters for emails
 */
export interface EmailSearchFilters {
  accountId?: string;
  folderId?: string;
  threadId?: string;
  from?: string;
  to?: string;
  subject?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  hasAttachments?: boolean;
  sincDate?: Date;
  beforeDate?: Date;
}

/**
 * Search filters for email accounts
 */
export interface EmailAccountSearchFilters {
  providerType?: ProviderType;
  email?: string;
  isActive?: boolean;
}

/**
 * Search filters for email folders
 */
export interface EmailFolderSearchFilters {
  accountId?: string;
  specialUse?: string;
  subscribed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Sync Types (email-specific)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Sync options for fetching emails from server
 */
export interface SyncOptions {
  folders?: string[];
  since?: Date;
  before?: Date;
  fullSync?: boolean;
  deleteRemoved?: boolean;
  downloadAttachments?: boolean;
  maxAttachmentSize?: number;
  batchSize?: number;
  maxConcurrency?: number;
  onProgress?: (stats: SyncProgress) => void;
  onError?: (error: Error, message?: unknown) => void;
}

/**
 * Progress information during sync
 */
export interface SyncProgress {
  folder: string;
  processed: number;
  total: number;
  downloaded: number;
  skipped: number;
  errors: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  folders: string[];
  messagesProcessed: number;
  messagesDownloaded: number;
  messagesSkipped: number;
  errors: Error[];
  duration: number;
}
