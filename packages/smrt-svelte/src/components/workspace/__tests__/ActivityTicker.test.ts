import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import ActivityTicker from '../admin-shell/ActivityTicker.svelte';
import type { ShellActivity } from '../admin-shell/types.js';

function activity(
  id: string,
  status: ShellActivity['status'] = 'running',
  progress?: number,
): ShellActivity {
  return {
    id,
    label: `Process ${id}`,
    status,
    scope: 'system',
    kind: 'job',
    progress,
  };
}
describe('ActivityTicker', () => {
  it('optionally includes queued work with an accurate label and excludes terminal work', () => {
    render(ActivityTicker, {
      props: {
        activities: [
          activity('waiting', 'queued', 50),
          activity('active'),
          activity('done', 'completed'),
        ],
        statuses: ['queued', 'running'],
        label: 'Active processes',
      },
    });
    expect(
      screen.getAllByRole('listitem').map((item) => item.textContent),
    ).toEqual(['Queued · Process waiting', 'Process active']);
    expect(
      screen.getByRole('region', { name: 'Active processes' }),
    ).not.toHaveTextContent('Process done');
  });
  it('uses an honest empty state and never promotes queued/terminal/unknown activity to running', () => {
    const { container } = render(ActivityTicker, {
      props: {
        activities: [
          'queued',
          'completed',
          'failed',
          'canceled',
          'unknown',
        ].map((status) => activity(status, status as ShellActivity['status'])),
      },
    });
    expect(
      screen.getByRole('region', { name: 'Running processes' }),
    ).toHaveTextContent('No active processes');
    expect(container.querySelector('.smrt-activity-ticker__track')).toBeNull();
  });
  it('keeps a single running process static with bounded progress', () => {
    const { container } = render(ActivityTicker, {
      props: { activities: [activity('one', 'running', 42.4)] },
    });
    expect(screen.getByRole('listitem')).toHaveTextContent('Process one · 42%');
    expect(container.querySelector('.multiple')).toBeNull();
    expect(container.querySelector('.smrt-activity-ticker__copy')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it.each([
    NaN,
    Infinity,
    -1,
    101,
  ])('does not claim invalid progress %s', (progress) => {
    render(ActivityTicker, {
      props: { activities: [activity('one', 'running', progress)] },
    });
    expect(screen.getByRole('listitem')).toHaveTextContent('Process one');
    expect(screen.getByRole('listitem').textContent).not.toContain('%');
  });
  it('duplicates only visual text and offers a persistent keyboard pause', async () => {
    const user = userEvent.setup();
    const { container } = render(ActivityTicker, {
      props: { activities: [activity('one'), activity('two')] },
    });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      container.querySelector('.smrt-activity-ticker__track'),
    ).toHaveAttribute('aria-hidden', 'true');
    expect(
      container.querySelector('.smrt-activity-ticker__copy'),
    ).not.toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Pause scrolling activities' }),
    );
    expect(container.querySelector('.smrt-activity-ticker')).toHaveClass(
      'paused',
    );
    await user.click(
      screen.getByRole('button', { name: 'Resume scrolling activities' }),
    );
    expect(container.querySelector('.smrt-activity-ticker')).not.toHaveClass(
      'paused',
    );
  });
  it('reacts when actual activities start and finish', async () => {
    const { rerender, container } = render(ActivityTicker, {
      props: { activities: [activity('one')] },
    });
    await rerender({ activities: [activity('one'), activity('two')] });
    expect(container.querySelector('.multiple')).not.toBeNull();
    await rerender({
      activities: [activity('one', 'completed'), activity('two', 'failed')],
    });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('region')).toHaveTextContent('No active processes');
  });
  it('renders supplied labels as text and is axe-clean', async () => {
    const { container } = render(ActivityTicker, {
      props: {
        label: 'Active work',
        activities: [
          { ...activity('one'), label: '<script>private()</script>' },
          activity('two'),
        ],
      },
    });
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent(
      '<script>private()</script>',
    );
    await expectNoA11yViolations(container);
  });
});
