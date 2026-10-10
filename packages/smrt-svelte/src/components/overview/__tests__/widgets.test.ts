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
    await expectNoA11yViolations(container);
  });
});
