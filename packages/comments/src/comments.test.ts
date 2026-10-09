import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentCollection } from './collections/CommentCollection.js';
import { CommentService } from './services/CommentService.js';

describe('CommentService', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const authorUserId = '22222222-2222-4222-8222-222222222222';
  const mentionedUserId = '33333333-3333-4333-8333-333333333333';
  const dbs: Array<{ close?: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((db) => db.close?.()));
  });
  it('persists a record comment and notifies each distinct non-author mention', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    const notifyMention = vi.fn();
    const comment = await new CommentService({
      db,
      mentionNotifications: { notifyMention },
    }).create({
      tenantId,
      authorUserId,
      metaType: '@happyvertical/smrt-projects:Issue',
      metaId: 'issue-1',
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
  it('rejects malformed mention identifiers before persistence', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    await expect(
      new CommentService({ db }).create({
        tenantId,
        authorUserId,
        metaType: 'Record',
        metaId: '1',
        body: 'x',
        mentions: ['not-a-uuid'],
      }),
    ).rejects.toThrow('mentions');
  });

  it("does not expose another tenant's record comments", async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    const service = new CommentService({ db });
    await service.create({
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: 'same-id',
      body: 'Tenant A',
    });
    const tenantB = '44444444-4444-4444-8444-444444444444';
    await service.create({
      tenantId: tenantB,
      authorUserId,
      metaType: 'Record',
      metaId: 'same-id',
      body: 'Tenant B',
    });
    const comments = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db })).listForRecord(
        'Record',
        'same-id',
      ),
    );
    expect(comments.map((comment) => comment.body)).toEqual(['Tenant A']);
  });

  it('keeps a persisted comment when mention delivery fails', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    const service = new CommentService({
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
        metaId: 'failure-case',
        body: 'Still saved',
        mentions: [mentionedUserId],
      }),
    ).rejects.toThrow('delivery failed');
    const comments = await withTenant({ tenantId }, async () =>
      (await CommentCollection.create({ db })).listForRecord(
        'Record',
        'failure-case',
      ),
    );
    expect(comments).toHaveLength(1);
  });
});
