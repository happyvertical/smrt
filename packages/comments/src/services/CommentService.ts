import {
  digestRunOnceContent,
  runOnce,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { CommentCollection } from '../collections/CommentCollection.js';
import { CommentReportCollection } from '../collections/CommentReportCollection.js';
import { CommentRevisionCollection } from '../collections/CommentRevisionCollection.js';
import { Comment } from '../models/Comment.js';
import {
  type ParticipationAuthorizer,
  type ParticipationDecision,
  ParticipationDeniedError,
} from '../participation.js';
import type {
  CommentActorContext,
  CommentMentionNotificationAdapter,
  CommentRecordAccess,
  CommentStatus,
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
      participation?: ParticipationAuthorizer;
      mentionNotifications?: CommentMentionNotificationAdapter;
    },
  ) {}

  private async authorize(
    recordType: string,
    recordId: string,
    action: 'read' | 'comment' | 'moderate',
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

  private async getAuthorizedComment(
    commentId: string,
    action: 'read' | 'moderate',
  ) {
    const tenantId = this.options.actor.tenantId;
    const comment = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db: this.options.db })).get(commentId),
    );
    if (!comment || comment.tenantId !== tenantId)
      throw new Error('Comment not found.');
    await this.authorize(comment.metaType, comment.metaId, action);
    return comment;
  }

  /** Edits retain the exact former body before changing the visible comment. */
  async edit(commentId: string, body: string): Promise<Comment> {
    if (!body.trim()) throw new TypeError('Comment body is required.');
    const comment = await this.getAuthorizedComment(commentId, 'read');
    if (comment.authorUserId !== this.options.actor.userId)
      throw new Error('Comment edit denied.');
    const tenantId = this.options.actor.tenantId;
    return withTenant({ tenantId }, async () => {
      const revisions = await CommentRevisionCollection.create({
        db: this.options.db,
      });
      await revisions.create({
        tenantId,
        commentId: comment.id ?? commentId,
        editorUserId: this.options.actor.userId,
        body: comment.body,
      });
      comment.body = body;
      comment.editedAt = new Date();
      await comment.save();
      return comment;
    });
  }

  /** A moderator may make a row visible, hidden, pending, or deleted. */
  async moderate(commentId: string, status: CommentStatus): Promise<Comment> {
    const comment = await this.getAuthorizedComment(commentId, 'moderate');
    if (!['visible', 'hidden', 'pending', 'deleted'].includes(status))
      throw new TypeError('Invalid comment moderation status.');
    return withTenant({ tenantId: this.options.actor.tenantId }, async () => {
      comment.status = status;
      await comment.save();
      return comment;
    });
  }

  /** Reporting is an append-only queue entry and does not alter the comment. */
  async report(commentId: string, reason: string) {
    if (!reason.trim())
      throw new TypeError('Comment report reason is required.');
    const comment = await this.getAuthorizedComment(commentId, 'read');
    const tenantId = this.options.actor.tenantId;
    return withTenant({ tenantId }, async () =>
      (await CommentReportCollection.create({ db: this.options.db })).create({
        tenantId,
        commentId: comment.id ?? commentId,
        reporterUserId: this.options.actor.userId,
        reason: reason.trim(),
        status: 'open',
      }),
    );
  }

  async listForRecord(
    recordType: string,
    recordId: string,
  ): Promise<Comment[]> {
    await this.authorize(recordType, recordId, 'read');
    const tenantId = this.options.actor.tenantId;
    const binding = canonicalUuid(tenantId);
    const rows = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db: this.options.db })).listForRecord(
        recordType,
        recordId,
      ),
    );
    const collection = await withTenant({ tenantId }, () =>
      CommentCollection.create({ db: this.options.db }),
    );
    // The canonical retry namespace is separate from legacy reference spelling.
    // This query is tenant/parent-bound before any scoped hydration.
    const bound = await collection.db.query(
      `SELECT CAST(id AS TEXT) AS id, CAST(tenant_id AS TEXT) AS tenant_id FROM "${collection.tableName.replace(/"/g, '""')}" WHERE retry_tenant_id = ? AND meta_type = ? AND meta_id = ? AND idempotency_key IS NOT NULL`,
      binding,
      recordType,
      recordId,
    );
    for (const stored of bound.rows) {
      const row = await this.loadBoundComment(collection.db, stored, binding);
      if (row.metaType !== recordType || row.metaId !== recordId) {
        throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
      }
      rows.push(row);
    }
    for (const row of rows) {
      if (row.idempotencyKey !== null && row.retryTenantId !== binding) {
        throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
      }
    }
    return [...new Map(rows.map((row) => [row.id, row])).values()].sort(
      (a, b) =>
        (a.created_at?.getTime() ?? 0) - (b.created_at?.getTime() ?? 0) ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );
  }

  private async loadBoundComment(
    db: CommentCollection['db'],
    stored: { [key: string]: unknown },
    binding: string,
  ): Promise<Comment> {
    const id = stored.id;
    const tenantId = stored.tenant_id;
    if (
      typeof id !== 'string' ||
      typeof tenantId !== 'string' ||
      canonicalUuid(tenantId) !== binding
    ) {
      throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
    }
    // This is the original spelling of the same authorized tenant, not a bypass.
    const row = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db })).get(id),
    );
    if (
      !row ||
      canonicalUuid(row.tenantId) !== binding ||
      row.retryTenantId !== binding ||
      row.idempotencyKey === null
    ) {
      throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
    }
    return row;
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
      parentCommentId,
    } = commentOptions;
    if (!inputTenantId || !inputAuthorUserId) {
      throw new TypeError('Comments require a tenant and author.');
    }
    if (
      canonicalUuid(inputTenantId) !==
        canonicalUuid(this.options.actor.tenantId) ||
      canonicalUuid(inputAuthorUserId) !==
        canonicalUuid(this.options.actor.userId)
    ) {
      throw new Error('Comment actor context mismatch.');
    }
    // Preserve the trusted context's stored spelling on text-backed databases.
    const tenantId = this.options.actor.tenantId;
    const authorUserId = this.options.actor.userId;
    await this.authorize(metaType ?? '', metaId ?? '', 'comment');
    const participation: ParticipationDecision = this.options.participation
      ? await this.options.participation.authorize({
          tenantId,
          actorUserId: authorUserId,
          action: 'comment',
          recordType: metaType ?? '',
          recordId: metaId ?? '',
        })
      : { allowed: true as const };
    if (!participation.allowed)
      throw new ParticipationDeniedError(participation.reason);
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
      tenantId: canonicalUuid(tenantId),
      authorUserId: canonicalUuid(authorUserId),
      metaType,
      metaId,
      body,
      mentions: normalizedMentions,
      parentCommentId: parentCommentId ?? null,
    });
    const comment = await withTenant({ tenantId }, async () => {
      const collection = await CommentCollection.create({
        db: this.options.db,
      });
      const insert = async (target: CommentCollection) => {
        if (parentCommentId) {
          const parent = await target.get(parentCommentId);
          if (
            !parent ||
            parent.tenantId !== tenantId ||
            parent.metaType !== metaType ||
            parent.metaId !== metaId
          ) {
            throw new Error('Comment parent does not belong to this record.');
          }
        }
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
          retryTenantId:
            idempotencyKey === undefined ? null : canonicalUuid(tenantId),
          parentCommentId: parentCommentId ?? null,
          status: participation.initialCommentStatus ?? 'visible',
          participationSnapshot: participation.snapshot
            ? JSON.stringify(participation.snapshot)
            : null,
        });
      };
      if (idempotencyKey === undefined) return insert(collection);
      // The internal actor is an arbitration namespace, NOT the authenticated
      // author. All authors sharing a tenant/key must contend on the same claim.
      // Actual author and payload are bound by the independently checked digest.
      const receipt = await runOnce(
        {
          db: collection.db,
          tenantId: canonicalUuid(tenantId),
          actor: 'smrt-comments.create:v1',
          token: idempotencyKey,
          content: 'comment-request-binding:v1',
        },
        async (tx) => {
          const scoped = await CommentCollection.create({ db: tx });
          const matches = await tx.query(
            `SELECT CAST(id AS TEXT) AS id, CAST(tenant_id AS TEXT) AS tenant_id FROM "${scoped.tableName.replace(/"/g, '""')}" WHERE retry_tenant_id = ? AND idempotency_key = ?`,
            canonicalUuid(tenantId),
            idempotencyKey,
          );
          if (matches.rows.length > 1) {
            throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
          }
          const row = matches.rows[0]
            ? await this.loadBoundComment(
                tx,
                matches.rows[0],
                canonicalUuid(tenantId),
              )
            : await insert(scoped);
          return {
            id: row.id,
            digest: row.requestDigest,
            tenant_id: row.tenantId,
          };
        },
      );
      if (receipt.digest !== requestDigest)
        throw new CommentIdempotencyError('COMMENT_REQUEST_CONFLICT');
      const row = await this.loadBoundComment(
        collection.db,
        receipt,
        canonicalUuid(tenantId),
      );
      if (
        !row ||
        canonicalUuid(row.tenantId) !== canonicalUuid(tenantId) ||
        row.idempotencyKey !== idempotencyKey ||
        row.requestDigest !== requestDigest ||
        digestRunOnceContent({
          tenantId: canonicalUuid(row.tenantId),
          authorUserId: canonicalUuid(row.authorUserId),
          metaType: row.metaType,
          metaId: row.metaId,
          body: row.body,
          mentions: [...row.mentionUserIds].sort(),
          parentCommentId: row.parentCommentId,
        }) !== requestDigest
      ) {
        throw new CommentIdempotencyError('COMMENT_REQUEST_UNAVAILABLE');
      }
      return row;
    });
    if (!this.options.mentionNotifications || !comment.id) return comment;
    for (const recipientUserId of comment.mentionUserIds) {
      if (
        canonicalUuid(recipientUserId) === canonicalUuid(comment.authorUserId)
      )
        continue;
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
