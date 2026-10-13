import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ChartWidget from '../widgets/ChartWidget.svelte';
import MetricWidget from '../widgets/MetricWidget.svelte';
import NoteWidget from '../widgets/NoteWidget.svelte';
import RecordListWidget from '../widgets/RecordListWidget.svelte';
import ShortcutsWidget from '../widgets/ShortcutsWidget.svelte';

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
});
