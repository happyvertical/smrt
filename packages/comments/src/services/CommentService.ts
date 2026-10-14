import {
  digestRunOnceContent,
  runOnce,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CommentCollection } from '../collections/CommentCollection.js';
import { Comment } from '../models/Comment.js';
import type {
  CommentActorContext,
  CommentMentionNotificationAdapter,
  CommentRecordAccess,
  CreateCommentInput,
} from '../types.js';

// Native UUID columns canonicalize case; identity and digests must agree with them.
const canonicalUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;

/** A reused request differs, or its retained comment is no longer available. */
export class CommentIdempotencyError extends Error {
  constructor(
    readonly code: 'COMMENT_REQUEST_CONFLICT' | 'COMMENT_REQUEST_UNAVAILABLE',
  ) {
    super(
      code === 'COMMENT_REQUEST_CONFLICT'
        ? 'Comment request key already used with different content.'
        : 'Comment request no longer has an unchanged comment.',
    );
    this.name = 'CommentIdempotencyError';
  }
}

export class CommentService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      actor: CommentActorContext;
      authorizeRecord: (access: CommentRecordAccess) => Promise<boolean>;
      mentionNotifications?: CommentMentionNotificationAdapter;
    },
  ) {
    this.options = {
      ...options,
      actor: {
        ...options.actor,
        tenantId: canonicalUuid(options.actor.tenantId),
        userId: canonicalUuid(options.actor.userId),
      },
    };
  }

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
    const {
      tenantId: inputTenantId,
      authorUserId: inputAuthorUserId,
      metaType,
      metaId,
      body,
      mentions,
      idempotencyKey,
    } = commentOptions;
    const tenantId = canonicalUuid(inputTenantId);
    const authorUserId = canonicalUuid(inputAuthorUserId);
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
    if (
      idempotencyKey !== undefined &&
      (typeof idempotencyKey !== 'string' ||
        !idempotencyKey.trim() ||
        idempotencyKey !== idempotencyKey.trim() ||
        idempotencyKey.length > 200)
    ) {
      throw new TypeError(
        'Comment idempotencyKey must be a nonempty trimmed string of at most 200 characters.',
      );
    }
    const normalizedMentions = [...prepared.mentionUserIds].sort();
    const requestDigest = digestRunOnceContent({
      tenantId,
      authorUserId,
      metaType,
      metaId,
      body,
      mentions: normalizedMentions,
    });
    const comment = await withTenant({ tenantId }, async () => {
      const collection = await CommentCollection.create({
        db: this.options.db,
      });
      const insert = async (target: CommentCollection) => {
        const id = crypto.randomUUID();
        return target.create({
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
          idempotencyKey: idempotencyKey ?? null,
          requestDigest: idempotencyKey === undefined ? null : requestDigest,
        });
      };
      if (idempotencyKey === undefined) return insert(collection);
      // The internal actor is an arbitration namespace, NOT the authenticated
      // author. All authors sharing a tenant/key must contend on the same claim.
      // Actual author and payload are bound by the independently checked digest.
      const receipt = await runOnce(
        {
          db: collection.db,
          tenantId,
          actor: 'smrt-comments.create:v1',
          token: idempotencyKey,
          content: 'comment-request-binding:v1',
        },
        async (tx) => {
          const scoped = await CommentCollection.create({ db: tx });
          const prior = (
            await scoped.list({
              where: { tenantId, idempotencyKey },
              limit: 1,
            })
          )[0];
          const row = prior ?? (await insert(scoped));
          return { id: row.id, digest: row.requestDigest };
        },
      );
      if (receipt.digest !== requestDigest)
        throw new CommentIdempotencyError('COMMENT_REQUEST_CONFLICT');
      const row = receipt.id ? await collection.get(receipt.id) : null;
      if (
        !row ||
        row.tenantId !== tenantId ||
        row.idempotencyKey !== idempotencyKey ||
        row.requestDigest !== requestDigest ||
        digestRunOnceContent({
          tenantId: row.tenantId,
          authorUserId: row.authorUserId,
          metaType: row.metaType,
          metaId: row.metaId,
          body: row.body,
          mentions: [...row.mentionUserIds].sort(),
        }) !== requestDigest
      ) {
        throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
      }
      return row;
    });
    if (!this.options.mentionNotifications || !comment.id) return comment;
    for (const recipientUserId of comment.mentionUserIds) {
      if (canonicalUuid(recipientUserId) === comment.authorUserId) continue;
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
