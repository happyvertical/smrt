import { describe, expect, it, vi } from 'vitest';
import { createUserNotificationBellProvider } from './notifications';

describe('createUserNotificationBellProvider', () => {
  it('closes the recipient and tenant scope over bell reads and writes', async () => {
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant-a',
      title: 'Mention',
      body: '',
      href: null,
      severity: 'info',
      occurredAt: new Date('2026-01-01'),
      readAt: null,
    };
    const service = {
      countUnread: vi.fn().mockResolvedValue(1),
      listForUser: vi.fn().mockResolvedValue([row]),
      markRead: vi.fn().mockResolvedValue(1),
      markAllRead: vi.fn().mockResolvedValue(1),
    };
    const provider = createUserNotificationBellProvider({
      service: service as never,
      userId: 'user-a',
      tenantIds: ['tenant-a'],
    });
    expect(await provider.getUnreadCount()).toBe(1);
    expect(await provider.list()).toEqual([
      expect.objectContaining({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
      }),
    ]);
    await provider.markRead(row.id);
    expect(service.markRead).toHaveBeenCalledWith('user-a', [row.id], {
      tenantId: 'tenant-a',
    });
  });
  it('rejects a provider that lacks an authorized tenant scope', () => {
    expect(() =>
      createUserNotificationBellProvider({
        service: {} as never,
        userId: 'user-a',
        tenantIds: [],
      }),
    ).toThrow('tenant ids');
  });
});

it('refuses unloaded writes and propagates upstream failures without emitting success', async () => {
  const service = {
    markRead: vi.fn(),
    markAllRead: vi.fn().mockRejectedValue(new Error('denied')),
    countUnread: vi.fn().mockRejectedValue(new Error('offline')),
  };
  const provider = createUserNotificationBellProvider({
    service: service as never,
    userId: 'a',
    tenantIds: ['t'],
  });
  const listener = vi.fn();
  const stop = provider.subscribe(listener);
  await expect(provider.markRead('foreign')).rejects.toThrow('loaded');
  expect(service.markRead).not.toHaveBeenCalled();
  await expect(provider.markAllRead()).rejects.toThrow('denied');
  await expect(provider.getUnreadCount()).rejects.toThrow('offline');
  expect(listener).not.toHaveBeenCalled();
  stop();
});
