import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { UserNotificationService } from '@happyvertical/smrt-messages';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentCollection } from './collections/CommentCollection.js';
import { Comment } from './models/Comment.js';
import { RecordCommentsRecipe } from './recipes.js';
import { CommentService } from './services/CommentService.js';
import { createCommentMentionNotifications } from './services/mentionNotifications.js';

describe.each([
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_POSTGRES_URL ? ['postgres'] : []),
] as const)('CommentService %s', (dialect) => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const authorUserId = '22222222-2222-4222-8222-222222222222';
  const mentionedUserId = '33333333-3333-4333-8333-333333333333';
  const access = {
    actor: { tenantId, userId: authorUserId },
    authorizeRecord: async () => true,
  };
  const dbs: Array<{ close?: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((db) => db.close?.()));
  });
  it('persists a record comment and notifies each distinct non-author mention', async () => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const notifyMention = vi.fn();
    const comment = await new CommentService({
      ...access,
      db,
      mentionNotifications: { notifyMention },
    }).create({
      tenantId,
      authorUserId,
      metaType: '@happyvertical/smrt-projects:Issue',
      metaId: crypto.randomUUID(),
      body: 'Please review',
      mentions: [mentionedUserId, mentionedUserId, authorUserId],
    });
    expect(comment.mentionUserIds).toEqual([mentionedUserId, authorUserId]);
    expect(notifyMention).toHaveBeenCalledTimes(1);
    expect(notifyMention).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: mentionedUserId,
        commentId: comment.id,
      }),
    );
  });
  it('denies unauthorized records and forged actor context before writing or notifying', async () => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const authorizeRecord = vi.fn(async () => false);
    const notifyMention = vi.fn();
    const service = new CommentService({
      ...access,
      db,
      authorizeRecord,
      mentionNotifications: { notifyMention },
    });
    const input = {
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: crypto.randomUUID(),
      body: 'Denied',
      mentions: [mentionedUserId],
    };
    await expect(service.create(input)).rejects.toThrow('access denied');
    await expect(
      service.listForRecord(input.metaType, input.metaId),
    ).rejects.toThrow('access denied');
    await expect(
      service.create({ ...input, authorUserId: mentionedUserId }),
    ).rejects.toThrow('context mismatch');
    await expect(
      service.create({ ...input, tenantId: mentionedUserId }),
    ).rejects.toThrow('context mismatch');
    expect(notifyMention).not.toHaveBeenCalled();
    expect(
      await new CommentService({ ...access, db }).listForRecord(
        input.metaType,
        input.metaId,
      ),
    ).toEqual([]);
  });
  it('composes real mention notifications with recipient authorization and replay dedupe', async () => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const notifications = new UserNotificationService({ db });
    const adapter = createCommentMentionNotifications({
      notifications,
      canNotify: async (mention) => mention.recipientUserId === mentionedUserId,
    });
    const denied = '77777777-7777-4777-8777-777777777777';
    const comment = await new CommentService({
      ...access,
      db,
      mentionNotifications: adapter,
    }).create({
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: crypto.randomUUID(),
      body: 'Please review this record',
      mentions: [mentionedUserId, denied],
    });
    if (!comment.id) throw new Error('Expected saved comment identity');
    await adapter.notifyMention({
      commentId: comment.id,
      tenantId,
      authorUserId,
      recipientUserId: mentionedUserId,
      recordType: comment.metaType,
      recordId: comment.metaId,
      body: comment.body,
    });
    const rows = await notifications.listForUser(mentionedUserId, {
      tenantIds: [tenantId],
    });
    expect(
      rows.filter((row) => row.sourceRef === `comments.mention:${comment.id}`),
    ).toHaveLength(1);
    expect(
      await notifications.listForUser(denied, { tenantIds: [tenantId] }),
    ).toEqual([]);
    expect(RecordCommentsRecipe.id).toBe('comments.records');
    expect(RecordCommentsRecipe.models).toContain(Comment);
  });
  it.each([
    'malformed',
    'over-limit',
  ])('rejects %s mentions without leaving a saved row', async (invalid) => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const service = new CommentService({ ...access, db });
    const recordId = crypto.randomUUID();
    await expect(
      service.create({
        tenantId,
        authorUserId,
        metaType: 'Record',
        metaId: recordId,
        body: 'x',
        mentions:
          invalid === 'malformed'
            ? ['not-a-uuid']
            : Array.from({ length: 51 }, () => crypto.randomUUID()),
      }),
    ).rejects.toThrow('mentions');
    expect(await service.listForRecord('Record', recordId)).toEqual([]);
  });

  it("does not expose another tenant's record comments", async () => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const service = new CommentService({ ...access, db });
    await service.create({
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: '55555555-5555-4555-8555-555555555555',
      body: 'Tenant A',
    });
    const tenantB = '44444444-4444-4444-8444-444444444444';
    await new CommentService({
      ...access,
      actor: { tenantId: tenantB, userId: authorUserId },
      db,
    }).create({
      tenantId: tenantB,
      authorUserId,
      metaType: 'Record',
      metaId: '55555555-5555-4555-8555-555555555555',
      body: 'Tenant B',
    });
    const comments = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db })).listForRecord(
        'Record',
        '55555555-5555-4555-8555-555555555555',
      ),
    );
    expect(comments.map((comment) => comment.body)).toEqual(['Tenant A']);
  });

  it('keeps a persisted comment when mention delivery fails', async () => {
    const db = await getTestDatabase({
      classes: ['Comment', 'UserNotification'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const service = new CommentService({
      ...access,
      db,
      mentionNotifications: {
        notifyMention: vi.fn().mockRejectedValue(new Error('delivery failed')),
      },
    });
    await expect(
      service.create({
        tenantId,
        authorUserId,
        metaType: 'Record',
        metaId: '66666666-6666-4666-8666-666666666666',
        body: 'Still saved',
        mentions: [mentionedUserId],
      }),
    ).rejects.toThrow('delivery failed');
    const comments = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db })).listForRecord(
        'Record',
        '66666666-6666-4666-8666-666666666666',
      ),
    );
    expect(comments).toHaveLength(1);
  });
});
