import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NotificationBell from './NotificationBell.svelte';

describe('NotificationBell', () => {
  it('shows provider-backed unread items and marks one read', async () => {
    const user = userEvent.setup();
    const provider = {
      getUnreadCount: vi.fn().mockResolvedValue(1),
      list: vi
        .fn()
        .mockResolvedValue([
          { id: 'n1', title: 'Mention', occurredAt: '2026-01-01T00:00:00Z' },
        ]),
      markRead: vi.fn().mockResolvedValue(undefined),
      markAllRead: vi.fn().mockResolvedValue(undefined),
    };
    render(NotificationBell, { props: { provider } });
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('Mention')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(provider.markRead).toHaveBeenCalledWith('n1');
  });
});
