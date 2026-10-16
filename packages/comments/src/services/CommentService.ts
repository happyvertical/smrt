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
import type {
  ParticipationAuthorizer,
  ParticipationDecision,
} from '../participation-contract.js';
import type {
  CommentActorContext,
  CommentMentionNotificationAdapter,
  CommentRecordAccess,
  CommentStatus,
  CreateCommentInput,
} from '../types.js';
import { ParticipationService } from './ParticipationService.js';

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
        : 'Comment request no longer has a valid retained creation binding.',
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
    if (!comment || canonicalUuid(comment.tenantId) !== canonicalUuid(tenantId))
      throw new Error('Comment not found.');
    await this.authorize(comment.metaType, comment.metaId, action);
    return comment;
  }

  /** Edits retain the exact former body before changing the visible comment. */
  async edit(commentId: string, body: string): Promise<Comment> {
    if (!body.trim()) throw new TypeError('Comment body is required.');
    const comment = await this.getAuthorizedComment(commentId, 'read');
    if (
      canonicalUuid(comment.authorUserId) !==
      canonicalUuid(this.options.actor.userId)
    )
      throw new Error('Comment edit denied.');
    await this.authorize(comment.metaType, comment.metaId, 'comment');
    const tenantId = this.options.actor.tenantId;
    return withTenant({ tenantId }, async () => {
      const collection = await CommentCollection.create({
        db: this.options.db,
      });
      if (!collection.db.transaction)
        throw new Error('Comment edits require transactions.');
      return collection.db.transaction(async (tx) => {
        const scoped = await CommentCollection.create({ db: tx });
        // Acquire the row's write lock before reading the body retained as history.
        const table = `"${scoped.tableName.replace(/"/g, '""')}"`;
        await tx.query(
          `UPDATE ${table} SET body = body WHERE id = ? AND tenant_id = ?`,
          commentId,
          tenantId,
        );
        const current = await scoped.get(commentId);
        if (
          !current ||
          canonicalUuid(current.authorUserId) !==
            canonicalUuid(this.options.actor.userId)
        )
          throw new Error('Comment edit denied.');
        const participation = new ParticipationService({
          db: tx,
          entitlement: this.options.participation,
        });
        return participation.executeInTransaction(
          tx,
          {
            tenantId,
            actorUserId: this.options.actor.userId,
            action: 'comment',
            recordType: current.metaType,
            recordId: current.metaId,
          },
          async (guardedTx, decision) => {
            const revisions = await CommentRevisionCollection.create({
              db: guardedTx,
            });
            await revisions.create({
              tenantId,
              commentId,
              editorUserId: this.options.actor.userId,
              body: current.body,
            });
            if (
              current.status === 'visible' &&
              decision.initialCommentStatus === 'pending'
            ) {
              current.status = 'pending';
            }
            current.body = body;
            current.editedAt = new Date();
            await current.save();
            return current;
          },
        );
      });
    });
  }

  /** A moderator may make a row visible, hidden, pending, or deleted. */
  async moderate(commentId: string, status: CommentStatus): Promise<Comment> {
    const comment = await this.getAuthorizedComment(commentId, 'moderate');
    if (!['visible', 'hidden', 'pending', 'deleted'].includes(status))
      throw new TypeError('Invalid comment moderation status.');
    return withTenant({ tenantId: this.options.actor.tenantId }, async () => {
      const collection = await CommentCollection.create({
        db: this.options.db,
      });
      const table = `"${collection.tableName.replace(/"/g, '""')}"`;
      await collection.db.query(
        `UPDATE ${table} SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`,
        status,
        commentId,
        this.options.actor.tenantId,
      );
      const updated = await collection.get(commentId);
      if (!updated) throw new Error('Comment not found.');
      return updated;
    });
  }

  /** One retained report per actor/comment; new reports consume shared report quota. */
  async report(commentId: string, reason: string) {
    if (!reason.trim())
      throw new TypeError('Comment report reason is required.');
    const comment = await this.getAuthorizedComment(commentId, 'read');
    if (comment.status !== 'visible')
      throw new Error('Comment is not reportable.');
    commentId = canonicalUuid(comment.id ?? commentId);
    const tenantId = canonicalUuid(this.options.actor.tenantId);
    const reporterUserId = canonicalUuid(this.options.actor.userId);
    const request = {
      tenantId,
      actorUserId: reporterUserId,
      action: 'report' as const,
      recordType: comment.metaType,
      recordId: comment.metaId,
    };
    const guard = new ParticipationService({
      db: this.options.db,
      entitlement: this.options.participation,
    });
    await guard.authorize(request);
    return withTenant({ tenantId }, async () => {
      const reports = await CommentReportCollection.create({
        db: this.options.db,
      });
      const id = await runOnce(
        {
          db: reports.db,
          tenantId,
          actor: 'smrt-comments.report:v1',
          token: `${reporterUserId}:${canonicalUuid(commentId)}`,
          content: 'retained-report:v1',
        },
        async (tx) => {
          const scoped = await CommentReportCollection.create({ db: tx });
          const existing = await scoped.list({
            where: { tenantId, reporterUserId, commentId },
          });
          if (existing[0]) return existing[0].id;
          return guard.executeInTransaction(tx, request, async (guardedTx) => {
            const current = await withTenant(
              { tenantId: comment.tenantId },
              async () =>
                (await CommentCollection.create({ db: guardedTx })).get(
                  commentId,
                ),
            );
            if (!current || current.status !== 'visible')
              throw new Error('Comment is not reportable.');
            return (
              await (
                await CommentReportCollection.create({ db: guardedTx })
              ).create({
                tenantId,
                commentId,
                reporterUserId,
                reason: reason.trim(),
                status: 'open',
              })
            ).id;
          });
        },
      );
      const report = id ? await reports.get(id) : null;
      if (
        !report ||
        report.commentId !== canonicalUuid(commentId) ||
        report.reporterUserId !== reporterUserId
      )
        throw new Error('Retained report unavailable.');
      return report;
    });
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
    const participationRequest = {
      tenantId,
      actorUserId: authorUserId,
      action: 'comment' as const,
      recordType: metaType ?? '',
      recordId: metaId ?? '',
    };
    await new ParticipationService({
      db: this.options.db,
      entitlement: this.options.participation,
    }).authorize(participationRequest);
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
      ...(parentCommentId ? { parentCommentId } : {}),
    });
    const comment = await withTenant({ tenantId }, async () => {
      const collection = await CommentCollection.create({
        db: this.options.db,
      });
      const insert = async (
        target: CommentCollection,
        inTransaction = false,
      ) => {
        const guard = new ParticipationService({
          db: target.db,
          entitlement: this.options.participation,
        });
        const work = async (
          tx: CommentCollection['db'],
          participation: ParticipationDecision,
        ) => {
          target = await CommentCollection.create({ db: tx });
          if (parentCommentId) {
            const parent = await target.get(parentCommentId);
            if (
              !parent ||
              canonicalUuid(parent.tenantId) !== canonicalUuid(tenantId) ||
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
        return inTransaction
          ? guard.executeInTransaction(target.db, participationRequest, work)
          : guard.execute(participationRequest, work);
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
            : await insert(scoped, true);
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
      const retainedBodies = row.editedAt
        ? (
            await (
              await CommentRevisionCollection.create({ db: collection.db })
            ).list({
              where: { commentId: row.id, tenantId: row.tenantId },
            })
          ).map((revision) => revision.body)
        : [row.body];
      if (
        canonicalUuid(row.tenantId) !== canonicalUuid(tenantId) ||
        row.idempotencyKey !== idempotencyKey ||
        row.requestDigest !== requestDigest ||
        !retainedBodies.some(
          (retainedBody) =>
            digestRunOnceContent({
              tenantId: canonicalUuid(row.tenantId),
              authorUserId: canonicalUuid(row.authorUserId),
              metaType: row.metaType,
              metaId: row.metaId,
              body: retainedBody,
              mentions: [...row.mentionUserIds].sort(),
              ...(row.parentCommentId
                ? { parentCommentId: row.parentCommentId }
                : {}),
            }) === requestDigest,
        )
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
