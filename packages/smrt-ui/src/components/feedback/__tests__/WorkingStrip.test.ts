import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WorkingStrip from '../WorkingStrip.svelte';

describe('WorkingStrip', () => {
  it('renders nothing but an empty live region while idle', () => {
    const { container } = render(WorkingStrip, {
      props: { status: { phase: 'idle', label: null } },
    });
    expect(screen.queryByTestId('working-strip')).toBeNull();
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent?.trim()).toBe('');
  });

  it('announces the status and reopens the surface from the strip', async () => {
    const onopen = vi.fn();
    const onstop = vi.fn();
    const { container } = render(WorkingStrip, {
      props: {
        status: { phase: 'working', label: 'Writing the summary' },
        canStop: true,
        onopen,
        onstop,
        openLabel: 'Open the assistant',
      },
    });
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent,
    ).toContain('Writing the summary');
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Writing the summary. Open the assistant',
      }),
    );
    expect(onopen).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onstop).toHaveBeenCalledTimes(1);
  });

  it('falls back to default labels and hides Stop unless it can stop', () => {
    render(WorkingStrip, {
      props: { status: { phase: 'working', label: null } },
    });
    expect(screen.getByTestId('working-strip').textContent).toContain(
      'Working…',
    );
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('shows Done without a spinner or Stop', () => {
    const { container } = render(WorkingStrip, {
      props: {
        status: { phase: 'done', label: null },
        canStop: true,
        variant: 'inline',
      },
    });
    const strip = screen.getByTestId('working-strip');
    expect(strip).toHaveAttribute('data-phase', 'done');
    expect(strip.textContent).toContain('Done');
    expect(container.querySelector('.working-strip__spinner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('goes green with a check once done, red with a cross once failed', () => {
    const { rerender } = render(WorkingStrip, {
      props: {
        status: { phase: 'done', label: null, goal: 'Show me meetings' },
        variant: 'floating',
      },
    });
    const strip = screen.getByTestId('working-strip');
    expect(strip).toHaveAttribute('data-phase', 'done');
    expect(strip.textContent).toContain('Show me meetings');
    expect(strip.textContent).toContain('✓');
    rerender({
      status: { phase: 'failed', label: null, goal: 'Show me meetings' },
      variant: 'floating',
    });
    expect(screen.getByTestId('working-strip')).toHaveAttribute(
      'data-phase',
      'failed',
    );
    expect(screen.getByTestId('working-strip').textContent).toContain(
      "Couldn't finish",
    );
  });

  it('offers Pause while working, Continue while paused, and Esc pauses', async () => {
    const onpause = vi.fn();
    const onresume = vi.fn();
    const onstop = vi.fn();
    const { rerender } = render(WorkingStrip, {
      props: {
        status: { phase: 'working', label: 'Opening Events' },
        variant: 'floating',
        canStop: true,
        onpause,
        onresume,
        onstop,
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onpause).toHaveBeenCalledTimes(1);
    screen.getByRole('button', { name: 'Pause' }).focus();
    await userEvent.keyboard('{Escape}');
    expect(onpause).toHaveBeenCalledTimes(2);

    rerender({
      status: { phase: 'paused', label: null },
      variant: 'floating',
      canStop: true,
      onpause,
      onresume,
      onstop,
    });
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onresume).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onstop).toHaveBeenCalledTimes(1);
  });

  it('asks for the person assertively while waiting, with Review', async () => {
    const onreview = vi.fn();
    const { container } = render(WorkingStrip, {
      props: {
        status: {
          phase: 'waiting',
          label: 'A change is ready for you',
          goal: 'Fill the event form',
        },
        variant: 'floating',
        onreview,
      },
    });
    expect(
      container.querySelector('[aria-live="assertive"]')?.textContent,
    ).toContain('A change is ready for you');
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent?.trim(),
    ).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onreview).toHaveBeenCalledTimes(1);
  });

  it('never takes focus by itself', async () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    const { rerender } = render(WorkingStrip, {
      props: {
        status: { phase: 'working', label: 'Step one' },
        variant: 'floating',
        onpause: vi.fn(),
        onopen: vi.fn(),
      },
    });
    rerender({
      status: { phase: 'waiting', label: 'Your turn' },
      variant: 'floating',
      onreview: vi.fn(),
      onopen: vi.fn(),
    });
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('throttles polite step announcements', async () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(WorkingStrip, {
        props: {
          status: { phase: 'working', label: 'Step one' },
          announceIntervalMs: 2000,
        },
      });
      const live = () =>
        container.querySelector('[aria-live="polite"]')?.textContent?.trim();
      expect(live()).toBe('Step one');
      await rerender({
        status: { phase: 'working', label: 'Step two' },
        announceIntervalMs: 2000,
      });
      await rerender({
        status: { phase: 'working', label: 'Step three' },
        announceIntervalMs: 2000,
      });
      expect(live()).toBe('Step one');
      await vi.advanceTimersByTimeAsync(2000);
      expect(live()).toBe('Step three');
    } finally {
      vi.useRealTimers();
    }
  });
});
