import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import {
  createDataTableConformanceRows,
  type DataTableConformanceRow,
  dataTableConformanceColumns,
  dataTableConformanceRows,
  dataTableConformanceScenarios,
  dataTableConformanceStructuralRows,
} from '../__fixtures__/DataTableConformanceFixture.js';
import DataTable from '../DataTable.svelte';
import {
  createDataTableController,
  type DataTableCommand,
  type DataTableViewState,
} from '../DataTableController.js';

interface ManualQueryToken {
  queryFingerprint: string;
  queryRevision: string;
}

function isManualQueryCommand(command: DataTableCommand | undefined) {
  return (
    command?.type === 'setSearch' ||
    command?.type === 'setFilters' ||
    command?.type === 'setSorting' ||
    command?.type === 'toggleSorting' ||
    command?.type === 'setPage' ||
    command?.type === 'setPageSize'
  );
}

/**
 * A deterministic consumer-side model for the guide's manual-query contract.
 * The table owns the query state; the consumer owns matching results and never
 * lets a late response replace the current query's rows.
 */
function createManualQueryHost(initialRows: DataTableConformanceRow[]) {
  let revision = 0;
  let current: ManualQueryToken = {
    queryFingerprint: '',
    queryRevision: 'revision-0',
  };
  let rows = initialRows;

  return {
    begin(state: DataTableViewState): ManualQueryToken {
      revision += 1;
      current = {
        queryFingerprint: JSON.stringify({
          search: state.search,
          filters: state.filters,
          sorting: state.sorting,
          page: state.page,
          pageSize: state.pageSize,
        }),
        queryRevision: `revision-${revision}`,
      };
      return { ...current };
    },
    resolve(response: ManualQueryToken & { rows: DataTableConformanceRow[] }) {
      if (
        response.queryFingerprint !== current.queryFingerprint ||
        response.queryRevision !== current.queryRevision
      ) {
        return false;
      }
      rows = response.rows;
      return true;
    },
    rows: () => rows,
  };
}

function setHorizontalOverflow(
  container: HTMLDivElement,
  clientWidth: number,
  scrollWidth: number,
) {
  Object.defineProperties(container, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollLeft: { configurable: true, value: 0, writable: true },
  });
  window.dispatchEvent(new Event('resize'));
}

