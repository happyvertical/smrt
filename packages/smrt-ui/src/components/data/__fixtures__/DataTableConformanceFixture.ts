import type { DataTableColumn, DataTableStructuralRow } from '../types.js';

/**
 * Shared, domain-neutral data used to exercise the documented DataTable
 * contracts in component tests and the interactive workbench preview.
 */
export interface DataTableConformanceRow {
  id: string;
  account: string;
  team: string;
  actual: number;
  forecast: number;
  variance: number;
  status: 'On track' | 'Watch';
  action: string;
}

export const dataTableConformanceRows: DataTableConformanceRow[] = [
  {
    id: 'revenue',
    account: 'Subscription revenue',
    team: 'Growth',
    actual: 182_400,
    forecast: 176_000,
    variance: 6_400,
    status: 'On track',
    action: 'Review',
  },
  {
    id: 'services',
    account: 'Professional services',
    team: 'Delivery',
    actual: 48_300,
    forecast: 52_000,
    variance: -3_700,
    status: 'Watch',
    action: 'Review',
  },
];

export const dataTableConformanceColumns: DataTableColumn<DataTableConformanceRow>[] =
  [
    {
      id: 'account',
      label: 'Account',
      headerPath: [{ id: 'dimensions', label: 'Dimensions' }],
      minWidth: '13rem',
      resizable: true,
      sortable: true,
    },
    {
      id: 'team',
      label: 'Team',
      headerPath: [{ id: 'dimensions', label: 'Dimensions' }],
      minWidth: '9rem',
    },
    {
      id: 'actual',
      label: 'Actual',
      headerPath: [{ id: 'performance', label: 'Performance' }],
      align: 'right',
      resizable: true,
    },
    {
      id: 'forecast',
      label: 'Forecast',
      headerPath: [{ id: 'performance', label: 'Performance' }],
      align: 'right',
      resizable: true,
    },
    {
      id: 'variance',
      label: 'Variance',
      headerPath: [{ id: 'performance', label: 'Performance' }],
      align: 'right',
    },
    {
      id: 'status',
      label: 'Status',
      role: 'status',
      responsive: { keepVisible: true, priority: 10 },
    },
    {
      id: 'action',
      label: 'Action',
      role: 'action',
      responsive: { keepVisible: true, priority: 10 },
    },
  ];

export const dataTableConformanceStructuralRows: DataTableStructuralRow<DataTableConformanceRow>[] =
  [
    {
      id: 'forecast-subtotal',
      kind: 'subtotal',
      label: 'Current forecast',
      values: { actual: 230_700, forecast: 228_000, variance: 2_700 },
    },
    {
      id: 'forecast-total',
      kind: 'footer',
      label: 'All accounts',
      values: { actual: 230_700, forecast: 228_000, variance: 2_700 },
    },
  ];

/** The release-level scenarios that must remain represented in tests and the playground. */
export interface DataTableConformanceScenario {
  id:
    | 'semantic-interaction'
    | 'manual-query'
    | 'async-lifecycle'
    | 'responsive-overflow'
    | 'report-layout'
    | 'scale-virtualization';
  title: string;
  contracts: readonly string[];
}

export const dataTableConformanceScenarios: readonly DataTableConformanceScenario[] =
  [
    {
      id: 'semantic-interaction',
      title: 'Semantic interaction',
      contracts: ['caption', 'rowKey', 'selection', 'keyboard row actions'],
    },
    {
      id: 'manual-query',
      title: 'Manual query ownership',
      contracts: [
        'modes',
        'totalRows',
        'query revision',
        'allMatching selection',
      ],
    },
    {
      id: 'async-lifecycle',
      title: 'Async lifecycle',
      contracts: ['loading', 'refreshing', 'stale', 'partial results', 'retry'],
    },
    {
      id: 'responsive-overflow',
      title: 'Responsive overflow',
      contracts: [
        'responsive metadata',
        'named overflow region',
        'keyboard scroll',
      ],
    },
    {
      id: 'report-layout',
      title: 'Report layout',
      contracts: ['grouped headers', 'structural rows', 'widths', 'pinning'],
    },
    {
      id: 'scale-virtualization',
      title: 'Scale and virtualization',
      contracts: [
        'rowKey',
        'virtual body',
        'stable focus',
        'footer reachability',
      ],
    },
  ];

export function createDataTableConformanceRows(
  rowCount: number,
): DataTableConformanceRow[] {
  return Array.from({ length: rowCount }, (_, index) => {
    const source =
      dataTableConformanceRows[index % dataTableConformanceRows.length];
    const rowNumber = index + 1;
    return {
      ...source,
      id: `conformance-${rowNumber}`,
      account: `${source.account} ${rowNumber}`,
    };
  });
}
