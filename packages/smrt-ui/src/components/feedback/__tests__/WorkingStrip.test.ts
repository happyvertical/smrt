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
});
