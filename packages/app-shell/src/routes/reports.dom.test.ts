import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { description } from '../test/draft-fixtures.ts';
import { report, result } from '../test/report-fixtures.ts';
import ReportsPage from './reports/+page.svelte';
import ReportPage from './reports/[name]/+page.svelte';

vi.mock('$app/navigation', () => ({ invalidate: vi.fn(async () => {}) }));
let container: HTMLDivElement;
let component: ReturnType<typeof mount>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  if (component) unmount(component);
  container.remove();
  vi.unstubAllGlobals();
});
const data = () => ({
  description: { ...description(), reports: { sales: report } },
  name: 'sales',
  report,
  result,
  problem: '',
  target: 'draft' as const,
});
it.each([
  'chart',
  'table',
  'empty',
  'truncated',
  'error',
])('renders report %s', async (state) => {
  const d = data();
  if (state === 'table') d.result = { ...result, chart: { type: 'table' } };
  if (state === 'empty') d.result = { ...result, rows: [], rowCount: 0 };
  if (state === 'truncated') d.result = { ...result, truncated: true };
  if (state === 'error') d.problem = 'This report took too long.';
  component = mount(ReportPage, {
    target: container,
    props: { data: d } as never,
  });
  await tick();
  expect(container.textContent).toContain(
    'Count of records from Customers, grouped by Name',
  );
  expect(container.querySelector('a[href$="csv?target=draft"]')).toBeTruthy();
  if (state === 'chart') {
    expect(
      container.querySelector('[data-smrt-component="Chart"]') ??
        container.querySelector('svg'),
    ).toBeTruthy();
    expect(container.textContent).toContain('Acme Ltd');
  }
  if (state === 'table')
    expect(container.querySelector('td a')?.getAttribute('href')).toBe(
      '/m/Customer/c1',
    );
  if (state === 'empty')
    expect(container.textContent).toContain('No matching records');
  if (state === 'truncated') {
    expect(container.textContent).toContain('Showing only the first rows');
    expect(container.textContent?.toLowerCase()).not.toContain('bounded');
    expect(
      container.querySelector('a[href$="csv?target=draft"]')?.textContent,
    ).toBe('Download the rows shown as CSV');
    expect(
      container
        .querySelector('a[href$="csv?target=draft"]')
        ?.getAttribute('aria-describedby'),
    ).toBe('report-csv-sample');
    expect(
      container.querySelector('#report-csv-sample')?.textContent,
    ).toContain('only the rows shown here');
  }
  if (state === 'error')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      d.problem,
    );
});
it('lists reports and sends structural changes to the explicit draft', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}')),
  );
  component = mount(ReportsPage, {
    target: container,
    props: { data: data() } as never,
  });
  await tick();
  expect(container.querySelector('a[href="/reports/sales"]')).toBeTruthy();
  [...container.querySelectorAll('button')]
    .find((b) => b.textContent === 'Rename')
    ?.click();
  await tick();
  container
    .querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      '/api/shell/reports/sales?target=draft',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'rename', label: report.label }),
      }),
    ),
  );
});

it('names rename and remove actions by each report title', async () => {
  const base = data();
  const d = {
    ...base,
    description: {
      ...base.description,
      reports: {
        sales: report,
        other: { ...report, label: 'Outstanding invoices' },
      },
    },
  };
  component = mount(ReportsPage, {
    target: container,
    props: { data: d } as never,
  });
  await tick();
  for (const title of ['Sales by customer', 'Outstanding invoices']) {
    expect(
      container.querySelector(`button[aria-label="Rename ${title}"]`),
    ).toBeTruthy();
    expect(
      container.querySelector(`button[aria-label="Remove ${title}"]`),
    ).toBeTruthy();
  }
});

it.each([
  ['JPY', 0, 1000],
  ['USD', 3, 1234],
  ['CAD', 2, 1250],
] as const)('shows %s scale %i in report figures and chart values', async (currency, scale, minor) => {
  const d = data();
  d.result = {
    ...result,
    columns: [
      {
        id: 'amount',
        label: 'Amount',
        role: 'measure',
        type: 'integer',
        format: 'money',
        money: { currency, scale },
      },
    ],
    rows: [{ amount: minor }],
    rowCount: 1,
    chart: { type: 'stat', y: ['amount'] },
  };
  component = mount(ReportPage, {
    target: container,
    props: { data: d } as never,
  });
  await tick();
  const text = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(minor / 10 ** scale);
  expect(container.querySelector('dd')?.textContent).toBe(text);
  expect(
    container.querySelector('[data-smrt-component="Chart"]')?.textContent,
  ).toContain(text);
});

it.each([
  [
    'count',
    'integer',
    [3333, 3333, 3334],
    ['10,000', '3,333.33', '3,334'],
    ['4K', '2K', '0'],
    '3,334',
  ],
  [
    'sum',
    'decimal',
    [12345.678, 1, 0],
    ['12,346.68', '4,115.56', '12,345.68'],
    ['20K', '10K', '0'],
    '12,345.68',
  ],
  [
    'avg',
    'decimal',
    [12345.678, 1, 0],
    ['4,115.56', '12,345.68'],
    ['20K', '10K', '0'],
    '12,345.68',
  ],
] as const)('keeps the original non-money %s figures, chart values and compact axes', async (fn, type, values, figures, ticks, peak) => {
  const d = data();
  d.report = {
    ...report,
    spec: {
      ...report.spec,
      measures: [
        { fn, ...(fn === 'count' ? {} : { field: 'amount' }), as: 'total' },
      ],
      chart: { type: 'line', x: 'customer', y: ['total'] },
    },
  };
  d.result = {
    ...result,
    columns: [
      { id: 'customer', label: 'Customer', role: 'dimension', type: 'string' },
      { id: 'total', label: 'Total', role: 'measure', type },
    ],
    rows: values.map((total, i) => ({
      customer: ['Acme', 'North', 'West'][i],
      total,
    })),
    rowCount: 3,
    chart: d.report.spec.chart,
  };
  component = mount(ReportPage, {
    target: container,
    props: { data: d } as never,
  });
  await tick();
  expect(
    [...container.querySelectorAll('dd')].map((el) => el.textContent),
  ).toEqual(figures);
  expect(
    [...container.querySelectorAll('[data-smrt-part="scale"] span')].map(
      (el) => el.textContent,
    ),
  ).toEqual(ticks);
  expect(
    container.querySelector('[data-smrt-component="Chart"]')?.textContent,
  ).toContain(peak);
});
