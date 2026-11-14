import type { AppReportResult, ReportDef } from '../lib/ui/types.ts';
export const report: ReportDef = {
  label: 'Sales by customer',
  spec: {
    version: 1,
    title: 'Sales by customer',
    source: 'Customer',
    dimensions: [{ field: 'name', as: 'customer' }],
    measures: [{ fn: 'count', as: 'total' }],
    filters: [],
    having: [],
    sort: [],
    limit: 100,
    chart: { type: 'bar', x: 'customer', y: ['total'] },
  },
};
export const result: AppReportResult = {
  version: 1,
  title: report.spec.title,
  specHash: 'hash',
  ranAt: '2026-11-11T00:00:00Z',
  rowCount: 1,
  truncated: false,
  columns: [
    {
      id: 'customer',
      label: 'Customer',
      role: 'dimension',
      type: 'id',
      field: 'name',
      reference: 'Customer',
      labelColumn: 'customerLabel',
    },
    { id: 'total', label: 'Count', role: 'measure', type: 'integer' },
  ],
  rows: [{ customer: 'c1', customerLabel: 'Acme Ltd', total: 3 }],
  chart: report.spec.chart,
};
