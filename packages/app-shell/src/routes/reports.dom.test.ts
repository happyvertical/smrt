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
    expect(container.textContent?.toLowerCase()).toContain('bounded sample');
    expect(
      container.querySelector('a[href$="csv?target=draft"]')?.textContent,
    ).toBe('Download bounded sample CSV');
    expect(
      container
        .querySelector('a[href$="csv?target=draft"]')
        ?.getAttribute('aria-describedby'),
    ).toBe('report-csv-sample');
    expect(
      container.querySelector('#report-csv-sample')?.textContent,
    ).toContain('same capped sample');
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
