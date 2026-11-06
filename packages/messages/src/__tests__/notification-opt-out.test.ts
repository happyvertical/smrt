import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationOptOutCollection } from '../collections/NotificationOptOutCollection.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { isValidNotificationOptOutScope } from '../models/NotificationOptOut.js';
import {
  NotificationOptOutDeniedError,
  NotificationOptOutService,
  optOutSuppression,
} from '../services/NotificationOptOutService.js';
import {
  type NotificationEmailInput,
  NotificationOutboxService,
  type NotificationTransport,
} from '../services/NotificationOutboxService.js';

describe('NotificationOptOutService', () => {
  let db: DatabaseInterface;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const project = `project:${crypto.randomUUID()}`;
  const otherProject = `project:${crypto.randomUUID()}`;
  let service: NotificationOptOutService;

  const key = (overrides: Record<string, unknown> = {}) => ({
    tenantId: tenantA,
    recipientUserId: alice,
    channel: 'email' as const,
    scope: project,
    ...overrides,
  });

  async function rowsIn(tenantId: string) {
    return withTenant({ tenantId }, async () =>
      (await NotificationOptOutCollection.create({ db })).list({
        where: { tenantId },
      }),
    );
  }

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    service = new NotificationOptOutService({ db });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  it('opts out and in idempotently, keeping one row', async () => {
    expect(await service.isOptedOut(key())).toBe(false);
    const first = await service.optOut(key());
    const second = await service.optOut(key());
    expect(second.id).toBe(first.id);
    expect(second.optedOutAt?.getTime()).toBe(first.optedOutAt?.getTime());
    expect(await service.isOptedOut(key())).toBe(true);
    expect(await rowsIn(tenantA)).toHaveLength(1);

    await service.optIn(key());
    await service.optIn(key());
    expect(await service.isOptedOut(key())).toBe(false);
    expect(await rowsIn(tenantA)).toHaveLength(1);

    // Opting back out reuses the row.
    await service.optOut(key());
    expect(await service.isOptedOut(key())).toBe(true);
    expect(await rowsIn(tenantA)).toHaveLength(1);
  });

  it('opt-in with nothing recorded is a no-op that stores nothing', async () => {
    const view = await service.optIn(key());
    expect(view.isOptedOut).toBe(false);
    expect(await rowsIn(tenantA)).toHaveLength(0);
  });

  it('lets only the recipient change their row when a principal is given', async () => {
    await expect(
      service.optOut(key({ principal: { userId: bob, tenantId: tenantA } })),
    ).rejects.toMatchObject({
      name: 'NotificationOptOutDeniedError',
      reason: 'principal',
    });
    await expect(
      service.optIn(key({ principal: { userId: bob, tenantId: tenantA } })),
    ).rejects.toBeInstanceOf(NotificationOptOutDeniedError);
    expect(await rowsIn(tenantA)).toHaveLength(0);

    const row = await service.optOut(
      key({ principal: { userId: alice, tenantId: tenantA } }),
    );
    expect(row.updatedBy).toBe(alice);
    await expect(
      service.optIn(key({ principal: { userId: bob, tenantId: tenantA } })),
    ).rejects.toThrow(NotificationOptOutDeniedError);
    expect(await service.isOptedOut(key())).toBe(true);

    await expect(
      service.optOut(key({ principal: { userId: alice, tenantId: tenantB } })),
    ).rejects.toMatchObject({ reason: 'tenant' });
    // A principal without a tenant never chooses one: it cannot write or list
    // in a tenant it was not authenticated in (#4717 review).
    await expect(
      service.optOut(key({ principal: { userId: alice } as never })),
    ).rejects.toMatchObject({ reason: 'tenant' });
    await expect(
      service.listForRecipient({
        tenantId: tenantB,
        recipientUserId: alice,
        principal: { userId: alice } as never,
      }),
    ).rejects.toMatchObject({ reason: 'tenant' });
    expect(await rowsIn(tenantB)).toHaveLength(0);

    // Trusted host code (no principal) may change it.
    const trusted = await service.optIn(key());
    expect(trusted.updatedBy).toBe('system');
  });

  it('lists only the recipient own active opt-outs', async () => {
    await service.optOut(key());
    await service.optOut(key({ scope: otherProject }));
    await service.optOut(key({ recipientUserId: bob }));
    await service.optIn(key({ scope: otherProject }));

    const mine = await service.listForRecipient({
      tenantId: tenantA,
      recipientUserId: alice,
      principal: { userId: alice, tenantId: tenantA },
    });
    expect(mine.map((row) => row.scope)).toEqual([project]);
    expect(mine.every((row) => row.recipientUserId === alice)).toBe(true);

    await expect(
      service.listForRecipient({
        tenantId: tenantA,
        recipientUserId: alice,
        principal: { userId: bob, tenantId: tenantA },
      }),
    ).rejects.toBeInstanceOf(NotificationOptOutDeniedError);
    await expect(
      service.listForRecipient({
        tenantId: tenantA,
        recipientUserId: alice,
      } as never),
    ).rejects.toBeInstanceOf(NotificationOptOutDeniedError);
  });

  it('never leaks across tenants or recipients', async () => {
    await service.optOut(key());
    expect(await service.isOptedOut(key({ tenantId: tenantB }))).toBe(false);
    expect(await service.isOptedOut(key({ recipientUserId: bob }))).toBe(false);
    expect(await rowsIn(tenantB)).toHaveLength(0);

    await service.optOut(key({ tenantId: tenantB, scope: '*' }));
    expect(await service.isOptedOut(key())).toBe(true);
    await service.optIn(key({ tenantId: tenantB, scope: '*' }));
    expect(await service.isOptedOut(key({ tenantId: tenantB }))).toBe(false);
    expect(await service.isOptedOut(key())).toBe(true);
  });

  it('a * opt-out matches every scope', async () => {
    await service.optOut(key({ scope: '*' }));
    expect(await service.isOptedOut(key({ scope: project }))).toBe(true);
    expect(await service.isOptedOut(key({ scope: otherProject }))).toBe(true);
    expect(await service.isOptedOut(key({ scope: '*' }))).toBe(true);
    // A project row alone does not imply `*`.
    await service.optIn(key({ scope: '*' }));
    await service.optOut(key({ scope: project }));
    expect(await service.isOptedOut(key({ scope: '*' }))).toBe(false);
    expect(await service.isOptedOut(key({ scope: otherProject }))).toBe(false);
  });

  it('refuses malformed scopes and unknown channels', async () => {
    for (const scope of [
      '',
      'project',
      'Project:abc',
      'project:',
      'project: x',
      'project:a/b',
      ':abc',
      '**',
      `project:${'x'.repeat(201)}`,
    ]) {
      expect(isValidNotificationOptOutScope(scope)).toBe(false);
      await expect(service.optOut(key({ scope }))).rejects.toThrow(/scope/);
      await expect(service.isOptedOut(key({ scope }))).rejects.toThrow(/scope/);
    }
    expect(isValidNotificationOptOutScope('project:abc-1.2_3')).toBe(true);
    expect(isValidNotificationOptOutScope(`project:${'x'.repeat(200)}`)).toBe(
      true,
    );
    await expect(
      service.optOut(key({ channel: 'sms' as never })),
    ).rejects.toThrow(/channel/);
    expect(await rowsIn(tenantA)).toHaveLength(0);
  });

  describe('with the notification outbox', () => {
    let clock: Date;
    const senders: Record<string, string> = {};

    async function createSender(tenantId: string): Promise<string> {
      return withTenant({ tenantId }, async () => {
        const account = new EmailAccount({
          db,
          tenantId,
          name: 'Notifications',
          providerType: 'smtp',
          isActive: true,
        });
        await account.initialize();
        await account.save();
        return account.id as string;
      });
    }

    function outbox(transport: NotificationTransport) {
      return new NotificationOutboxService({
        db,
        linkBaseUrl: 'https://work.example.com',
        resolveRecipient: () => ({ address: 'alice@example.com' }),
        resolveSenderAccountId: ({ tenantId }) => senders[tenantId] ?? null,
        transport,
        now: () => clock,
        isSuppressed: optOutSuppression(service, (request) => {
          const match = /^(project:[^:]+):/.exec(request.sourceRef);
          return match?.[1] ?? null;
        }),
      });
    }

    function email(
      overrides: Partial<NotificationEmailInput> = {},
    ): NotificationEmailInput {
      return {
        tenantId: tenantA,
        recipientUserId: alice,
        sourceRef: `${project}:question:1`,
        kind: 'project-question.asked',
        subject: 'A question is waiting',
        text: 'Your project has a question.',
        path: '/portal/projects/p1/questions',
        ...overrides,
      };
    }

    function transport() {
      const calls: unknown[] = [];
      const t: NotificationTransport & { calls: unknown[] } = {
        name: 'fake',
        calls,
        async send(request) {
          calls.push(request);
          return { status: 'accepted', providerMessageId: 'p1' };
        },
      };
      return t;
    }

    beforeEach(async () => {
      clock = new Date('2026-11-05T12:00:00.000Z');
      senders[tenantA] = await createSender(tenantA);
      senders[tenantB] = await createSender(tenantB);
    });

    it('stores an enqueue suppressed by an existing opt-out as cancelled', async () => {
      const t = transport();
      const queue = outbox(t);
      await service.optOut(key());
      const { delivery } = await queue.enqueueEmail(email());
      expect(delivery.status).toBe('cancelled');

      // Another project, and a notification the host does not scope, still flow.
      const other = await queue.enqueueEmail(
        email({ sourceRef: `${otherProject}:question:1` }),
      );
      expect(other.delivery.status).toBe('pending');
      const unscoped = await queue.enqueueEmail(
        email({ sourceRef: 'digest:2026-11-05' }),
      );
      expect(unscoped.delivery.status).toBe('pending');
      expect(t.calls).toHaveLength(0);
    });

    it('cancels at dispatch a delivery enqueued before the opt-out', async () => {
      const t = transport();
      const queue = outbox(t);
      const { delivery } = await queue.enqueueEmail(email());
      expect(delivery.status).toBe('pending');

      await service.optOut(key());
      const report = await queue.dispatchDue({ tenantIds: [tenantA] });
      expect(report.outcomes.map((o) => o.outcome)).toEqual(['cancelled']);
      expect(t.calls).toHaveLength(0);
    });

    it('a tenant-wide opt-out suppresses and an opt-in resumes delivery', async () => {
      const t = transport();
      const queue = outbox(t);
      await service.optOut(key({ scope: '*' }));
      expect((await queue.enqueueEmail(email())).delivery.status).toBe(
        'cancelled',
      );
      await service.optIn(key({ scope: '*' }));
      const again = await queue.enqueueEmail(
        email({ sourceRef: `${project}:question:2` }),
      );
      expect(again.delivery.status).toBe('pending');
      expect((await queue.dispatchDue()).outcomes[0]?.outcome).toBe('sent');
    });

    it("another tenant's opt-out never suppresses this tenant", async () => {
      const t = transport();
      const queue = outbox(t);
      await service.optOut(key({ tenantId: tenantB, scope: '*' }));
      expect((await queue.enqueueEmail(email())).delivery.status).toBe(
        'pending',
      );
    });
  });
});
