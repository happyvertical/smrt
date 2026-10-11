import type { SmrtPolymorphicAssociationOptions } from '@happyvertical/smrt-core';

export interface CommentOptions extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  authorUserId?: string;
  body?: string;
  mentions?: readonly string[];
}

export interface CommentMention {
  commentId: string;
  tenantId: string;
  authorUserId: string;
  recipientUserId: string;
  recordType: string;
  recordId: string;
  body: string;
}

/** Composition seam for a host or the smrt-messages notification adapter. */
export interface CommentMentionNotificationAdapter {
  notifyMention(mention: CommentMention): Promise<void>;
}

/** Trusted server context; never populate from the comment request body. */
export interface CommentActorContext {
  tenantId: string;
  userId: string;
}

export interface CommentRecordAccess extends CommentActorContext {
  recordType: string;
  recordId: string;
  action: 'read' | 'comment';
}
