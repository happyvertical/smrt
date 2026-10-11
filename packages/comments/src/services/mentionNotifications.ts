import type {
  CommentMention,
  CommentMentionNotificationAdapter,
} from '../types.js';

/** Structural subset implemented by smrt-messages UserNotificationService. */
export interface CommentNotificationService {
  notify(input: {
    tenantId: string;
    recipientUserId: string;
    kind: string;
    title: string;
    body: string;
    sourceRef: string;
  }): Promise<unknown>;
}

/** Hosts must check recipient membership AND access to the referenced record. */
export function createCommentMentionNotifications(options: {
  notifications: CommentNotificationService;
  canNotify: (mention: CommentMention) => Promise<boolean>;
}): CommentMentionNotificationAdapter {
  return {
    async notifyMention(mention) {
      if (!(await options.canNotify(mention))) return;
      await options.notifications.notify({
        tenantId: mention.tenantId,
        recipientUserId: mention.recipientUserId,
        kind: 'comments.mention',
        title: 'You were mentioned in a comment',
        body: mention.body,
        sourceRef: `comments.mention:${mention.commentId}`,
      });
    },
  };
}
