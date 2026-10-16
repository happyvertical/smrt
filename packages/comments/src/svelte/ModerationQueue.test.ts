// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ModerationQueue from './ModerationQueue.svelte';

describe('ModerationQueue', () => {
  it('shows pending and reported projections and sends moderation actions', async () => {
    const onmoderate = vi.fn();
    render(ModerationQueue, {
      props: {
        comments: [
          {
            id: '1',
            body: 'Schedule',
            authorLabel: 'Worker',
            status: 'pending',
            reportCount: 2,
          },
        ],
        onmoderate,
      },
    });
    expect(screen.getByText(/2 reports/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onmoderate).toHaveBeenCalledWith('1', 'visible');
    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(onmoderate).toHaveBeenCalledWith('1', 'hidden');
  });
  it('keeps a failed moderation action actionable', async () => {
    render(ModerationQueue, {
      props: {
        comments: [
          {
            id: '1',
            body: 'Schedule',
            authorLabel: 'Worker',
            status: 'pending',
          },
        ],
        onmoderate: async () => {
          throw new Error('denied');
        },
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not update');
    expect(
      screen.getByRole('button', { name: 'Delete' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});
