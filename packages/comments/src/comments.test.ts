import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { UserNotificationService } from '@happyvertical/smrt-messages';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentCollection } from './collections/CommentCollection.js';
import { Comment } from './models/Comment.js';
import { RecordCommentsRecipe } from './recipes.js';
import { CommentService } from './services/CommentService.js';
import { createCommentMentionNotifications } from './services/mentionNotifications.js';
import type { CommentRecordAccess } from './types.js';

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
  it.each([
    'natural-key',
    'primary-key',
  ])('ignores injected %s identity instead of replacing an unauthorized record comment', async (attack) => {
    const db = await getTestDatabase({
      classes: ['Comment'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const recordA = crypto.randomUUID();
    const recordB = crypto.randomUUID();
    const owner = new CommentService({
      db,
      actor: { tenantId, userId: mentionedUserId },
      authorizeRecord: async () => true,
    });
    const existing = await owner.create({
      tenantId,
      authorUserId: mentionedUserId,
      metaType: 'Record',
      metaId: recordB,
      body: 'Private record B discussion',
    });
    const authorizeRecord = vi.fn(
      async (access: CommentRecordAccess) => access.recordId === recordA,
    );
    const service = new CommentService({ db, ...access, authorizeRecord });
    const request = {
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: recordA,
      body: 'New record A discussion',
      slug: existing.slug,
      context: existing.context,
      ...(attack === 'primary-key' ? { id: existing.id } : {}),
      _adoptNaturalKey: true,
      _insertOnly: false,
    };
    const created = await service.create(request);
    const originalRows = await owner.listForRecord('Record', recordB);
    expect(
      originalRows.map((row) => ({
        id: row.id,
        author: row.authorUserId,
        body: row.body,
      })),
    ).toEqual([
      {
        id: existing.id,
        author: mentionedUserId,
        body: 'Private record B discussion',
      },
    ]);
    expect(created.id).not.toBe(existing.id);
    expect(created.slug).not.toBe(existing.slug);
    expect(
      (await service.listForRecord('Record', recordA)).map((row) => row.id),
    ).toEqual([created.id]);
    expect(
      authorizeRecord.mock.calls.every(
        ([request]) => request.recordId === recordA,
      ),
    ).toBe(true);
  });
  it('ignores forged database and constructor options at the service boundary', async () => {
    const db = await getTestDatabase({
      classes: ['Comment'],
      type: dialect as 'sqlite' | 'duckdb' | 'postgres',
      url:
        dialect === 'postgres'
          ? process.env.SMRT_TEST_POSTGRES_URL
          : ':memory:',
    });
    dbs.push(db);
    const injectedQuery = vi.fn(async () => {
      throw new Error('Untrusted executor reached');
    });
    const injectedDb = new Proxy(db, {
      get(target, key) {
        return key === 'query'
          ? injectedQuery
          : Reflect.get(target, key, target);
      },
    });
    const recordId = crypto.randomUUID();
    const request = {
      tenantId,
      authorUserId,
      metaType: 'Record',
      metaId: recordId,
      body: 'Trusted executor',
      db: injectedDb,
      role: 'injected',
      sortOrder: 900,
      context: 'injected',
      _skipLoad: false,
      _insertOnly: false,
    };
    const service = new CommentService({ ...access, db });
    const comment = await service.create(request);
    expect(injectedQuery).not.toHaveBeenCalled();
    expect(comment.context).toBe('');
    expect(comment.role).toBe('default');
    expect(comment.sortOrder).toBe(0);
    expect(
      (await service.listForRecord('Record', recordId)).map((row) => row.id),
    ).toEqual([comment.id]);
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
  describe('idempotent create', () => {
    let tenantId = '';
    let access = {
      actor: { tenantId, userId: authorUserId },
      authorizeRecord: async () => true,
    };
    async function fixture() {
      tenantId = crypto.randomUUID();
      access = {
        actor: { tenantId, userId: authorUserId },
        authorizeRecord: async () => true,
      };
      const db = await getTestDatabase({
        classes: ['Comment', 'UserNotification'],
        type: dialect as 'sqlite' | 'duckdb' | 'postgres',
        url:
          dialect === 'postgres'
            ? process.env.SMRT_TEST_POSTGRES_URL
            : ':memory:',
      });
      dbs.push(db);
      const input = {
        tenantId,
        authorUserId,
        metaType: 'Record',
        metaId: crypto.randomUUID(),
        body: 'Original request',
        idempotencyKey: crypto.randomUUID(),
        mentions: [mentionedUserId],
      };
      return { db, input, service: new CommentService({ ...access, db }) };
    }

    it('shares durable retries across every trusted actor and request UUID spelling', async () => {
      const { db, input } = await fixture();
      const tenant = input.tenantId;
      const author = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
      const make = (tenantId: string, userId: string) =>
        new CommentService({
          db,
          actor: { tenantId, userId },
          authorizeRecord: async () => true,
        });
      const first = await make(
        tenant.toUpperCase(),
        author.toUpperCase(),
      ).create({ ...input, authorUserId: author });
      for (const retained of [true, false]) {
        if (!retained)
          await db.query(
            'DELETE FROM _smrt_run_once_claims WHERE tenant_id = ?',
            tenant,
          );
        for (let bits = 0; bits < 16; bits++) {
          const spelling = (value: string, bit: number) =>
            bits & bit ? value.toUpperCase() : value;
          const service = make(spelling(tenant, 1), spelling(author, 2));
          const replay = await service.create({
            ...input,
            tenantId: spelling(tenant, 4),
            authorUserId: spelling(author, 8),
          });
          expect(replay.id).toBe(first.id);
          expect(
            (await service.listForRecord(input.metaType, input.metaId)).map(
              (row) => row.id,
            ),
          ).toEqual([first.id]);
        }
      }
      const rows = await db.query(
        'SELECT id FROM record_comments WHERE retry_tenant_id = ? AND idempotency_key = ?',
        tenant,
        input.idempotencyKey,
      );
      expect(rows.rows).toHaveLength(1);
      // The durable constraint, independently of the retained generic claim.
      await expect(
        db.query(
          'UPDATE record_comments SET retry_tenant_id = ? WHERE id = ?',
          crypto.randomUUID(),
          first.id,
        ),
      ).resolves.toBeDefined();
      await expect(
        make(tenant, author).create({ ...input, authorUserId: author }),
      ).rejects.toMatchObject({ code: 'COMMENT_REQUEST_UNAVAILABLE' });
    });

    it('arbitrates cold cross-case actors and enforces canonical binding uniqueness', async () => {
      const { db, input } = await fixture();
      const author = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
      const lower = new CommentService({
        db,
        actor: { tenantId: input.tenantId, userId: author },
        authorizeRecord: async () => true,
      });
      const upper = new CommentService({
        db,
        actor: {
          tenantId: input.tenantId.toUpperCase(),
          userId: author.toUpperCase(),
        },
        authorizeRecord: async () => true,
      });
      const request = { ...input, authorUserId: author };
      const [a, b] = await Promise.all([
        upper.create(request),
        lower.create(request),
      ]);
      expect(a.id).toBe(b.id);
      await db.query(
        'DELETE FROM _smrt_run_once_claims WHERE tenant_id = ?',
        input.tenantId,
      );
      const [c, d] = await Promise.all([
        lower.create(request),
        upper.create(request),
      ]);
      expect([c.id, d.id]).toEqual([a.id, a.id]);
      const duplicateId = crypto.randomUUID();
      await expect(
        db.query(
          'INSERT INTO record_comments (id, slug, context, meta_type, meta_id, role, tenant_id, author_user_id, body, mentions, idempotency_key, retry_tenant_id, request_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          duplicateId,
          duplicateId,
          '',
          input.metaType,
          input.metaId,
          '',
          input.tenantId.toUpperCase(),
          author.toUpperCase(),
          input.body,
          '[]',
          input.idempotencyKey,
          input.tenantId,
          a.requestDigest,
        ),
      ).rejects.toThrow();
      expect(
        (await lower.listForRecord(input.metaType, input.metaId)).map(
          (row) => row.id,
        ),
      ).toEqual([a.id]);
    });

    it('merges legacy and bound comments in order without exposing another tenant or parent', async () => {
      const { db, input } = await fixture();
      const upperTenant = input.tenantId.toUpperCase();
      const actor = { tenantId: upperTenant, userId: input.authorUserId };
      const service = new CommentService({
        db,
        actor,
        authorizeRecord: async () => true,
      });
      const legacy = await service.create({
        ...input,
        tenantId: upperTenant,
        idempotencyKey: undefined,
      });
      await db.query(
        'UPDATE record_comments SET created_at = ? WHERE id = ?',
        '2020-01-01T00:00:00.000Z',
        legacy.id,
      );
      const keyed = await service.create(input);
      const otherTenant = crypto.randomUUID();
      await new CommentService({
        db,
        actor: { tenantId: otherTenant, userId: input.authorUserId },
        authorizeRecord: async () => true,
      }).create({ ...input, tenantId: otherTenant });
      await service.create({
        ...input,
        idempotencyKey: crypto.randomUUID(),
        metaId: 'different-parent',
      });
      expect(
        (await service.listForRecord(input.metaType, input.metaId)).map(
          (row) => row.id,
        ),
      ).toEqual([legacy.id, keyed.id]);
      const lower = new CommentService({
        db,
        actor: { ...actor, tenantId: input.tenantId },
        authorizeRecord: async () => true,
      });
      const expected =
        dialect === 'sqlite' ? [keyed.id] : [legacy.id, keyed.id];
      expect(
        (await lower.listForRecord(input.metaType, input.metaId)).map(
          (row) => row.id,
        ),
      ).toEqual(expected);
      // A forged trusted low-level binding cannot grant cross-tenant read access.
      const forgedTenant = crypto.randomUUID();
      await db.query(
        'UPDATE record_comments SET retry_tenant_id = ? WHERE id = ?',
        forgedTenant,
        keyed.id,
      );
      const other = new CommentService({
        db,
        actor: { tenantId: forgedTenant, userId: input.authorUserId },
        authorizeRecord: async () => true,
      });
      await expect(
        other.listForRecord(input.metaType, input.metaId),
      ).rejects.toMatchObject({ code: 'COMMENT_REQUEST_UNAVAILABLE' });
    });

    if (dialect === 'sqlite') {
      it('keeps opaque textual tenant identifiers case-sensitive', async () => {
        const { db, input } = await fixture();
        const create = (tenantId: string) =>
          new CommentService({
            db,
            actor: { tenantId, userId: input.authorUserId },
            authorizeRecord: async () => true,
          });
        const a = await create('TenantCase').create({
          ...input,
          tenantId: 'TenantCase',
        });
        const b = await create('tenantcase').create({
          ...input,
          tenantId: 'tenantcase',
        });
        expect(a.id).not.toBe(b.id);
        expect(
          (
            await create('TenantCase').listForRecord(
              input.metaType,
              input.metaId,
            )
          ).map((row) => row.id),
        ).toEqual([a.id]);
        expect(
          (
            await create('tenantcase').listForRecord(
              input.metaType,
              input.metaId,
            )
          ).map((row) => row.id),
        ).toEqual([b.id]);
      });
    }

    it('lists preexisting comments with the original uppercase tenant spelling', async () => {
      const { db, input } = await fixture();
      const upperTenant = input.tenantId.toUpperCase();
      const id = crypto.randomUUID();
      // Pre-key service persisted the trusted actor's original spelling.
      await db.query(
        'INSERT INTO record_comments (id, slug, context, meta_type, meta_id, role, tenant_id, author_user_id, body, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        id,
        '',
        input.metaType,
        input.metaId,
        '',
        upperTenant,
        input.authorUserId,
        'Historical discussion',
        '[]',
      );
      const service = new CommentService({
        db,
        actor: { tenantId: upperTenant, userId: input.authorUserId },
        authorizeRecord: async () => true,
      });
      expect(
        (await service.listForRecord(input.metaType, input.metaId)).map(
          (row) => row.id,
        ),
      ).toEqual([id]);
    });

    it('replays uppercase UUID tenant and author identities without a committed unavailable row', async () => {
      const { db, input } = await fixture();
      const upperTenant = input.tenantId.toUpperCase();
      const upperAuthor = 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase();
      const notifyMention = vi.fn(async () => {});
      const authorizeRecord = vi.fn(
        async (_context: CommentRecordAccess) => true,
      );
      const service = new CommentService({
        db,
        actor: { tenantId: upperTenant, userId: upperAuthor },
        authorizeRecord,
        mentionNotifications: { notifyMention },
      });
      const request = {
        ...input,
        tenantId: upperTenant,
        authorUserId: upperAuthor,
        mentions: [upperAuthor],
      };
      const first = await service.create(request);
      const retry = await service.create(request);
      expect(retry.id).toBe(first.id);
      expect(
        (
          await service.create({
            ...request,
            tenantId: upperTenant.toLowerCase(),
            authorUserId: upperAuthor.toLowerCase(),
          })
        ).id,
      ).toBe(first.id);
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(1);
      expect(
        authorizeRecord.mock.calls.every(
          ([context]: [CommentRecordAccess]) =>
            context.tenantId === upperTenant && context.userId === upperAuthor,
        ),
      ).toBe(true);
      expect(notifyMention).not.toHaveBeenCalled();
      await expect(
        service.create({ ...request, authorUserId: crypto.randomUUID() }),
      ).rejects.toThrow('actor context mismatch');
      await expect(
        service.create({ ...request, tenantId: crypto.randomUUID() }),
      ).rejects.toThrow('actor context mismatch');
      const textual = new CommentService({
        db,
        actor: { tenantId: 'TenantCase', userId: 'AuthorCase' },
        authorizeRecord: async () => true,
      });
      await expect(
        textual.create({
          ...request,
          tenantId: 'tenantcase',
          authorUserId: 'AuthorCase',
        }),
      ).rejects.toThrow('actor context mismatch');
    });

    it('replays a normalized request with a server-owned UUID and ignores injected digest', async () => {
      const { db, input, service } = await fixture();
      input.mentions = [authorUserId, mentionedUserId];
      const injected = {
        ...input,
        id: input.idempotencyKey,
        slug: 'attacker',
        requestDigest: 'attacker',
        retryTenantId: crypto.randomUUID(),
        _insertOnly: false,
        context: 'attacker',
      };
      const first = await service.create(injected);
      const second = await service.create({
        ...input,
        mentions: [mentionedUserId, authorUserId, mentionedUserId],
      });
      expect(first.id).not.toBe(input.idempotencyKey);
      expect(first.slug).toBe(first.id);
      expect(second.id).toBe(first.id);
      expect(second.requestDigest).not.toBe('attacker');
      expect(second.retryTenantId).toBe(input.tenantId);
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(1);
      // Generic receipt retention must not make an existing service-owned row duplicable.
      await db.query(
        'DELETE FROM _smrt_run_once_claims WHERE tenant_id = ?',
        tenantId,
      );
      expect((await service.create(input)).id).toBe(first.id);
    });

    it.each([
      'body',
      'metaId',
      'metaType',
      'mentions',
      'authorUserId',
    ] as const)('rejects changed %s using the same tenant request key', async (field) => {
      const { input, service, db } = await fixture();
      const first = await service.create(input);
      const changed = {
        ...input,
        [field]: field === 'mentions' ? [] : crypto.randomUUID(),
      };
      const next =
        field === 'authorUserId'
          ? new CommentService({
              ...access,
              db,
              actor: { tenantId, userId: changed.authorUserId },
            })
          : service;
      await expect(next.create(changed)).rejects.toMatchObject({
        code: 'COMMENT_REQUEST_CONFLICT',
      });
      expect((await service.create(input)).id).toBe(first.id);
    });

    it.each([
      '',
      ' ',
      ' padded',
      'x'.repeat(201),
      null,
      7,
    ])('rejects malformed key %s before saving', async (key) => {
      const { input, service } = await fixture();
      await expect(
        service.create({ ...input, idempotencyKey: key as string }),
      ).rejects.toThrow('idempotencyKey');
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(0);
    });

    it('reauthorizes replay and isolates identical keys across tenants', async () => {
      const { input, service, db } = await fixture();
      const first = await service.create(input);
      const denied = new CommentService({
        ...access,
        db,
        authorizeRecord: async () => false,
      });
      await expect(denied.create(input)).rejects.toThrow('access denied');
      await expect(
        service.create({ ...input, tenantId: crypto.randomUUID() }),
      ).rejects.toThrow('context mismatch');
      const tenantB = crypto.randomUUID();
      const other = new CommentService({
        ...access,
        db,
        actor: { tenantId: tenantB, userId: authorUserId },
      });
      expect((await other.create({ ...input, tenantId: tenantB })).id).not.toBe(
        first.id,
      );
    });

    it.each([
      'same',
      'body',
      'author',
    ] as const)('arbitrates concurrent %s requests without duplicate comments', async (kind) => {
      const { input, service, db } = await fixture();
      const nextInput = {
        ...input,
        ...(kind === 'body' ? { body: 'Competing request' } : {}),
        ...(kind === 'author' ? { authorUserId: mentionedUserId } : {}),
      };
      const next = new CommentService({
        db,
        ...access,
        actor: { tenantId, userId: nextInput.authorUserId },
      });
      const results = await Promise.allSettled([
        service.create(input),
        next.create(nextInput),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        kind === 'same' ? 2 : 1,
      );
      if (kind !== 'same')
        expect(results.find((r) => r.status === 'rejected')).toMatchObject({
          reason: { code: 'COMMENT_REQUEST_CONFLICT' },
        });
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(1);
      await db.query('SELECT 1');
    });

    it('retries partial notification delivery using the original comment identity', async () => {
      const { input, db } = await fixture();
      const secondRecipient = crypto.randomUUID();
      const mentions = [mentionedUserId, secondRecipient];
      const adapter = createCommentMentionNotifications({
        notifications: new UserNotificationService({ db }),
        canNotify: async () => true,
      });
      let fail = true;
      const service = new CommentService({
        db,
        ...access,
        mentionNotifications: {
          async notifyMention(mention) {
            if (mention.recipientUserId === secondRecipient && fail)
              throw new Error('partial delivery');
            await adapter.notifyMention(mention);
          },
        },
      });
      await expect(service.create({ ...input, mentions })).rejects.toThrow(
        'partial delivery',
      );
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(1);
      fail = false;
      const row = await service.create({ ...input, mentions });
      await service.create({ ...input, mentions });
      const notifications = await db.query(
        'SELECT source_ref FROM user_notifications WHERE tenant_id = ?',
        tenantId,
      );
      expect(notifications.rows).toHaveLength(2);
      expect(
        notifications.rows.every(
          (n) => n.source_ref === `comments.mention:${row.id}`,
        ),
      ).toBe(true);
    });

    it.each([
      'edit',
      'delete',
    ] as const)('does not recreate a retained request after trusted %s', async (action) => {
      const { input, service, db } = await fixture();
      const row = await service.create(input);
      if (action === 'edit')
        await db.query(
          'UPDATE record_comments SET body = ? WHERE id = ?',
          'Edited',
          row.id,
        );
      else await db.query('DELETE FROM record_comments WHERE id = ?', row.id);
      await expect(service.create(input)).rejects.toMatchObject({
        code: 'COMMENT_REQUEST_UNAVAILABLE',
      });
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(action === 'edit' ? 1 : 0);
    });

    it('preserves caller transaction rollback or rejects unsupported nesting before mutation', async () => {
      const { input, db, service } = await fixture();
      await expect(
        db.transaction!(async (tx) => {
          const adapter = createCommentMentionNotifications({
            notifications: new UserNotificationService({ db: tx }),
            canNotify: async () => true,
          });
          await new CommentService({
            ...access,
            db: tx,
            mentionNotifications: adapter,
          }).create(input);
          throw new Error('caller rollback');
        }),
      ).rejects.toThrow(
        dialect === 'duckdb' ? /nested|savepoint/i : 'caller rollback',
      );
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            'SELECT claim_key FROM _smrt_run_once_claims WHERE tenant_id = ?',
            tenantId,
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            'SELECT id FROM user_notifications WHERE tenant_id = ?',
            tenantId,
          )
        ).rows,
      ).toHaveLength(0);
      await service.create(input);
      expect(
        await service.listForRecord(input.metaType, input.metaId),
      ).toHaveLength(1);
    });

    if (dialect !== 'duckdb')
      it('rolls back partial notification delivery with the caller transaction and retries', async () => {
        const { input, db, service } = await fixture();
        const secondRecipient = crypto.randomUUID();
        const attempt = (fail: boolean) =>
          db.transaction!(async (tx) => {
            const adapter = createCommentMentionNotifications({
              notifications: new UserNotificationService({ db: tx }),
              canNotify: async () => true,
            });
            return new CommentService({
              ...access,
              db: tx,
              mentionNotifications: {
                async notifyMention(mention) {
                  if (fail && mention.recipientUserId === secondRecipient)
                    throw new Error('second notification failed');
                  await adapter.notifyMention(mention);
                },
              },
            }).create({
              ...input,
              mentions: [mentionedUserId, secondRecipient],
            });
          });
        await expect(attempt(true)).rejects.toThrow(
          'second notification failed',
        );
        expect(
          await service.listForRecord(input.metaType, input.metaId),
        ).toHaveLength(0);
        expect(
          (
            await db.query(
              'SELECT id FROM user_notifications WHERE tenant_id = ?',
              tenantId,
            )
          ).rows,
        ).toHaveLength(0);
        const first = await attempt(false);
        expect((await attempt(false)).id).toBe(first.id);
        expect(
          (
            await db.query(
              'SELECT id FROM user_notifications WHERE tenant_id = ?',
              tenantId,
            )
          ).rows,
        ).toHaveLength(2);
      });

    if (dialect === 'postgres')
      it.each([
        'body',
        'author',
      ] as const)('keeps concurrent outer transactions usable after %s arbitration', async (kind) => {
        const { input, db, service } = await fixture();
        let conflicts = 0;
        const attempt = (body: string) =>
          db.transaction!(async (tx) => {
            const userId =
              kind === 'author' && body === 'B'
                ? mentionedUserId
                : authorUserId;
            const scoped = new CommentService({
              ...access,
              db: tx,
              actor: { tenantId, userId },
            });
            try {
              await scoped.create({
                ...input,
                authorUserId: userId,
                body: kind === 'body' ? body : input.body,
              });
            } catch (error) {
              expect(error).toMatchObject({ code: 'COMMENT_REQUEST_CONFLICT' });
              conflicts += 1;
            }
            expect((await tx.query('SELECT 17 AS proof')).rows[0].proof).toBe(
              17,
            );
          });
        await Promise.all([attempt('A'), attempt('B')]);
        expect(conflicts).toBe(1);
        expect(
          await service.listForRecord(input.metaType, input.metaId),
        ).toHaveLength(1);
      });
  });
});
