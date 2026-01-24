/**
 * Type definitions for @happyvertical/smrt-messages
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

/**
 * Email provider type
 */
export type ProviderType = 'smtp' | 'imap' | 'pop3' | 'gmail';

/**
 * Options for creating Email
 */
export interface EmailOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  accountId?: string;
  messageId?: string; // RFC 822 Message-ID
  threadId?: string;
  inReplyTo?: string;
  fromAddress?: string;
  fromName?: string;
  toAddresses?: string; // JSON array
  ccAddresses?: string;
  bccAddresses?: string;
  replyToAddress?: string;
  replyToName?: string;
  subject?: string;
  date?: Date | null;
  textBody?: string;
  htmlBody?: string;
  folderId?: string;
  folderPath?: string;
  labels?: string; // JSON array (Gmail)
  flags?: string; // JSON array (IMAP)
  isRead?: boolean;
  isFlagged?: boolean;
  isAnswered?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  size?: number;
  rawMessage?: string;
  headers?: string; // JSON object
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating EmailAccount
 */
export interface EmailAccountOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  name?: string;
  email?: string;
  providerType?: ProviderType;
  settings?: string; // JSON (DEPRECATED: use credentialSecretId)
  credentialSecretId?: string | null; // Reference to secret in smrt-secrets
  lastSyncAt?: Date | null;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
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
  specialUse?: string; // '\\Inbox', '\\Sent', etc.
  messageCount?: number;
  unreadCount?: number;
  subscribed?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating EmailAttachment
 */
export interface EmailAttachmentOptions extends SmrtObjectOptions {
  id?: string;
  tenantId?: string | null;
  emailId?: string;
  filename?: string;
  contentType?: string;
  size?: number;
  contentId?: string;
  contentDisposition?: 'attachment' | 'inline';
  filePath?: string; // External file storage path
  createdAt?: Date;
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

/**
 * Sync options for fetching emails from server
 */
export interface SyncOptions {
  folders?: string[]; // Default: ['INBOX']
  since?: Date;
  before?: Date;
  fullSync?: boolean; // Sync all messages (vs incremental)
  deleteRemoved?: boolean; // Delete local messages removed from server
  downloadAttachments?: boolean;
  maxAttachmentSize?: number; // Skip large attachments
  batchSize?: number; // Messages per batch
  maxConcurrency?: number; // Parallel operations
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
  duration: number; // Milliseconds
}
