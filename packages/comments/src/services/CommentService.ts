import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CommentCollection } from '../collections/CommentCollection.js';
import { Comment } from '../models/Comment.js';
import type {
  CommentActorContext,
  CommentMentionNotificationAdapter,
  CommentRecordAccess,
  CreateCommentInput,
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

  async create(commentOptions: CreateCommentInput): Promise<Comment> {
    const { tenantId, authorUserId, metaType, metaId, body, mentions } =
      commentOptions;
    if (!tenantId || !authorUserId) {
      throw new TypeError('Comments require a tenant and author.');
    }
    if (
      tenantId !== this.options.actor.tenantId ||
      authorUserId !== this.options.actor.userId
    ) {
      throw new Error('Comment actor context mismatch.');
    }
    await this.authorize(metaType ?? '', metaId ?? '', 'comment');
    if (!body?.trim()) throw new TypeError('Comment body is required.');
    // Validate through the model's public setter before collection.create()
    // persists. Supply its normalized JSON in that single insert.
    const prepared = new Comment();
    if (mentions !== undefined) prepared.mentionUserIds = mentions;
    const id = crypto.randomUUID();
    const comment = await withTenant({ tenantId }, async () => {
      return (await CommentCollection.create({ db: this.options.db })).create({
        tenantId,
        authorUserId,
        metaType,
        metaId,
        body,
        id,
        slug: id,
        context: '',
        _insertOnly: true,
        mentions: prepared.mentions,
      });
    });
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
