import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ToastViewport from '../ToastViewport.svelte';
import { createToaster } from '../toast.js';

describe('toast', () => {
  it('publishes, acts on, and dismisses notifications', async () => {
    const toaster = createToaster();
    const action = vi.fn();
    render(ToastViewport, { props: { toaster } });
    toaster.show({
      message: 'Draft restored',
      duration: 0,
      action: { label: 'Undo', run: action },
    });
    expect(await screen.findByText('Draft restored')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Draft restored')).not.toBeInTheDocument();
  });

  it('provides success and error conveniences', () => {
    const toaster = createToaster();
    const seen: string[] = [];
    toaster.subscribe((toasts) =>
      seen.push(...toasts.map((toast) => toast.variant)),
    );
    toaster.success('Saved', { duration: 0 });
    toaster.error('Failed', { duration: 0 });
    expect(seen).toEqual(expect.arrayContaining(['success', 'error']));
  });

  it('restarts dismissal timing when a toast id is reused', () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster();
      let visibleIds: string[] = [];
      toaster.subscribe((toasts) => {
        visibleIds = toasts.map((toast) => toast.id);
      });

      toaster.show({ id: 'saving', message: 'Saving', duration: 1000 });
      vi.advanceTimersByTime(500);
      toaster.show({ id: 'saving', message: 'Still saving', duration: 1000 });
      vi.advanceTimersByTime(500);

      expect(visibleIds).toEqual(['saving']);
      vi.advanceTimersByTime(500);
      expect(visibleIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
