import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CommentCollection } from '../collections/CommentCollection.js';
import type { Comment } from '../models/Comment.js';
import type {
  CommentActorContext,
  CommentMentionNotificationAdapter,
  CommentOptions,
  CommentRecordAccess,
} from '../types.js';

export class CommentService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      actor: CommentActorContext;
      authorizeRecord: (access: CommentRecordAccess) => Promise<boolean>;
      mentionNotifications?: CommentMentionNotificationAdapter;
    },
  ) {}

  private async authorize(
    recordType: string,
    recordId: string,
    action: 'read' | 'comment',
  ) {
    const { actor } = this.options;
    if (
      !actor.tenantId ||
      !actor.userId ||
      !recordType ||
      !recordId ||
      !(await this.options.authorizeRecord({
        ...actor,
        recordType,
        recordId,
        action,
      }))
    ) {
      throw new Error('Comment record access denied.');
    }
  }

  async listForRecord(
    recordType: string,
    recordId: string,
  ): Promise<Comment[]> {
    await this.authorize(recordType, recordId, 'read');
    return withTenant({ tenantId: this.options.actor.tenantId }, async () =>
      (await CommentCollection.create({ db: this.options.db })).listForRecord(
        recordType,
        recordId,
      ),
    );
  }

  async create(commentOptions: CommentOptions): Promise<Comment> {
    if (!commentOptions.tenantId || !commentOptions.authorUserId) {
      throw new TypeError('Comments require a tenant and author.');
    }
    if (
      commentOptions.tenantId !== this.options.actor.tenantId ||
      commentOptions.authorUserId !== this.options.actor.userId
    ) {
      throw new Error('Comment actor context mismatch.');
    }
    await this.authorize(
      commentOptions.metaType ?? '',
      commentOptions.metaId ?? '',
      'comment',
    );
    if (!commentOptions.body?.trim())
      throw new TypeError('Comment body is required.');
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
