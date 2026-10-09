import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CommentCollection } from '../collections/CommentCollection.js';
import type { Comment } from '../models/Comment.js';
import type {
  CommentMentionNotificationAdapter,
  CommentOptions,
} from '../types.js';

export class CommentService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      mentionNotifications?: CommentMentionNotificationAdapter;
    },
  ) {}

  async create(commentOptions: CommentOptions): Promise<Comment> {
    if (!commentOptions.tenantId || !commentOptions.authorUserId) {
      throw new TypeError('Comments require a tenant and author.');
    }
    const { mentions, ...input } = commentOptions;
    const comment = await withTenant(
      { tenantId: commentOptions.tenantId },
      async () => {
        const created = await (
          await CommentCollection.create({ db: this.options.db })
        ).create(input);
        if (mentions !== undefined) created.mentionUserIds = mentions;
        return created.save();
      },
    );
    if (!this.options.mentionNotifications || !comment.id) return comment;
    for (const recipientUserId of comment.mentionUserIds) {
      if (recipientUserId === comment.authorUserId) continue;
      await this.options.mentionNotifications.notifyMention({
        commentId: comment.id,
        tenantId: comment.tenantId,
        authorUserId: comment.authorUserId,
        recipientUserId,
        recordType: comment.metaType,
        recordId: comment.metaId,
        body: comment.body,
      });
    }
    return comment;
  }
}
