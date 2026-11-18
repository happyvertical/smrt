// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { result, spec } from '../preview-data.js';
import ReportResult from '../ReportResult.svelte';
import type { RuntimeReportResult, RuntimeReportSpec } from '../types.js';

afterEach(cleanup);

// Expected strings verified against c8f4972c87, before host-owned money formatting.
it.each([
  {
    fn: 'count',
    type: 'integer',
    values: [3333, 3333, 3334],
    figures: ['10,000', '3,333.33', '3,334'],
    ticks: ['4K', '2K', '0'],
    cells: ['3,333', '3,333', '3,334'],
  },
  {
    fn: 'sum',
    type: 'decimal',
    values: [12345.678, 1, 0],
    figures: ['12,346.68', '4,115.56', '12,345.68'],
    ticks: ['20K', '10K', '0'],
    cells: ['12,345.68', '1', '0'],
  },
  {
    fn: 'avg',
    type: 'decimal',
    values: [12345.678, 1, 0],
    figures: ['4,115.56', '12,345.68'],
    ticks: ['20K', '10K', '0'],
    cells: ['12,345.68', '1', '0'],
  },
] as const)('preserves $fn formatting in figures, axes and readouts with a host cell formatter', ({
  fn,
  type,
  values,
  figures,
  ticks,
  cells,
}) => {
  const report: RuntimeReportSpec = {
    ...spec,
    measures: [
      { fn, ...(fn === 'count' ? {} : { field: 'amount' }), as: 'total' },
    ],
    chart: { type: 'line', x: 'region', y: ['total'] },
  };
  const output: RuntimeReportResult = {
    ...result,
    columns: [
      { id: 'region', label: 'Region', role: 'dimension', type: 'string' },
      { id: 'total', label: 'Total', role: 'measure', type },
    ],
    rows: values.map((total, i) => ({
      region: ['West', 'East', 'North'][i],
      total,
    })),
    rowCount: 3,
    chart: report.chart,
  };
  // The shell supplies this behavior for ordinary non-money cells.
  const formatCell = vi.fn((value: unknown) => String(value));
  const full = render(ReportResult, {
    result: output,
    spec: report,
    variant: 'full',
    locale: 'en-US',
    formatCell,
  });
  expect(
    [...full.container.querySelectorAll('dd')].map((el) => el.textContent),
  ).toEqual(figures);
  expect(
    [...full.container.querySelectorAll('[data-smrt-part="scale"] span')].map(
      (el) => el.textContent,
    ),
  ).toEqual(ticks);
  expect(
    [
      ...full.container.querySelectorAll('[data-smrt-component="Chart"] td'),
    ].map((el) => el.textContent),
  ).toEqual(cells);
  expect(
    formatCell.mock.calls.every(([value]) => typeof value === 'string'),
  ).toBe(true);
  cleanup();
  const compact = render(ReportResult, {
    result: output,
    spec: report,
    locale: 'en-US',
    formatCell,
  });
  const readout = compact.container.querySelector(
    '[data-smrt-part="readout"]',
  )?.textContent;
  expect(readout).toContain(fn === 'count' ? cells[2] : cells[0]);
  expect(readout).toContain(cells[2]);
  expect(
    formatCell.mock.calls.every(([value]) => typeof value === 'string'),
  ).toBe(true);
});
