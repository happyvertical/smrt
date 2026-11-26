import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  formatActivityTimestamp as formatFromOverview,
  safeActivityHref as safeHrefFromOverview,
} from '../index.js';
import { loadOverview } from '../load.js';
import { defineOverview, resolveOverview } from '../model.js';
import { createWidgetRegistry } from '../registry.js';
import {
  formatActivityTimestamp as formatFromServer,
  safeActivityHref as safeHrefFromServer,
} from '../server.js';
import ActivityWidget from '../widgets/ActivityWidget.svelte';
import ChartWidget from '../widgets/ChartWidget.svelte';
import { registerCoreWidgets } from '../widgets/core.js';
import MetricWidget from '../widgets/MetricWidget.svelte';
import NoteWidget from '../widgets/NoteWidget.svelte';
import RecordListWidget from '../widgets/RecordListWidget.svelte';
import ShortcutsWidget from '../widgets/ShortcutsWidget.svelte';
import OverviewHarness from './overview-harness.svelte';

const base = { id: 'w1', options: {}, span: 1, title: 'T', locale: 'en-US' };
const junk: unknown[] = [
  undefined,
  null,
  7,
  'x',
  [],
  { value: 'NaN', points: 5, rows: {}, items: 'no' },
  {
    points: [
      null,
      { label: 1, value: 'a' },
      { label: 'ok', value: Number.POSITIVE_INFINITY },
    ],
  },
  {
    rows: [null, 3, { title: 5 }],
    items: [{ label: 'x', href: 'javascript:1' }],
  },
];

