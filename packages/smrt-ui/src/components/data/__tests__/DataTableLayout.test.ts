import { describe, expect, it } from 'vitest';
import type { DataTableViewState } from '../DataTableController.js';
import { resolveDataTableLayout } from '../DataTableLayout.js';
import type { DataTableColumn } from '../types.js';

interface ReportRow {
  account: string;
  actual: number;
  budget: number;
  status: string;
}

const columns: DataTableColumn<ReportRow>[] = [
  {
    id: 'account',
    label: 'Account',
    accessor: 'account',
    width: '180px',
  },
  {
    id: 'actual',
    label: 'Actual',
    accessor: 'actual',
    headerPath: [{ id: 'measures', label: 'Measures' }],
  },
  {
    id: 'budget',
    label: 'Budget',
    accessor: 'budget',
    headerPath: [{ id: 'measures', label: 'Measures' }],
  },
  {
    id: 'status',
    label: 'Status',
    accessor: 'status',
    role: 'status',
    responsive: { keepVisible: true, priority: 10 },
  },
];

const state: DataTableViewState = {
  search: '',
  filters: [],
  sorting: [],
  page: 1,
  pageSize: null,
  columnOrder: ['account', 'actual', 'budget', 'status'],
  columnVisibility: columns.map((column) => ({
    columnId: column.id,
    visible: true,
  })),
  columnWidths: [],
  columnPinning: [],
  selection: { scope: 'explicit', rowIds: [] },
  selectedRowIds: [],
  expandedRowIds: [],
};

describe('resolveDataTableLayout', () => {
  it('rebuilds grouped headers after visibility, order, and pinning are resolved', () => {
    const layout = resolveDataTableLayout(columns, {
      ...state,
      columnOrder: ['budget', 'account', 'actual', 'status'],
      columnVisibility: state.columnVisibility.map((entry) =>
        entry.columnId === 'actual' ? { ...entry, visible: false } : entry,
      ),
      columnPinning: [
        { columnId: 'account', position: 'start' },
        { columnId: 'status', position: 'end' },
      ],
      columnWidths: [{ columnId: 'account', width: 220 }],
    });

    expect(layout.columns.map(({ column }) => column.id)).toEqual([
      'account',
      'budget',
      'status',
    ]);
    expect(layout.columns[0]).toMatchObject({
      pin: 'start',
      width: 220,
      stickyOffset: '0px',
    });
    expect(layout.columns[2]).toMatchObject({
      pin: 'end',
      stickyOffset: '0px',
    });
    expect(layout.headerRows).toHaveLength(2);
    expect(layout.headerRows[0]).toEqual([
      expect.objectContaining({ kind: 'leaf', rowspan: 2 }),
      expect.objectContaining({
        kind: 'group',
        label: 'Measures',
        colspan: 1,
      }),
      expect.objectContaining({ kind: 'leaf', rowspan: 2 }),
    ]);
    expect(layout.headerRows[1]).toEqual([
      expect.objectContaining({
        kind: 'leaf',
        column: expect.objectContaining({
          column: expect.objectContaining({ id: 'budget' }),
        }),
      }),
    ]);
  });

  it('splits a repeated group when restored order separates its leaves', () => {
    const layout = resolveDataTableLayout(columns, {
      ...state,
      columnOrder: ['actual', 'status', 'budget', 'account'],
    });

    const groups = layout.headerRows[0].filter((cell) => cell.kind === 'group');
    expect(groups).toHaveLength(2);
    expect(groups).toEqual([
      expect.objectContaining({ label: 'Measures', colspan: 1 }),
      expect.objectContaining({ label: 'Measures', colspan: 1 }),
    ]);
  });

  it('keeps an uneven header path rectangular with leaf row spans', () => {
    const layout = resolveDataTableLayout(
      [
        columns[0],
        {
          ...columns[1],
          headerPath: [{ id: 'performance', label: 'Performance' }],
        },
        {
          ...columns[2],
          headerPath: [
            { id: 'performance', label: 'Performance' },
            { id: 'plan', label: 'Plan' },
          ],
        },
      ],
      {
        ...state,
        columnOrder: ['account', 'actual', 'budget'],
        columnVisibility: [
          { columnId: 'account', visible: true },
          { columnId: 'actual', visible: true },
          { columnId: 'budget', visible: true },
        ],
      },
    );

    expect(layout.headerRows).toHaveLength(3);
    expect(layout.headerRows[0]).toEqual([
      expect.objectContaining({ kind: 'leaf', rowspan: 3 }),
      expect.objectContaining({
        kind: 'group',
        label: 'Performance',
        colspan: 2,
        rowspan: 1,
      }),
    ]);
    expect(layout.headerRows[1]).toEqual([
      expect.objectContaining({ kind: 'leaf', rowspan: 2 }),
      expect.objectContaining({ kind: 'group', label: 'Plan' }),
    ]);
    expect(layout.headerRows[2]).toEqual([
      expect.objectContaining({ kind: 'leaf', rowspan: 1 }),
    ]);
  });

  it('uses measured auto widths for sibling pins and keeps an all-pinned group aligned', () => {
    const layout = resolveDataTableLayout(
      [columns[1], columns[2], columns[0]],
      {
        ...state,
        columnOrder: ['actual', 'budget', 'account'],
        columnVisibility: [
          { columnId: 'actual', visible: true },
          { columnId: 'budget', visible: true },
          { columnId: 'account', visible: true },
        ],
        columnPinning: [
          { columnId: 'actual', position: 'start' },
          { columnId: 'budget', position: 'start' },
        ],
      },
      { actual: 104, budget: 116 },
    );

    expect(layout.columns[0]).toMatchObject({
      column: { id: 'actual' },
      pin: 'start',
      stickyOffset: '0px',
    });
    expect(layout.columns[1]).toMatchObject({
      column: { id: 'budget' },
      pin: 'start',
      stickyOffset: 'calc(0px + 104px)',
    });
    expect(layout.headerRows[0]).toContainEqual(
      expect.objectContaining({
        kind: 'group',
        label: 'Measures',
        pin: 'start',
        stickyOffset: '0px',
      }),
    );
  });

  it('uses a rendered width before a restored width for pinned offsets', () => {
    const layout = resolveDataTableLayout(
      [columns[1], columns[2]],
      {
        ...state,
        columnOrder: ['actual', 'budget'],
        columnVisibility: [
          { columnId: 'actual', visible: true },
          { columnId: 'budget', visible: true },
        ],
        columnPinning: [
          { columnId: 'actual', position: 'start' },
          { columnId: 'budget', position: 'start' },
        ],
        columnWidths: [{ columnId: 'actual', width: 80 }],
      },
      { actual: 200, budget: 120 },
    );

    expect(layout.columns[1]).toMatchObject({
      column: { id: 'budget' },
      stickyOffset: 'calc(0px + 200px)',
    });
  });
});
