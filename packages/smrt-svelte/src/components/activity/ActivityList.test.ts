import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ActivityItem from '../workspace/admin-shell/ActivityItem.svelte';
import { ADMIN_SHELL_CONTEXT } from '../workspace/admin-shell/context.js';
import { createShellState } from '../workspace/admin-shell/state.svelte.js';
import ActivityList from './ActivityList.svelte';
import { safeActivityHref } from './safe-href.js';
import { formatActivityTimestamp } from './time.js';
import type { ActivityListEntry } from './types.js';

const NOW = Date.parse('2026-11-26T20:00:00.000Z');

describe('formatActivityTimestamp & safeActivityHref', () => {
  it('formats relative intervals and preserves ISO + localized tooltip metadata', () => {
    const justNow = formatActivityTimestamp('2026-11-26T19:59:40.000Z', {
      locale: 'en-US',
      now: NOW,
    });
    expect(justNow).toMatchObject({
      datetime: '2026-11-26T19:59:40.000Z',
      label: 'just now',
    });
    expect(justNow?.title).toContain('2026-11-26T19:59:40.000Z');

    const minutesAgo = formatActivityTimestamp('2026-11-26T19:55:00.000Z', {
      locale: 'en-US',
      now: NOW,
    });
    expect(minutesAgo?.label).toMatch(/5 min\. ago/);

    const hoursAgo = formatActivityTimestamp('2026-11-26T17:00:00.000Z', {
      locale: 'en-US',
      now: NOW,
    });
    expect(hoursAgo?.label).toMatch(/3 hr\. ago/);

    const sameDayAfterNoon = formatActivityTimestamp('2026-11-26', {
      locale: 'en-US',
      timeZone: 'UTC',
      now: NOW,
    });
    expect(sameDayAfterNoon).toMatchObject({
      datetime: '2026-11-26',
      label: 'today',
    });

    const calendar = formatActivityTimestamp('2026-11-25', {
      locale: 'en-US',
      timeZone: 'UTC',
      now: NOW,
    });
    expect(calendar).toMatchObject({
      datetime: '2026-11-25',
      label: 'yesterday',
    });

    const newYorkEvening = formatActivityTimestamp('2026-11-26', {
      locale: 'en-US',
      timeZone: 'America/New_York',
      now: Date.parse('2026-11-27T02:00:00.000Z'),
    });
    expect(newYorkEvening).toMatchObject({
      datetime: '2026-11-26',
      label: 'today',
    });

    // Out-of-range finite epochs fall back deterministically instead of throwing RangeError.
    expect(
      formatActivityTimestamp('2026-11-26', {
        locale: 'en-US',
        timeZone: 'UTC',
        now: 1e20,
      }),
    ).toMatchObject({
      datetime: '2026-11-26',
      label: 'Nov 26, 2026',
    });
    expect(
      formatActivityTimestamp('2026-11-26T19:00:00.000Z', {
        locale: 'en-US',
        timeZone: 'UTC',
        now: -1e20,
      }),
    ).toMatchObject({
      datetime: '2026-11-26T19:00:00.000Z',
    });

    // Unparseable dates and invalid locales never throw.
    expect(
      formatActivityTimestamp('not-a-real-date', {
        locale: 'not a valid locale',
        now: NOW,
      }),
    ).toEqual({
      title: 'not-a-real-date',
      label: 'not-a-real-date',
    });
    expect(formatActivityTimestamp('')).toBeNull();
  });

  it('never reads ambient Date.now() or host timezone when now or timeZone are omitted', () => {
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(Date.parse('2026-11-26T19:00:10.000Z'))
      .mockReturnValueOnce(Date.parse('2026-11-26T22:00:00.000Z'));

    try {
      const first = formatActivityTimestamp('2026-11-26T19:00:00.000Z', {
        locale: 'en-US',
      });
      const second = formatActivityTimestamp('2026-11-26T19:00:00.000Z', {
        locale: 'en-US',
        timeZone: 'Invalid/Zone',
      });
      expect(spy).not.toHaveBeenCalled();
      expect(first).toEqual(second);
      expect(first?.title).toContain('7:00 PM');
      expect(first?.label).toContain('7:00 PM');

      const tokyo = formatActivityTimestamp('2026-11-26T19:00:00.000Z', {
        locale: 'en-US',
        timeZone: 'Asia/Tokyo',
        now: NOW,
      });
      expect(tokyo?.label).toMatch(/1 hr\. ago/);
      expect(tokyo?.title).toContain('Nov 27, 2026');

      // Offset-bearing timestamps parse identically to their UTC instant;
      // offset-free datetime strings render literally without host-TZ parsing.
      const offsetExplicit = formatActivityTimestamp(
        '2026-11-26T14:00:00-05:00',
        {
          locale: 'en-US',
          timeZone: 'UTC',
          now: NOW,
        },
      );
      expect(offsetExplicit).toMatchObject({
        datetime: '2026-11-26T19:00:00.000Z',
      });
      expect(offsetExplicit?.label).toMatch(/1 hr\. ago/);

      expect(
        formatActivityTimestamp('2026-11-26T19:00:00', {
          locale: 'en-US',
          timeZone: 'America/New_York',
          now: NOW,
        }),
      ).toEqual({
        title: '2026-11-26T19:00:00',
        label: '2026-11-26T19:00:00',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts safe local and http(s) links while rejecting unsafe schemes and control characters', () => {
    expect(safeActivityHref('/app/projects/123')).toBe('/app/projects/123');
    expect(safeActivityHref(' https://example.com/item ')).toBe(
      'https://example.com/item',
    );
    expect(safeActivityHref('javascript:alert(1)')).toBeUndefined();
    expect(safeActivityHref('//evil.example/path')).toBeUndefined();
    expect(safeActivityHref('/bad\\path')).toBeUndefined();
    expect(safeActivityHref('/bad\u0000path')).toBeUndefined();
    expect(safeActivityHref(null)).toBeUndefined();
  });
});

describe('ActivityItem', () => {
  it('renders background shell job status, relative createdAt, and non-wrapping actions', async () => {
    const cancel = vi.fn();
    const { container } = render(ActivityItem, {
      props: {
        now: NOW,
        activity: {
          id: 'job-1',
          label: 'Syncing repository index with a very long job description',
          message: 'Processing batch 4 of 10',
          kind: 'sync',
          scope: 'system',
          status: 'running',
          progress: 40,
          createdAt: '2026-11-26T19:50:00.000Z',
          detailHref: '/jobs/job-1',
          cancel,
        },
      },
    });

    expect(screen.getByText('running')).toBeInTheDocument();
    const timeEl = container.querySelector('time');
    expect(timeEl).toHaveAttribute('datetime', '2026-11-26T19:50:00.000Z');
    expect(timeEl?.getAttribute('title')).toContain('2026-11-26T19:50:00.000Z');
    expect(timeEl).toHaveTextContent(/10 min\. ago/);

    const viewLink = screen.getByRole('link', { name: 'View' });
    expect(viewLink).toHaveAttribute('href', '/jobs/job-1');
    const actions = container.querySelector('.smrt-activity-item__actions');
    expect(actions).not.toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
  });
});

describe('ActivityList', () => {
  it('binds only its authorized entries and leaves shell activities untouched on disposal', async () => {
    const shell = createShellState();
    shell.upsertActivity({
      id: 'other',
      label: 'Other feed',
      kind: 'audit',
      scope: 'system',
      status: 'completed',
    });
    const context = new Map([[ADMIN_SHELL_CONTEXT, shell]]);
    const view = render(ActivityList, {
      props: {
        now: NOW,
        entries: [
          {
            id: 'one',
            title: 'Authorized action',
            occurredAt: '2026-01-01',
            href: 'javascript:alert(1)',
          },
        ],
      },
      context,
    });
    expect(await screen.findByText('Authorized action')).toBeInTheDocument();
    expect(screen.queryByText('Other feed')).not.toBeInTheDocument();
    // Feed entries never stamp or display hardcoded "completed" status.
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    await view.rerender({ entries: [], now: NOW });
    expect(screen.queryByText('Authorized action')).not.toBeInTheDocument();
    expect(await screen.findByText('No activity.')).toBeInTheDocument();
    view.unmount();
    expect(shell.listActivities().map((entry) => entry.id)).toEqual(['other']);
  });

  it('renders standalone without AdminShell context and displays enriched row metadata safely', async () => {
    const entries: ActivityListEntry[] = [
      {
        id: 'sup-1',
        title: 'Billing webhook signature mismatch on retry',
        detail: 'Customer reported 401 on webhook delivery endpoint.',
        occurredAt: '2026-11-26T19:45:00.000Z',
        href: '/app/support/sup-1',
        source: 'support',
        sourceLabel: 'Support',
        code: 'SUP-MWXXEDHA',
        context: { label: 'Core Platform', href: '/app/projects/p1' },
        status: { label: 'Needs triage', tone: 'warning' },
        meta: 'Assigned to Alex',
      },
      {
        id: 'sec-1',
        title: 'Entry with unsafe context link',
        occurredAt: '2026-11-26T18:00:00.000Z',
        source: 'projects',
        sourceLabel: 'Projects',
        code: 'HVP-1',
        context: { label: 'Untrusted Link', href: 'javascript:alert(1)' },
        status: { label: 'Open', tone: 'primary' },
      },
    ];

    const { container } = render(ActivityList, {
      props: { entries, now: NOW },
    });

    expect(
      container.querySelector('[data-smrt-part="source"]'),
    ).toHaveTextContent('Support');
    expect(screen.getByText('SUP-MWXXEDHA')).toBeInTheDocument();
    expect(
      screen.getByText('Billing webhook signature mismatch on retry'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Customer reported 401 on webhook delivery endpoint.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Needs triage')).toBeInTheDocument();
    expect(screen.getByText('Assigned to Alex')).toBeInTheDocument();

    const contextLink = screen.getByRole('link', { name: 'Core Platform' });
    expect(contextLink).toHaveAttribute('href', '/app/projects/p1');

    // Unsafe context.href degrades to plain span, never an anchor.
    expect(
      screen.queryByRole('link', { name: 'Untrusted Link' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Untrusted Link')).toBeInTheDocument();

    const viewLink = screen.getByRole('link', { name: 'View' });
    expect(viewLink).toHaveAttribute('href', '/app/support/sup-1');

    await expectNoA11yViolations(container);
  });

  it('supports source filtering, per-item & bulk dismissal, undo, show/hide dismissed, restore, and caught-up state', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onDismissMany = vi.fn();
    const onRestore = vi.fn();
    const onUndo = vi.fn();
    const onToggleShowDismissed = vi.fn();

    const baseEntries: ActivityListEntry[] = [
      {
        id: 'e1',
        title: 'New support ticket',
        occurredAt: '2026-11-26T19:58:00.000Z',
        source: 'support',
        sourceLabel: 'Support',
      },
      {
        id: 'e2',
        title: 'Project milestone updated',
        occurredAt: '2026-11-26T19:30:00.000Z',
        source: 'projects',
        sourceLabel: 'Projects',
      },
      {
        id: 'e3',
        title: 'Archived alert',
        occurredAt: '2026-11-26T16:00:00.000Z',
        source: 'support',
        sourceLabel: 'Support',
        dismissed: true,
      },
    ];

    const view = render(ActivityList, {
      props: {
        entries: baseEntries,
        now: NOW,
        onDismiss,
        onDismissMany,
        onRestore,
        canUndo: true,
        onUndo,
        dismissedCount: 1,
        showDismissed: false,
        onToggleShowDismissed,
      },
    });

    // Source filter pills render when 2+ distinct sources exist.
    const filterGroup = screen.getByRole('group', {
      name: 'Filter activity by source',
    });
    expect(
      within(filterGroup).getByRole('button', { name: 'All' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // Dismissed item is hidden while showDismissed is false.
    expect(screen.queryByText('Archived alert')).not.toBeInTheDocument();

    // Filter to Support only, then click "Dismiss visible" -> only visible unread IDs for Support ('e1') are sent!
    await user.click(
      within(filterGroup).getByRole('button', { name: 'Support' }),
    );
    expect(screen.getByText('New support ticket')).toBeInTheDocument();
    expect(
      screen.queryByText('Project milestone updated'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss visible' }));
    expect(onDismissMany).toHaveBeenCalledWith(['e1']);

    // Per-item dismiss carries accessible item-specific label.
    await user.click(
      screen.getByRole('button', { name: 'Dismiss New support ticket' }),
    );
    expect(onDismiss).toHaveBeenCalledWith('e1');

    // Undo and Show dismissed (1) invoke their callbacks.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);

    await user.click(
      screen.getByRole('button', { name: 'Show dismissed (1)' }),
    );
    expect(onToggleShowDismissed).toHaveBeenCalledTimes(1);

    // Rerender with showDismissed: true to verify dimmed dismissed row + Restore button.
    await view.rerender({
      entries: baseEntries,
      now: NOW,
      onDismiss,
      onDismissMany,
      onRestore,
      canUndo: false,
      onUndo,
      dismissedCount: 1,
      showDismissed: true,
      onToggleShowDismissed,
    });

    expect(screen.getByText('Archived alert')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Hide dismissed (1)' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await user.click(
      screen.getByRole('button', { name: 'Restore Archived alert' }),
    );
    expect(onRestore).toHaveBeenCalledWith('e3');
    await expectNoA11yViolations(view.container);

    // Rerender with all items dismissed and showDismissed: false -> caught-up empty state!
    await view.rerender({
      entries: baseEntries.map((entry) => ({ ...entry, dismissed: true })),
      now: NOW,
      onDismiss,
      onDismissMany,
      onRestore,
      canUndo: true,
      onUndo,
      dismissedCount: 3,
      showDismissed: false,
      onToggleShowDismissed,
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      "You're all caught up.",
    );
    expect(
      screen.queryByRole('button', { name: 'Dismiss visible' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show dismissed (3)' }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(view.container);
  });

  it('deduplicates entries with colliding ids instead of crashing keyed rendering', () => {
    render(ActivityList, {
      props: {
        now: NOW,
        entries: [
          {
            id: 'dup-id',
            title: 'First copy wins',
            occurredAt: '2026-11-26T19:50:00.000Z',
          },
          {
            id: 'dup-id',
            title: 'Duplicate copy dropped',
            occurredAt: '2026-11-26T19:55:00.000Z',
          },
        ],
      },
    });
    expect(screen.getByText('First copy wins')).toBeInTheDocument();
    expect(
      screen.queryByText('Duplicate copy dropped'),
    ).not.toBeInTheDocument();
  });
});
