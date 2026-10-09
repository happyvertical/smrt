import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
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
    const { container } = render(NotificationBell, { props: { provider } });
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(await screen.findByText('Mention')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(provider.markRead).toHaveBeenCalledWith('n1');
    await expectNoA11yViolations(container);
  });
});

function provider() {
  return {
    getUnreadCount: vi.fn().mockResolvedValue(1),
    list: vi
      .fn()
      .mockResolvedValue([
        { id: 'one', title: 'Current actor', occurredAt: '2026-01-01' },
      ]),
    markRead: vi.fn().mockResolvedValue(undefined),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn((_listener: () => void) => vi.fn()),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('clears old actor data and ignores pending old reads after switching provider', async () => {
  const old = provider();
  const pending = deferred<unknown[]>();
  old.list.mockReturnValue(pending.promise);
  const next = provider();
  const view = render(NotificationBell, { provider: old });
  await userEvent.click(screen.getByRole('button', { name: /Notifications/ }));
  await view.rerender({ provider: next });
  expect(await screen.findByText('Current actor')).toBeInTheDocument();
  pending.resolve([
    { id: 'old', title: 'Private old actor', occurredAt: '2026-01-01' },
  ]);
  await new Promise((done) => setTimeout(done, 0));
  expect(screen.queryByText('Private old actor')).not.toBeInTheDocument();
  expect(old.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
});

it('ignores late events and pending mutations after disposal', async () => {
  const source = provider();
  const pending = deferred<void>();
  source.markAllRead.mockReturnValue(pending.promise);
  const view = render(NotificationBell, { provider: source });
  await userEvent.click(screen.getByRole('button', { name: /Notifications/ }));
  await screen.findByText('Current actor');
  await userEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
  view.unmount();
  const calls = source.list.mock.calls.length;
  pending.resolve();
  source.subscribe.mock.calls[0][0]();
  await new Promise((done) => setTimeout(done, 0));
  expect(source.list).toHaveBeenCalledTimes(calls);
});

it('refreshes live updates, supports mark all and Escape, and exposes failures', async () => {
  const source = provider();
  render(NotificationBell, { provider: source });
  await userEvent.click(screen.getByRole('button', { name: /Notifications/ }));
  await screen.findByText('Current actor');
  source.list.mockResolvedValue([]);
  source.getUnreadCount.mockResolvedValue(0);
  source.subscribe.mock.calls[0][0]();
  expect(await screen.findByText('No notifications.')).toBeInTheDocument();
  source.list.mockRejectedValue(new Error('offline'));
  source.subscribe.mock.calls[0][0]();
  expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
  await userEvent.click(screen.getByRole('dialog'));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('blocks executable links and presents mutation errors', async () => {
  const source = provider();
  source.list.mockResolvedValue([
    {
      id: 'one',
      title: 'Unsafe',
      occurredAt: '2026-01-01',
      href: 'javascript:alert(1)',
    },
  ]);
  source.markRead.mockRejectedValue(new Error('denied'));
  render(NotificationBell, { provider: source });
  await userEvent.click(screen.getByRole('button', { name: /Notifications/ }));
  await screen.findByText('Unsafe');
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mark read' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not mark');
});
