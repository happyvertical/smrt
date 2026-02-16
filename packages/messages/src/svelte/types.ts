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
