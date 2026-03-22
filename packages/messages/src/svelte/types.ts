/**
 * Svelte component types for @happyvertical/smrt-messages
 *
 * UI data interfaces decoupled from ORM models.
 */

/**
 * Message type identifier
 */
export type MessageType = 'email' | 'tweet' | 'slack' | string;

/**
 * Bulk actions for message management
 */
export type BulkAction =
  | 'markRead'
  | 'markUnread'
  | 'flag'
  | 'unflag'
  | 'delete'
  | 'archive';

/**
 * Message data for UI components
 */
export interface MessageData {
  id: string;
  type: MessageType;
  accountId: string;
  subject: string;
  body: string;
  htmlBody?: string;
  senderName: string;
  senderAddress: string;
  recipientAddresses: Array<{ address: string; name?: string }>;
  ccAddresses?: Array<{ address: string; name?: string }>;
  threadId?: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  attachments?: AttachmentData[];
  date: string | Date;
  folderPath?: string;
  labels?: string[];
  meta?: Record<string, any>;
  sendStatus?:
    | 'draft'
    | 'pending'
    | 'sending'
    | 'sent'
    | 'failed'
    | 'scheduled';
  isDraft?: boolean;
}

/**
 * Account data for UI components
 */
export interface AccountData {
  id: string;
  name: string;
  email?: string;
  providerType: string;
  isActive: boolean;
  lastSyncAt?: string | Date | null;
  unreadCount?: number;
  totalCount?: number;
}

/**
 * Email account data for account manager workflows
 */
export interface EmailAccountData {
  id: string;
  name: string;
  email: string;
  providerType: 'imap' | 'gmail' | 'outlook' | 'exchange';
  isActive: boolean;
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: 'ssl' | 'starttls' | 'none';
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: 'ssl' | 'starttls' | 'none';
  username?: string;
  password?: string;
  lastSyncAt?: string | Date | null;
}

/**
 * Folder data for navigation
 */
export interface FolderData {
  id: string;
  accountId: string;
  name: string;
  path: string;
  specialUse?: string;
  messageCount: number;
  unreadCount: number;
}

/**
 * Attachment data for display
 */
export interface AttachmentData {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  isInline?: boolean;
}

/**
 * Filter state for message lists
 */
export interface MessageFilterState {
  type?: MessageType;
  accountId?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}

/**
 * Sort configuration
 */
export interface MessageSort {
  field: 'date' | 'sender' | 'subject' | 'type';
  direction: 'asc' | 'desc';
}

// ─────────────────────────────────────────────────────────────────────────
// Send / Compose Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Send status display configuration
 */
export interface SendStatusDisplay {
  status: 'draft' | 'pending' | 'sending' | 'sent' | 'failed' | 'scheduled';
  label: string;
  color: string;
  icon: string;
}

/**
 * Recipient entry for compose forms
 */
export interface RecipientEntry {
  address: string;
  name?: string;
  isValid: boolean;
}

/**
 * Compose form state
 */
export interface ComposeState {
  accountId: string;
  to: RecipientEntry[];
  cc: RecipientEntry[];
  bcc: RecipientEntry[];
  subject: string;
  body: string;
  attachments: AttachmentData[];
  channelId?: string;
  isDirty: boolean;
  isSending: boolean;
}

/**
 * Draft data for persistence
 */
export interface DraftData {
  id?: string;
  accountId: string;
  type: MessageType;
  to: Array<{ address: string; name?: string }>;
  cc?: Array<{ address: string; name?: string }>;
  bcc?: Array<{ address: string; name?: string }>;
  subject: string;
  body: string;
  channelId?: string;
  inReplyToMessageId?: string;
}

/**
 * Whitelist entry for email filtering
 */
export interface WhitelistEntry {
  id: string;
  pattern: string;
  type: 'email' | 'domain' | 'regex';
  category?: string | null;
  description?: string;
}

/**
 * Blacklist entry for email filtering
 */
export interface BlacklistEntry {
  id: string;
  pattern: string;
  type: 'email' | 'domain' | 'regex';
  reason?: string;
  autoArchive?: boolean;
}
