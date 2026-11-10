import type {
  RuntimeReportProposal,
  RuntimeReportResult,
  RuntimeReportSpec,
  RuntimeReportsClient,
  SavedRuntimeReport,
} from './types.js';

export const spec: RuntimeReportSpec = {
  version: 1,
  title: 'Sales by region',
  source: 'sales',
  dimensions: [{ field: 'region', as: 'region' }],
  measures: [{ fn: 'sum', field: 'amount', as: 'total' }],
  filters: [],
  having: [],
  sort: [],
  limit: 100,
  chart: { type: 'bar', x: 'region', y: ['total'] },
};
export const result: RuntimeReportResult = {
  version: 1,
  specHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  title: spec.title,
  columns: [
    { id: 'region', label: 'Region', role: 'dimension', type: 'string' },
    {
      id: 'total',
      label: 'Total',
      role: 'measure',
      type: 'integer',
      format: 'money',
    },
  ],
  rows: [{ region: 'West', total: 12345 }],
  rowCount: 1,
  truncated: false,
  ranAt: '2026-10-13T12:00:00Z',
  chart: spec.chart,
};
export const saved: SavedRuntimeReport = {
  id: 'report-1',
  title: spec.title,
  sourceId: 'sales',
  createdByUserId: 'alice',
  status: 'active',
  spec,
  canArchive: true,
};
export const proposal: RuntimeReportProposal = {
  status: 'awaiting_confirmation',
  specHash: result.specHash,
  spec,
  preview: result,
  sourceLabel: 'Sales',
  confirmPath: '/api/_reports/runtime/confirm',
};
export function client(
  overrides: Partial<RuntimeReportsClient> = {},
): RuntimeReportsClient {
  return {
    list: async () => [saved],
    get: async () => saved,
    run: async () => result,
    archive: async () => {},
    confirm: async () => saved,
    ...overrides,
  };
}
