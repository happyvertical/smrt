import type { SmrtPolymorphicAssociationOptions } from '@happyvertical/smrt-core';

export interface CommentOptions extends SmrtPolymorphicAssociationOptions {
  tenantId?: string;
  authorUserId?: string;
  body?: string;
  mentions?: readonly string[];
  idempotencyKey?: string | null;
  requestDigest?: string | null;
  retryTenantId?: string | null;
  parentCommentId?: string | null;
  status?: CommentStatus;
  participationSnapshot?: string | null;
}

export type CommentStatus = 'visible' | 'hidden' | 'pending' | 'deleted';

/** Public service input; persistence identity and executor are server-owned. */
export interface CreateCommentInput {
  tenantId: string;
  authorUserId: string;
  metaType: string;
  metaId: string;
  body: string;
  mentions?: readonly string[];
  /** Tenant-scoped request key; identical retries return the original comment. */
  idempotencyKey?: string;
  /** A reply is bound to the same tenant and polymorphic parent record. */
  parentCommentId?: string | null;
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
  action: 'read' | 'comment' | 'moderate';
}
