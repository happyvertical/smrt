import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserNotificationCollection } from '../collections/UserNotificationCollection.js';
import sourceManifest from '../manifest/manifest.json';
import { UserNotificationService } from '../services/UserNotificationService.js';

describe('UserNotificationService', () => {
  let db: DatabaseInterface;
  let service: UserNotificationService;
  const tenantA = crypto.randomUUID();
  const tenantB = crypto.randomUUID();
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    service = new UserNotificationService({ db });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('dedupes on sourceRef per recipient without resetting read state', async () => {
    const input = {
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'social-post.failed',
      title: "A post to X didn't go out",
      href: '/sites/bentley/social-posts',
      severity: 'error' as const,
      sourceRef: 'social-post:p1:failed',
    };
    const first = await service.notify(input);
    expect(first.created).toBe(true);
    await service.markRead(alice, [first.notification.id as string], {
      tenantId: tenantA,
    });

    const again = await service.notify({ ...input, title: 'Changed' });
    expect(again.created).toBe(false);
    expect(again.notification.id).toBe(first.notification.id);
    expect(again.notification.title).toBe("A post to X didn't go out");
    expect(again.notification.readAt).toBeInstanceOf(Date);

    // Same event for another person is its own notification.
    const forBob = await service.notify({ ...input, recipientUserId: bob });
    expect(forBob.created).toBe(true);

    // No sourceRef: every call is new.
    const a = await service.notify({ ...input, sourceRef: undefined });
    const b = await service.notify({ ...input, sourceRef: undefined });
    expect(a.created && b.created).toBe(true);
    expect(a.notification.sourceRef).not.toBe(b.notification.sourceRef);
  });

  it('a notify that loses the dedupe race keeps the stored row and its read state', async () => {
    const input = {
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'render.failed',
      title: 'Original',
      sourceRef: 'render:r1:failed',
    };
    const first = await service.notify(input);
    await service.dismiss(alice, [first.notification.id as string], {
      tenantId: tenantA,
    });

    // Simulate the race: the pre-check runs before the winner's row is
    // visible, so this notify goes straight to its insert.
    const list = vi
      .spyOn(UserNotificationCollection.prototype, 'list')
      .mockResolvedValueOnce([]);
    let raced: Awaited<ReturnType<UserNotificationService['notify']>>;
    try {
      raced = await service.notify({ ...input, title: 'Loser' });
    } finally {
      list.mockRestore();
    }

    expect(raced.created).toBe(false);
    expect(raced.notification.id).toBe(first.notification.id);
    const [row] = await service.listForUser(alice, {
      tenantIds: [tenantA],
      includeDismissed: true,
    });
    expect(row.title).toBe('Original');
    expect(row.readAt).toBeInstanceOf(Date);
    expect(row.dismissedAt).toBeInstanceOf(Date);
  });

  it('ignores malformed ids when marking read or dismissing', async () => {
    const { notification } = await service.notify({
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'video.failed',
      title: 'One',
    });
    const find = vi.spyOn(UserNotificationCollection.prototype, 'list');
    try {
      expect(
        await service.markRead(alice, ['not-a-uuid', ''], {
          tenantId: tenantA,
        }),
      ).toBe(0);
      // Nothing valid to look up: no query at all.
      expect(find).not.toHaveBeenCalled();
      expect(
        await service.markRead(alice, ['bogus', notification.id as string], {
          tenantId: tenantA,
        }),
      ).toBe(1);
      const where = find.mock.calls.at(-1)?.[0]?.where as Record<
        string,
        unknown
      >;
      expect(where['id in']).toEqual([notification.id]);
    } finally {
      find.mockRestore();
    }
  });

  it('lists one recipient across tenants newest first and counts unread', async () => {
    await service.notify({
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'video.failed',
      title: 'Older',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
    });
    await service.notify({
      tenantId: tenantB,
      recipientUserId: alice,
      kind: 'video.failed',
      title: 'Newer',
      occurredAt: new Date('2026-09-02T00:00:00Z'),
    });
    await service.notify({
      tenantId: tenantA,
      recipientUserId: bob,
      kind: 'video.failed',
      title: "Bob's",
    });

    const list = await service.listForUser(alice, {
      tenantIds: [tenantA, tenantB],
    });
    expect(list.map((n) => n.title)).toEqual(['Newer', 'Older']);
    expect(
      await service.countUnread(alice, { tenantIds: [tenantA, tenantB] }),
    ).toBe(2);
    expect(
      (await service.listForUser(alice, { tenantIds: [tenantA] })).map(
        (n) => n.title,
      ),
    ).toEqual(['Older']);
    expect(
      await service.listForUser(alice, {
        tenantIds: [tenantA, tenantB],
        since: new Date('2026-09-01T12:00:00Z'),
      }),
    ).toHaveLength(1);
  });

  it("never changes another recipient's notifications", async () => {
    const { notification } = await service.notify({
      tenantId: tenantA,
      recipientUserId: bob,
      kind: 'x',
      title: "Bob's",
    });
    const id = notification.id as string;

    expect(await service.markRead(alice, [id], { tenantId: tenantA })).toBe(0);
    expect(await service.dismiss(alice, [id], { tenantId: tenantA })).toBe(0);
    expect(await service.markRead(bob, [id], { tenantId: tenantB })).toBe(0);

    const collection = await UserNotificationCollection.create({ db });
    const stored = await collection.get({ id });
    expect(stored?.readAt).toBeNull();
    expect(stored?.dismissedAt).toBeNull();
  });

  it('dismiss hides a notification and marks it read; markAllRead is counted', async () => {
    const one = await service.notify({
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'x',
      title: 'One',
    });
    await service.notify({
      tenantId: tenantA,
      recipientUserId: alice,
      kind: 'x',
      title: 'Two',
    });
    await service.notify({
      tenantId: tenantB,
      recipientUserId: alice,
      kind: 'x',
      title: 'Three',
    });

    expect(
      await service.dismiss(alice, [one.notification.id as string], {
        tenantId: tenantA,
      }),
    ).toBe(1);
    const visible = await service.listForUser(alice, {
      tenantIds: [tenantA, tenantB],
    });
    expect(visible.map((n) => n.title).sort()).toEqual(['Three', 'Two']);
    const all = await service.listForUser(alice, {
      tenantIds: [tenantA],
      includeDismissed: true,
    });
    expect(all.find((n) => n.title === 'One')?.readAt).toBeInstanceOf(Date);

    expect(
      await service.markAllRead(alice, { tenantIds: [tenantA, tenantB] }),
    ).toBe(2);
    expect(
      await service.markAllRead(alice, { tenantIds: [tenantA, tenantB] }),
    ).toBe(0);
    expect(
      await service.countUnread(alice, { tenantIds: [tenantA, tenantB] }),
    ).toBe(0);
    expect(
      await service.listForUser(alice, {
        tenantIds: [tenantA, tenantB],
        unreadOnly: true,
      }),
    ).toEqual([]);
  });

  it('rejects incomplete input', async () => {
    await expect(
      service.notify({
        tenantId: tenantA,
        recipientUserId: '',
        kind: 'x',
        title: 'No one',
      }),
    ).rejects.toThrow('recipient');
    await expect(
      service.notify({
        tenantId: tenantA,
        recipientUserId: alice,
        kind: 'x',
        title: 'Bad',
        severity: 'loud' as never,
      }),
    ).rejects.toThrow("Unknown notification severity 'loud'");
  });
});

describe('UserNotification schema', () => {
  it('is tenant-scoped with a uuid recipient and a dedupe identity', () => {
    const recipient = ObjectRegistry.getRelationships('UserNotification').find(
      (relationship) => relationship.fieldName === 'recipientUserId',
    );
    expect(recipient?.type).toBe('crossPackageRef');
    expect(recipient?.targetClass).toBe('@happyvertical/smrt-users:User');

    const objects = sourceManifest.objects as Record<
      string,
      { fields?: Record<string, unknown>; schema?: { tableName?: string } }
    >;
    const entry = objects['@happyvertical/smrt-messages:UserNotification'];
    expect(entry?.fields).toHaveProperty('sourceRef');
    expect(entry?.fields).toHaveProperty('readAt');
    expect(entry?.fields).toHaveProperty('dismissedAt');
  });
});
