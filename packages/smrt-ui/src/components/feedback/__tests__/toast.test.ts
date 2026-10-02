import { act, fireEvent, render, screen } from '@testing-library/svelte';
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

describe('toast dismissal interactions', () => {
  it('preserves the remaining duration until every pause reason clears', () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster();
      let visible = 0;
      toaster.subscribe((toasts) => {
        visible = toasts.length;
      });
      const id = toaster.show({ message: 'Saved', duration: 1000 });
      vi.advanceTimersByTime(300);
      toaster.pause?.(id, 'hover');
      toaster.pause?.(id, 'focus');
      vi.advanceTimersByTime(5000);
      expect(visible).toBe(1);
      toaster.resume?.(id, 'hover');
      vi.advanceTimersByTime(5000);
      expect(visible).toBe(1);
      toaster.resume?.(id, 'focus');
      toaster.resume?.(id, 'focus');
      vi.advanceTimersByTime(699);
      expect(visible).toBe(1);
      vi.advanceTimersByTime(1);
      expect(visible).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replacing a paused id resets its duration without losing interaction pause', () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster();
      let message = '';
      toaster.subscribe((toasts) => {
        message = toasts[0]?.message ?? '';
      });
      toaster.show({ id: 'save', message: 'Saving', duration: 1000 });
      toaster.pause?.('save', 'hover');
      toaster.show({ id: 'save', message: 'Saved', duration: 2000 });
      vi.advanceTimersByTime(5000);
      expect(message).toBe('Saved');
      toaster.resume?.('save', 'hover');
      vi.advanceTimersByTime(1999);
      expect(message).toBe('Saved');
      vi.advanceTimersByTime(1);
      expect(message).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('can keep success notifications persistent while other notifications expire', () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster({ successDuration: 0, duration: 1000 });
      let messages: string[] = [];
      toaster.subscribe((toasts) => {
        messages = toasts.map((toast) => toast.message);
      });
      const id = toaster.success('Only record of approval');
      toaster.show('Temporary');
      toaster.success('Explicit duration wins', { duration: 500 });
      vi.advanceTimersByTime(10000);
      expect(messages).toEqual(['Only record of approval']);
      toaster.dismiss(id);
      expect(messages).toEqual([]);
      toaster.show('Cleared');
      toaster.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('viewport hover and focus pause independently, including focus movement within a toast', async () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster();
      render(ToastViewport, { props: { toaster } });
      await act(() => {
        toaster.show({
          message: 'Stay visible',
          duration: 1000,
          action: { label: 'Undo', run: () => {} },
        });
      });
      const group = screen.getByRole('group', { name: 'Notification' });
      await fireEvent.mouseEnter(group);
      await fireEvent.focusIn(screen.getByRole('button', { name: 'Undo' }));
      await fireEvent.mouseLeave(group);
      await fireEvent.focusOut(screen.getByRole('button', { name: 'Undo' }), {
        relatedTarget: screen.getByRole('button', { name: 'Dismiss' }),
      });
      await act(() => vi.advanceTimersByTime(5000));
      expect(screen.getByText('Stay visible')).toBeInTheDocument();
      await fireEvent.focusOut(group, { relatedTarget: document.body });
      await act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText('Stay visible')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases its interaction pauses when the viewport unmounts', async () => {
    vi.useFakeTimers();
    try {
      const toaster = createToaster();
      let count = 0;
      toaster.subscribe((toasts) => {
        count = toasts.length;
      });
      const { unmount } = render(ToastViewport, { props: { toaster } });
      await act(() => {
        toaster.show({ message: 'Paused', duration: 1000 });
      });
      await fireEvent.mouseEnter(
        screen.getByRole('group', { name: 'Notification' }),
      );
      await act(() => vi.advanceTimersByTime(5000));
      expect(count).toBe(1);
      await unmount();
      vi.advanceTimersByTime(1000);
      expect(count).toBe(0);
      expect(document.querySelector('.viewport')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains compatibility with injected toasters without pause/resume methods', async () => {
    const legacy = { ...createToaster(), pause: undefined, resume: undefined };
    const { unmount } = render(ToastViewport, { props: { toaster: legacy } });
    legacy.success('Legacy', { duration: 0 });
    const group = await screen.findByRole('group', { name: 'Notification' });
    await fireEvent.mouseEnter(group);
    await fireEvent.mouseLeave(group);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    await unmount();
    expect(document.querySelector('.viewport')).toBeNull();
  });
});
