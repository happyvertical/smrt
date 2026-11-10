/** Test-only host registration for the copied reference application. */
import type {
  MaterializedReportDrilldownPresentation,
  MaterializedReportHost,
  ReportAdapterDescriptor,
  ReportDataQueryResult,
} from '@happyvertical/smrt-reports';

const descriptor = {
  version: 1,
  resourceId: 'reference-tax-summary',
  reportClassName: 'Reference tax summary',
  sourceClassName: 'Reference invoice',
  tenantScoped: true,
  tenantField: 'tenant_id',
  identityField: 'id',
  dataTable: {
    columns: [
      {
        id: 'component', label: 'Component', accessor: 'component', sortable: true,
        searchable: false, filterable: true, headerPath: [], valueFormat: 'text',
        align: 'left', role: 'data', responsive: { keepVisible: true },
      },
      {
        id: 'currency', label: 'Currency', accessor: 'currency', sortable: true,
        searchable: false, filterable: true, headerPath: [], valueFormat: 'text',
        align: 'left', role: 'data', responsive: { keepVisible: true },
      },
      {
        id: 'taxable_minor', label: 'Taxable', accessor: 'taxable_minor', sortable: true,
        searchable: false, filterable: true, headerPath: [], valueFormat: 'money',
        align: 'right', role: 'data', responsive: {},
      },
      {
        id: 'tax_minor', label: 'Tax collected', accessor: 'tax_minor', sortable: true,
        searchable: false, filterable: true, headerPath: [], valueFormat: 'money',
        align: 'right', role: 'data', responsive: { keepVisible: true },
      },
    ],
  },
} as unknown as ReportAdapterDescriptor;

const complete: MaterializedReportDrilldownPresentation = {
  version: 1,
  selectedMeasure: { id: 'tax', label: 'Tax collected' },
  currency: 'CAD',
  complete: true,
  warnings: [],
  contributors: [
    {
      id: 'invoice-a',
      source: 'Invoice',
      identity: 'REPORT-A (invoice-a)',
      date: '2026-09-01T00:00:00.000Z',
      party: 'party-a',
      values: { valueMinor: 4050, taxableMinor: 81000, taxMinor: 4050 },
    },
  ],
};

const incomplete: MaterializedReportDrilldownPresentation = {
  version: 1,
  selectedMeasure: { id: 'tax', label: 'Tax collected' },
  currency: 'CAD',
  complete: false,
  warnings: [
    {
      code: 'source-state-diverged',
      kind: 'drift',
      message: 'Current source facts differ from this materialized report row.',
    },
  ],
  contributors: [
    {
      id: 'invoice-b',
      source: 'Invoice',
      identity: 'REPORT-B (invoice-b)',
      date: '2026-09-02T00:00:00.000Z',
      party: 'party-b',
      values: { valueMinor: 3857, taxableMinor: 77143, taxMinor: 3857 },
    },
  ],
};

const rows = [
  { id: 'complete', component: 'GST', currency: 'CAD', taxable_minor: 81000, tax_minor: 4050 },
  { id: 'incomplete', component: 'GST drift', currency: 'CAD', taxable_minor: 77143, tax_minor: 3857 },
  { id: 'failure', component: 'Unavailable', currency: 'CAD', taxable_minor: 0, tax_minor: 0 },
] as const;

function result(offset: number, limit: number): ReportDataQueryResult {
  const pageRows = offset === 50
    ? [{ id: 'later', component: 'Final GST', currency: 'CAD', taxable_minor: 100, tax_minor: 5 }]
    : rows;
  return {
    version: 1,
    requestId: `reference-tax-summary:${offset}`,
    queryFingerprint: 'reference-tax-summary',
    identityField: 'id',
    rows: [...pageRows],
    page: { kind: 'offset', offset, limit, hasMore: offset + pageRows.length < 51 },
    total: { kind: 'exact', value: 51 },
    freshness: { state: 'unknown' },
    warnings: [],
    truncated: false,
    execution: 'visible',
  };
}

const host: MaterializedReportHost<MaterializedReportDrilldownPresentation> = {
  id: 'reference-tax-summary',
  collection: 'notes',
  className: 'ReferenceTaxSummary',
  readPermission: 'notes.read',
  drilldownColumnIds: ['tax_minor'],
  descriptor: async () => descriptor,
  query: async (_context, request) => {
    const page = request as { page?: { offset?: unknown; limit?: unknown } };
    const offset = typeof page.page?.offset === 'number' ? page.page.offset : 0;
    const limit = typeof page.page?.limit === 'number' ? page.page.limit : 50;
    return result(offset, limit);
  },
  drilldown: async (_context, request) => {
    if (request.columnId !== 'tax_minor') throw new Error('Unsupported drilldown');
    if (request.id === 'complete') {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return complete;
    }
    if (request.id === 'incomplete') return incomplete;
    throw new Error('Unavailable drilldown');
  },
};

export const materializedReportHosts: readonly MaterializedReportHost[] = [host];