describe('core widget components', () => {
  it('survive any data shape without throwing', () => {
    for (const data of junk) {
      for (const Component of [
        ActivityWidget,
        MetricWidget,
        ChartWidget,
        RecordListWidget,
        ShortcutsWidget,
      ]) {
        const { unmount } = render(Component as never, {
          props: { ...base, data },
        });
        unmount();
      }
    }
  });

  it('metric formats money from minor units and states the change', () => {
    render(MetricWidget, {
      props: {
        ...base,
        data: {
          value: 125050,
          format: 'money',
          currency: 'USD',
          label: 'Revenue',
          change: -4,
        },
      },
    });
    expect(screen.getByText('$1,250.50')).toBeInTheDocument();
    expect(screen.getByText('Revenue')).toBeInTheDocument();
    expect(
      screen.getByText(/Down 4% from the previous period/),
    ).toBeInTheDocument();
  });

  it('a line chart carries its numbers as a table; bars carry them inline', async () => {
    const data = {
      points: [
        { label: 'Mon', value: 3 },
        { label: 'Tue', value: 9 },
      ],
    };
    const line = render(ChartWidget, {
      props: { ...base, options: { style: 'line' }, data },
    });
    expect(
      screen.getByRole('img', { name: /Chart with 2 values/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'Chart data', hidden: true }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(line.container);
    line.unmount();
    const bars = render(ChartWidget, { props: { ...base, data } });
    expect(screen.getByText('9')).toBeInTheDocument();
    await expectNoA11yViolations(bars.container);
  });

  it('note never produces markup from the source', () => {
    const { container } = render(NoteWidget, {
      props: {
        ...base,
        options: {
          body: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) **b**',
        },
      },
    });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('strong')?.textContent).toBe('b');
  });

  it('shortcuts draws a card per safe item', async () => {
    const { container } = render(ShortcutsWidget, {
      props: {
        ...base,
        data: {
          items: [
            {
              id: 'a',
              label: 'Events',
              href: '/events',
              icon: 'calendar',
              description: 'All events',
            },
          ],
        },
      },
    });
    expect(screen.getByRole('link', { name: /Events/ })).toHaveAttribute(
      'href',
      '/events',
    );
    const heading = container.querySelector('.smrt-shortcuts__heading');
    expect(heading?.querySelector('.smrt-shortcuts__icon')).toBeInTheDocument();
    expect(heading?.querySelector('.smrt-shortcuts__title')).toHaveTextContent(
      'Events',
    );
    expect(heading?.nextElementSibling).toHaveTextContent('All events');
    await expectNoA11yViolations(container);
  });

  it('records render a table of cells with a totals footer and one View all', async () => {
    const { container } = render(RecordListWidget, {
      props: {
        ...base,
        title: 'Orders',
        options: { columns: 'number,status,issuedAt,totalAmount' },
        data: {
          rows: [
            {
              id: 'o1',
              title: 'GRA-3159',
              href: '/orders/o1',
              cells: {
                number: 'GRA-3159',
                status: 'paid',
                issuedAt: '2025-02-07T12:00:00.000Z',
                totalAmount: 489000,
              },
            },
            {
              id: 'o2',
              title: 'GRA-3160',
              cells: { number: 'GRA-3160', status: 'draft', totalAmount: 1050 },
            },
          ],
          columns: [
            { key: 'number', label: 'Number', role: 'identifier' },
            { key: 'status', label: 'Status', role: 'status' },
            { key: 'issuedAt', label: 'Issued', role: 'date' },
            { key: 'totalAmount', label: 'Total', role: 'money' },
          ],
          href: '/orders?customer=c1',
        },
      },
    });
    expect(
      screen.getByRole('columnheader', { name: 'Issued' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'GRA-3159' })).toHaveAttribute(
      'href',
      '/orders/o1',
    );
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Feb 7, 2025')).toBeInTheDocument();
    const foot = container.querySelector('tfoot');
    expect(foot).toHaveTextContent('2 in total');
    expect(foot).toHaveTextContent('$4,900.50');
    expect(screen.getAllByRole('link', { name: 'View all' })).toHaveLength(1);
    await expectNoA11yViolations(container);
  });

  it('records leave a partial page unsummed unless the host sends totals', () => {
    const data = {
      rows: [{ id: 'o1', title: 'A', cells: { amount: 100 } }],
      columns: [{ key: 'amount', label: 'Amount', role: 'money' }],
      total: 6,
    };
    const first = render(RecordListWidget, {
      props: { ...base, options: { columns: 'amount' }, data },
    });
    expect(first.container.querySelector('tfoot')).not.toHaveTextContent(
      '$1.00',
    );
    first.unmount();
    const second = render(RecordListWidget, {
      props: {
        ...base,
        options: { columns: 'amount' },
        data: { ...data, summaries: { amount: 60000 } },
      },
    });
    expect(second.container.querySelector('tfoot')).toHaveTextContent(
      '$600.00',
    );
    second.unmount();
    const off = render(RecordListWidget, {
      props: {
        ...base,
        options: { columns: 'amount', summaries: false },
        data,
      },
    });
    expect(off.container.querySelector('tfoot')).toBeNull();
  });

  it('records without columns keep the title list', () => {
    const { container } = render(RecordListWidget, {
      props: { ...base, data: { rows: [{ id: 'a', title: 'Plain' }] } },
    });
    expect(container.querySelector('table')).toBeNull();
    expect(screen.getByText('Plain')).toBeInTheDocument();
  });

  it('shortcuts show a plural-aware record count with tabular figures', () => {
    render(ShortcutsWidget, {
      props: {
        ...base,
        data: {
          items: [
            { id: 'a', label: 'Orders', href: '/orders/', count: 1234 },
            { id: 'b', label: 'Notes', href: '/notes/', count: 1 },
            { id: 'c', label: 'Empty', href: '/empty/', count: 0 },
            { id: 'd', label: 'Unknown', href: '/unknown/' },
          ],
        },
      },
    });
    expect(screen.getByText('1,234 records')).toBeTruthy();
    expect(screen.getByText('1 record')).toBeTruthy();
    expect(screen.getByText('0 records')).toBeTruthy();
    expect(document.querySelectorAll('.smrt-shortcuts__count')).toHaveLength(3);
  });

  it('shortcuts keep the heading row to icon and title, with the count in the foot (#4120)', () => {
    const { container } = render(ShortcutsWidget, {
      props: {
        ...base,
        data: {
          items: [
            {
              id: 'a',
              label: 'Equipment',
              href: '/equipment/',
              icon: 'box',
              description: 'The machines you hire out.',
              count: 8,
            },
            { id: 'b', label: 'Suppliers', href: '/suppliers/', count: 5 },
          ],
        },
      },
    });
    const links = container.querySelectorAll('.smrt-shortcuts__link');
    expect(links).toHaveLength(2);
    for (const link of links) {
      const heading = link.querySelector('.smrt-shortcuts__heading');
      expect(
        Array.from(heading?.children ?? [], (node) => node.className),
      ).toEqual([
        expect.stringContaining('smrt-shortcuts__icon'),
        expect.stringContaining('smrt-shortcuts__title'),
      ]);
      expect(heading?.querySelector('.smrt-shortcuts__count')).toBeNull();
      // The count is the link's last row: under the description when there
      // is one, otherwise directly under the title.
      const foot = link.lastElementChild;
      expect(foot).toHaveClass('smrt-shortcuts__foot');
      expect(foot?.querySelector('.smrt-shortcuts__count')).not.toBeNull();
    }
    const [first, second] = links;
    expect(first.children[1]).toHaveClass('smrt-shortcuts__desc');
    expect(first.querySelector('.smrt-shortcuts__foot')).toHaveTextContent(
      '8 records',
    );
    expect(second.children[1]).toHaveClass('smrt-shortcuts__foot');
    expect(second.querySelector('.smrt-shortcuts__foot')).toHaveTextContent(
      '5 records',
    );
  });

  it('shortcuts show a long title in full and leave out the foot with no count', () => {
    const long = 'Equipment and parts orders awaiting supplier confirmation';
    const { container } = render(ShortcutsWidget, {
      props: {
        ...base,
        data: { items: [{ id: 'a', label: long, href: '/orders/' }] },
      },
    });
    expect(container.querySelector('.smrt-shortcuts__title')).toHaveTextContent(
      long,
    );
    expect(screen.getByRole('link', { name: long })).toBeInTheDocument();
    expect(container.querySelector('.smrt-shortcuts__foot')).toBeNull();
  });

  it('shortcuts drop the per-entry frame under plain presentation', () => {
    render(ShortcutsWidget, {
      props: {
        ...base,
        presentation: 'plain',
        data: { items: [{ id: 'a', label: 'Orders', href: '/orders/' }] },
      },
    });
    expect(
      document
        .querySelector('[data-smrt-component="ShortcutsWidget"]')
        ?.getAttribute('data-presentation'),
    ).toBe('plain');
  });

  it('registers activity in registerCoreWidgets and forwards enriched entries and dismissal controls', async () => {
    const registry = createWidgetRegistry();
    registerCoreWidgets(registry, {
      activity: () => ({ entries: [] }),
    });
    expect(registry.get('activity')).toMatchObject({
      type: 'activity',
      defaultSpan: 4,
    });

    const seededRegistry = createWidgetRegistry();
    registerCoreWidgets(seededRegistry, { activity: true });
    expect(seededRegistry.get('activity')?.load).toBeUndefined();

    const onDismiss = vi.fn();
    const { container } = render(ActivityWidget, {
      props: {
        ...base,
        span: 4,
        options: { limit: 1 },
        data: {
          entries: [
            {
              id: 'act-1',
              title: 'Ticket triaged',
              detail: 'Escalated to platform engineering',
              occurredAt: '2026-11-26T19:50:00.000Z',
              href: '/app/support/act-1',
              source: 'support',
              sourceLabel: 'Support',
              code: 'SUP-101',
              context: { label: 'Platform', href: '/app/projects/platform' },
              status: { label: 'Triaged', tone: 'success' },
              meta: '2 comments',
            },
            {
              id: 'act-2',
              title: 'Clipped by limit option',
              occurredAt: '2026-11-26T18:00:00.000Z',
            },
          ],
          onDismiss,
        },
      },
    });

    expect(screen.getByText('Ticket triaged')).toBeInTheDocument();
    expect(screen.getByText('SUP-101')).toBeInTheDocument();
    expect(screen.getByText('Triaged')).toBeInTheDocument();
    expect(
      screen.queryByText('Clipped by limit option'),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss Ticket triaged' }),
    );
    expect(onDismiss).toHaveBeenCalledWith('act-1');
    await expectNoA11yViolations(container);
  });

  it('re-exports safeActivityHref and formatActivityTimestamp on overview and overview/server', () => {
    expect(safeHrefFromServer).toBe(safeHrefFromOverview);
    expect(formatFromServer).toBe(formatFromOverview);
    expect(safeHrefFromServer('javascript:alert(1)')).toBeUndefined();
    expect(safeHrefFromServer('/app/activity')).toBe('/app/activity');
    expect(
      formatFromServer('2026-11-26T19:59:30.000Z', {
        now: Date.parse('2026-11-26T20:00:00.000Z'),
      })?.label,
    ).toBe('just now');
  });

  it('activity widget resolves duplicate and generated-id collisions without crashing or corrupting callback ids', async () => {
    const onDismiss = vi.fn();
    render(ActivityWidget, {
      props: {
        ...base,
        span: 4,
        data: {
          entries: [
            // Missing id must not take '0' because a later item explicitly owns '0'.
            {
              title: 'Missing id entry',
              occurredAt: '2026-11-26T19:50:00.000Z',
            },
            {
              id: '0',
              title: 'Explicit zero id entry',
              occurredAt: '2026-11-26T19:49:00.000Z',
            },
            {
              id: 'dup',
              title: 'First duplicate kept',
              occurredAt: '2026-11-26T19:48:00.000Z',
            },
            {
              id: 'dup',
              title: 'Second duplicate dropped',
              occurredAt: '2026-11-26T19:47:00.000Z',
            },
          ] as never,
          onDismiss,
        },
      },
    });

    expect(screen.getByText('Missing id entry')).toBeInTheDocument();
    expect(screen.getByText('Explicit zero id entry')).toBeInTheDocument();
    expect(screen.getByText('First duplicate kept')).toBeInTheDocument();
    expect(
      screen.queryByText('Second duplicate dropped'),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss Explicit zero id entry' }),
    );
    expect(onDismiss).toHaveBeenCalledWith('0');

    await userEvent.click(
      screen.getByRole('button', { name: 'Dismiss First duplicate kept' }),
    );
    expect(onDismiss).toHaveBeenCalledWith('dup');
  });

  it('preserves identical relative timestamp label and timezone tooltip from loadOverview across clock drift', async () => {
    const registry = createWidgetRegistry();
    registerCoreWidgets(registry, {
      activity: () => ({
        entries: [
          {
            id: 'a1',
            title: 'Threshold boundary event',
            occurredAt: '2026-11-26T19:00:00.000Z',
          },
        ],
      }),
    });
    const definition = defineOverview({
      id: 'work.home',
      allowed: ['activity'],
      defaults: [{ id: 'act', type: 'activity', span: 4, options: {} }],
    });
    const resolved = resolveOverview(definition, null, registry);

    // Server load runs 30s after occurredAt ('just now') with explicit America/New_York zone.
    const serverNow = Date.parse('2026-11-26T19:00:30.000Z');
    const loaded = await loadOverview(resolved.document, definition, registry, {
      now: serverNow,
      timeZone: 'America/New_York',
    });

    // Simulate client hydrating 5 minutes later with a drifted system clock.
    const spy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-11-26T19:05:30.000Z'));
    try {
      const { container } = render(OverviewHarness, {
        props: {
          options: { definition, registry, loaded },
        },
      });
      const timeEl = container.querySelector('time');
      expect(timeEl).toHaveTextContent('just now');
      expect(timeEl?.getAttribute('title')).toContain('2:00 PM');
      expect(timeEl?.getAttribute('title')).toContain(
        '2026-11-26T19:00:00.000Z',
      );
    } finally {
      spy.mockRestore();
    }
  });
});
