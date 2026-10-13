import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { cleanup, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeOverview } from '../model.js';
import { createWidgetRegistry } from '../registry.js';
import type { OverviewDefinition } from '../types.js';
import ChartWidget from '../widgets/ChartWidget.svelte';
import {
  CHART_OPTIONS_VERSION,
  createChartWidget,
  migrateChartOptions,
} from '../widgets/core.js';

afterEach(cleanup);

const base = {
  id: 'w1',
  options: {},
  span: 2,
  title: 'Sales',
  locale: 'en-US',
};
const data = {
  points: [
    { label: 'Mon', value: 30 },
    { label: 'Tue', value: 60 },
    { label: 'Wed', value: 90 },
  ],
};
const draw = (style: string, over: Record<string, unknown> = {}) =>
  render(ChartWidget, {
    props: { ...base, options: { style }, data, ...over },
  });

describe('chart widget styles (#3888)', () => {
  it('table draws a visible table with tabular figures', async () => {
    const { container } = draw('table');
    const table = screen.getByRole('table', { name: 'Chart data' });
    expect(within(table).getByRole('rowheader', { name: 'Tue' })).toBeTruthy();
    expect(within(table).getByRole('cell', { name: '60' })).toBeTruthy();
    expect(table.className).toContain('smrt-chart__data');
    await expectNoA11yViolations(container);
  });

  it('pie draws a donut with a legend and a hidden data table', async () => {
    const { container } = draw('pie');
    expect(
      screen.getByRole('img', { name: /Chart with 3 values/ }),
    ).toBeTruthy();
    expect(container.querySelectorAll('circle.smrt-chart__slice')).toHaveLength(
      3,
    );
    // Shares: 30/180, 60/180, 90/180 of a 100-long path.
    const dashes = [...container.querySelectorAll('circle')].map((c) =>
      Number.parseFloat(c.getAttribute('stroke-dasharray') ?? ''),
    );
    expect(dashes[0]).toBeCloseTo(16.67, 1);
    expect(dashes[2]).toBeCloseTo(50, 1);
    // Legend lists value and share; the table is there for assistive tech.
    expect(
      container.querySelector('.smrt-chart__legend')?.textContent,
    ).toContain('60 · 33.3%');
    expect(
      screen.getByRole('table', { name: 'Chart data', hidden: true }),
    ).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('pie with nothing positive shows the empty state', () => {
    render(ChartWidget, {
      props: {
        ...base,
        options: { style: 'pie' },
        data: { points: [{ label: 'a', value: 0 }] },
      },
    });
    expect(screen.getByText('Nothing to show yet.')).toBeTruthy();
  });

  it('stat shows the latest value and its derived change', async () => {
    const { container } = draw('stat');
    expect(screen.getByText('90')).toBeTruthy();
    expect(screen.getByText('Wed')).toBeTruthy();
    // 60 -> 90 is +50%.
    expect(screen.getByText(/Up 50% from the previous period/)).toBeTruthy();
    await expectNoA11yViolations(container);
  });

  it('stat prefers an explicit delta and hides a zero change', () => {
    draw('stat', { data: { ...data, delta: -12.5 } });
    expect(
      screen.getByText(/Down 1[23](\.5)?% from the previous period/),
    ).toBeTruthy();
    cleanup();
    draw('stat', { data: { ...data, delta: 0 } });
    expect(screen.queryByText(/previous period/)).toBeNull();
  });

  it('an unknown style falls back to bars', () => {
    const { container } = draw('radar');
    expect(container.querySelector('.smrt-chart__bars')).toBeTruthy();
  });
});

describe('chart option schema v2 (#3888)', () => {
  const definition: OverviewDefinition = { id: 'p', defaults: [] };
  const registry = createWidgetRegistry();
  registry.register(createChartWidget(() => data));
  const run = (version: number | undefined, style: string) =>
    sanitizeOverview(
      {
        widgets: [
          {
            id: 'c',
            type: 'chart',
            span: 2,
            options: { model: 'events:Event', style },
            ...(version === undefined ? {} : { version }),
          },
        ],
      },
      { registry, definition },
    );

  it('registers the new styles at the current version', () => {
    expect(registry.get('chart')?.version).toBe(CHART_OPTIONS_VERSION);
    const style = registry.get('chart')?.options.find((f) => f.key === 'style');
    expect(style?.choices?.map((c) => c.value)).toEqual([
      'bar',
      'line',
      'table',
      'pie',
      'stat',
    ]);
  });

  it('still validates options saved at v1 (and unversioned)', () => {
    for (const version of [undefined, 1]) {
      for (const style of ['bar', 'line']) {
        const { document, issues } = run(version, style);
        expect(issues).toEqual([]);
        expect(document.widgets[0]).toMatchObject({
          version: CHART_OPTIONS_VERSION,
          options: { style },
        });
      }
    }
  });

  it('accepts the new styles at v2 and rejects an unknown one', () => {
    for (const style of ['table', 'pie', 'stat']) {
      expect(run(2, style).issues).toEqual([]);
    }
    expect(run(2, 'radar').issues[0]).toMatchObject({
      code: 'invalid_options',
      options: [{ key: 'style', code: 'not_in_choices' }],
    });
  });

  it('migration carries v1 options over unchanged and refuses other versions', () => {
    const options = { model: 'a:B', style: 'line', period: '7d' };
    expect(migrateChartOptions(options, 1)).toEqual(options);
    expect(migrateChartOptions(options, 0)).toBeNull();
    expect(migrateChartOptions(options, CHART_OPTIONS_VERSION)).toBeNull();
  });
});