describe('DataTable release conformance', () => {
  it('keeps every release scenario available to both tests and the playground', () => {
    expect(
      dataTableConformanceScenarios.map((scenario) => scenario.id),
    ).toEqual([
      'semantic-interaction',
      'manual-query',
      'async-lifecycle',
      'responsive-overflow',
      'report-layout',
      'scale-virtualization',
    ]);
    expect(
      dataTableConformanceScenarios.every(
        (scenario) => scenario.contracts.length > 0,
      ),
    ).toBe(true);
  });

  it('renders an axe-clean report with grouped headers and structural summaries', async () => {
    const controller = createDataTableController({
      columnIds: dataTableConformanceColumns.map((column) => column.id),
      initialState: {
        columnWidths: [{ columnId: 'account', width: 240 }],
        columnPinning: [{ columnId: 'account', position: 'start' }],
      },
    });
    const { container } = render(DataTable, {
      props: {
        data: dataTableConformanceRows,
        columns: dataTableConformanceColumns,
        rowKey: 'id',
        controller,
        structuralRows: dataTableConformanceStructuralRows,
        caption: 'Conformance forecast report',
      },
    });

    expect(
      screen.getByRole('columnheader', { name: 'Dimensions' }),
    ).toHaveAttribute('scope', 'colgroup');
    expect(
      screen.getByRole('rowheader', { name: /Current forecast/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: /All accounts/ }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('keeps a manual query usable through stale, failed, and retry states', async () => {
    const onRetry = vi.fn();
    const controller = createDataTableController({
      columnIds: dataTableConformanceColumns.map((column) => column.id),
      modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
      initialState: { page: 2, pageSize: 25 },
    });
    const props = {
      data: dataTableConformanceRows,
      columns: dataTableConformanceColumns,
      rowKey: 'id' as const,
      controller,
      totalRows: 120,
      loading: true,
      stale: true,
      partialResults: true,
      onRetry,
      caption: 'Manual query results',
    };
    const { rerender } = render(DataTable, { props });

    expect(
      screen.getByRole('cell', { name: 'Subscription revenue' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing stale results',
    );
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');

    await rerender({ ...props, loading: false, error: 'Request failed' });
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('commits only the current manually owned search, sort, filter, and page response', async () => {
    const controller = createDataTableController({
      columnIds: dataTableConformanceColumns.map((column) => column.id),
      modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
      initialState: { page: 1, pageSize: 1 },
    });
    const host = createManualQueryHost(dataTableConformanceRows);
    const requests: ManualQueryToken[] = [];
    const unsubscribe = controller.subscribe((transition) => {
      if (isManualQueryCommand(transition.command)) {
        requests.push(host.begin(transition.next.state));
      }
    });
    render(DataTable, {
      props: {
        data: dataTableConformanceRows,
        columns: dataTableConformanceColumns,
        rowKey: 'id',
        controller,
        sortable: true,
        totalRows: 2,
        caption: 'Manual host results',
      },
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Account ascending' }),
    );
    controller.dispatch({ type: 'setSearch', search: 'Growth' });
    controller.dispatch({
      type: 'setSorting',
      sorting: [{ columnId: 'account', direction: 'desc' }],
    });
    controller.dispatch({
      type: 'setFilters',
      filters: [{ columnId: 'status', operator: 'equals', value: 'On track' }],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(requests).toHaveLength(5);
    expect(JSON.parse(requests[1].queryFingerprint)).toMatchObject({
      search: 'Growth',
    });
    expect(requests[0]).not.toEqual(requests[4]);
    expect(
      host.resolve({
        ...requests[0],
        rows: [dataTableConformanceRows[1]],
      }),
    ).toBe(false);
    expect(host.rows()).toEqual(dataTableConformanceRows);
    expect(
      host.resolve({
        ...requests[4],
        rows: [dataTableConformanceRows[0]],
      }),
    ).toBe(true);
    expect(host.rows()).toEqual([dataTableConformanceRows[0]]);
    unsubscribe();
  });

  it('exposes only real horizontal overflow as a named keyboard-scroll region', async () => {
    const { container } = render(DataTable, {
      props: {
        data: dataTableConformanceRows,
        columns: dataTableConformanceColumns,
        rowKey: 'id',
        caption: 'Responsive conformance report',
      },
    });
    const tableContainer = container.querySelector(
      '.data-table-container',
    ) as HTMLDivElement;
    setHorizontalOverflow(tableContainer, 320, 960);

    await vi.waitFor(() =>
      expect(tableContainer).toHaveAttribute(
        'aria-label',
        'Responsive conformance report table, scroll horizontally to view more columns',
      ),
    );
    tableContainer.focus();
    await fireEvent.keyDown(tableContainer, { key: 'End' });
    expect(tableContainer.scrollLeft).toBe(640);
    await expectNoA11yViolations(container);
  });

  it('keeps virtual rows keyed independently from their rendered window', async () => {
    const rows = createDataTableConformanceRows(120);
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns: dataTableConformanceColumns.slice(0, 2),
        rowKey: 'id',
        virtualization: { rowHeight: 24, viewportHeight: 96, overscan: 1 },
        caption: 'Virtual conformance rows',
      },
    });
    const tableContainer = container.querySelector(
      '.data-table-container',
    ) as HTMLDivElement;

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '122');
    expect(screen.getByText('Subscription revenue 1')).toBeInTheDocument();
    tableContainer.scrollTop = 240;
    await fireEvent.scroll(tableContainer);
    await vi.waitFor(() =>
      expect(screen.getByText('Subscription revenue 11')).toBeInTheDocument(),
    );
  });
});
