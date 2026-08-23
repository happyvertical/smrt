/**
 * Golden test for DataTable (Sweep L4, #1423).
 *
 * Covers the semantic table structure (caption → accessible name, column
 * headers, cells, row count), the empty state, sortable-header interaction
 * (aria-sort transition), and axe-cleanliness.
 */
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DataTable from '../DataTable.svelte';
import {
  createDataTableController,
  type DataTableModes,
  transitionDataTableState,
} from '../DataTableController.js';

interface Person {
  id: string;
  name: string;
  age: number;
}

const columns = [
  { id: 'name', label: 'Name', accessor: 'name', sortable: true },
  { id: 'age', label: 'Age', accessor: 'age' },
];
const data: Person[] = [
  { id: 'ada', name: 'Ada', age: 36 },
  { id: 'linus', name: 'Linus', age: 54 },
];

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

describe('DataTable', () => {
  it('renders caption, headers, cells, and a row per datum', () => {
    render(DataTable, { props: { data, columns, caption: 'People' } });
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Name' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    // header row + one row per datum
    expect(screen.getAllByRole('row')).toHaveLength(data.length + 1);
  });

  it('renders the empty state when there is no data', () => {
    render(DataTable, { props: { data: [], columns } });
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('uses action-oriented labels and complete aria-sort transitions for sortable headers', async () => {
    render(DataTable, { props: { data, columns, sortable: true } });
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    // aria-sort is only present on the actively-sorted column.
    expect(nameHeader).not.toHaveAttribute('aria-sort');
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name descending' }),
    );
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(
      screen.getByRole('button', { name: 'Clear sorting for Name' }),
    );
    expect(nameHeader).not.toHaveAttribute('aria-sort');
  });

  it('announces the next action for each rule in a multi-column sort', async () => {
    const multiSortColumns = [columns[0], { ...columns[1], sortable: true }];
    render(DataTable, {
      props: { data, columns: multiSortColumns, sortable: true },
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Age ascending' }),
      { shiftKey: true },
    );
    expect(
      screen.getByRole('button', { name: 'Sort Age descending' }),
    ).toBeInTheDocument();
  });

  it('keeps custom sortable headers interactive unless they explicitly opt out', async () => {
    const customHeader = createRawSnippet(() => ({
      render: () => '<span>Custom name</span>',
    }));
    const customColumns = [{ ...columns[0], header: customHeader }, columns[1]];
    render(DataTable, {
      props: { data, columns: customColumns, sortable: true },
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    expect(screen.getByText('Custom name')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Custom name' }),
    ).toHaveAttribute('aria-sort', 'ascending');

    const { container } = render(DataTable, {
      props: {
        data,
        columns: [
          { ...columns[0], header: customHeader, headerSortMode: 'manual' },
          columns[1],
        ],
        sortable: true,
      },
    });
    expect(
      within(container).queryByRole('button', { name: 'Sort Name ascending' }),
    ).not.toBeInTheDocument();
  });

  it('keeps automatic sort controls separate from interactive custom headers', async () => {
    const customHeader = createRawSnippet(() => ({
      render: () => '<button type="button">Column actions</button>',
    }));
    const customColumns = [{ ...columns[0], header: customHeader }, columns[1]];
    render(DataTable, {
      props: { data, columns: customColumns, sortable: true },
    });

    const customAction = screen.getByRole('button', { name: 'Column actions' });
    const sortAction = screen.getByRole('button', {
      name: 'Sort Name ascending',
    });
    expect(sortAction).not.toContainElement(customAction);

    await userEvent.click(customAction);
    expect(screen.getAllByRole('columnheader')[0]).not.toHaveAttribute(
      'aria-sort',
    );
    await userEvent.click(sortAction);
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('routes a human sort click through the same controller transition as a command', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const before = controller.getState();
    render(DataTable, { props: { data, columns, sortable: true, controller } });

    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );

    expect(controller.getState()).toEqual(
      transitionDataTableState(before, {
        type: 'toggleSorting',
        columnId: 'name',
        multi: false,
      }),
    );
  });

  it('waits for a controlled controller host before rendering a proposed interaction', async () => {
    const initialState = createDataTableController({
      columnIds: columns.map((column) => column.id),
    }).getState();
    const onStateChange = vi.fn();
    const controller = createDataTableController({
      state: initialState,
      columnIds: columns.map((column) => column.id),
      onStateChange,
    });
    render(DataTable, { props: { data, columns, sortable: true, controller } });

    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    expect(nameHeader).not.toHaveAttribute('aria-sort');

    controller.replaceState(onStateChange.mock.calls[0][0]);
    await vi.waitFor(() =>
      expect(nameHeader).toHaveAttribute('aria-sort', 'ascending'),
    );
  });

  it('filters and paginates client-side rows', async () => {
    render(DataTable, {
      props: {
        data: [...data, { id: 'grace', name: 'Grace', age: 85 }],
        columns,
        filterFn: (person: Person) => person.age > 40,
        pageSize: 1,
      },
    });
    expect(screen.getByRole('cell', { name: 'Linus' })).toBeInTheDocument();
    expect(
      screen.queryByRole('cell', { name: 'Grace' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('cell', { name: 'Grace' })).toBeInTheDocument();
  });

  it('ignores local filters targeting a non-filterable column', () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: {
        filters: [{ columnId: 'age', operator: 'gte', value: 40 }],
      },
    });
    render(DataTable, {
      props: {
        data,
        columns: [columns[0], { ...columns[1], filterable: false }],
        controller,
      },
    });

    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Linus' })).toBeInTheDocument();
  });

  it('clamps a controller page changed after mount against the current total', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: { page: 1, pageSize: 1 },
    });
    render(DataTable, { props: { data, columns, controller } });

    controller.replaceState({ ...controller.getState(), page: 4 });

    await vi.waitFor(() => expect(controller.getState().page).toBe(2));
    expect(screen.getByRole('cell', { name: 'Linus' })).toBeInTheDocument();
  });

  it.each([
    [
      'local/local/local',
      { filtering: 'local', sorting: 'local', pagination: 'local' },
      ['Grace'],
    ],
    [
      'local/local/manual',
      { filtering: 'local', sorting: 'local', pagination: 'manual' },
      ['Grace', 'Linus'],
    ],
    [
      'local/manual/local',
      { filtering: 'local', sorting: 'manual', pagination: 'local' },
      ['Linus'],
    ],
    [
      'local/manual/manual',
      { filtering: 'local', sorting: 'manual', pagination: 'manual' },
      ['Linus', 'Grace'],
    ],
    [
      'manual/local/local',
      { filtering: 'manual', sorting: 'local', pagination: 'local' },
      ['Grace'],
    ],
    [
      'manual/local/manual',
      { filtering: 'manual', sorting: 'local', pagination: 'manual' },
      ['Grace', 'Linus', 'Ada'],
    ],
    [
      'manual/manual/local',
      { filtering: 'manual', sorting: 'manual', pagination: 'local' },
      ['Ada'],
    ],
    [
      'manual/manual/manual',
      { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
      ['Ada', 'Linus', 'Grace'],
    ],
  ] as Array<
    [string, DataTableModes, string[]]
  >)('applies each local/manual mode combination exactly once (%s)', (_name, modes, expected) => {
    const controller = createDataTableController({
      modes,
      initialState: {
        filters: [{ columnId: 'age', operator: 'gte', value: 40 }],
        sorting: [{ columnId: 'age', direction: 'desc' }],
        page: 1,
        pageSize: 1,
      },
      columnIds: columns.map((column) => column.id),
    });
    render(DataTable, {
      props: {
        data: [...data, { id: 'grace', name: 'Grace', age: 85 }],
        columns,
        controller,
        rowKey: 'id',
      },
    });

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(expected);
  });

  it('keeps stable selection IDs across pages and labels the page scope', async () => {
    const onSelectionChange = vi.fn();
    render(DataTable, {
      props: {
        data,
        columns,
        pageSize: 1,
        rowKey: 'id',
        selectable: true,
        onSelectionChange,
      },
    });

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select all rows on this page' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select all rows on this page' }),
    );

    expect(onSelectionChange).toHaveBeenLastCalledWith(
      new Set(['ada', 'linus']),
    );
  });

  it('honors legacy selected bindings during controller reconciliation', async () => {
    const props = {
      data,
      columns,
      rowKey: 'id' as const,
      selectable: true,
      selected: new Set<string | number>(['ada']),
    };
    const { rerender } = render(DataTable, { props });

    const expectSelected = (name: string) => {
      expect(screen.getByRole('cell', { name }).closest('tr')).toHaveClass(
        'data-table__row--selected',
      );
    };

    await vi.waitFor(() => expectSelected('Ada'));
    await rerender({ ...props, selected: new Set(['linus']) });
    await vi.waitFor(() => {
      expectSelected('Linus');
      expect(
        screen.getByRole('cell', { name: 'Ada' }).closest('tr'),
      ).not.toHaveClass('data-table__row--selected');
    });
  });

  it('keeps stable selection and expansion through sort, filter, and data refresh', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const expandedContent = createRawSnippet(() => ({
      render: () => '<p>Row detail</p>',
    }));
    const props = {
      data,
      columns,
      rowKey: 'id' as const,
      selectable: true,
      expandedContent,
      controller,
    };
    const { rerender } = render(DataTable, { props });

    const expectAdaSelectionAndExpansion = () => {
      const adaRow = screen.getByRole('cell', { name: 'Ada' }).closest('tr');
      expect(adaRow).toHaveClass('data-table__row--selected');
      expect(adaRow?.nextElementSibling).toHaveTextContent('Row detail');
    };
    const visibleNames = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .filter((row) => !row.classList.contains('data-table__row--expanded'))
        .map(
          (row) =>
            within(row)
              .getAllByRole('cell')
              .find((cell) => ['Ada', 'Linus'].includes(cell.textContent ?? ''))
              ?.textContent,
        )
        .filter((name): name is string => name !== undefined);

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select row 1' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Expand row 1' }));
    expectAdaSelectionAndExpansion();

    controller.dispatch({
      type: 'setSorting',
      sorting: [{ columnId: 'age', direction: 'desc' }],
    });
    await vi.waitFor(() => {
      expect(visibleNames()).toEqual(['Linus', 'Ada']);
      expectAdaSelectionAndExpansion();
    });

    controller.dispatch({ type: 'setSearch', search: 'Ada' });
    await vi.waitFor(() => {
      expect(
        screen.queryByRole('cell', { name: 'Linus' }),
      ).not.toBeInTheDocument();
      expectAdaSelectionAndExpansion();
    });

    controller.dispatch({ type: 'setSearch', search: '' });
    await rerender({
      ...props,
      data: [
        { id: 'linus', name: 'Linus', age: 10 },
        { id: 'ada', name: 'Ada', age: 90 },
      ],
    });
    await vi.waitFor(() => {
      expect(visibleNames()).toEqual(['Ada', 'Linus']);
      expectAdaSelectionAndExpansion();
    });
  });

  it('fails closed when durable selection, expansion, manual, or agent modes lack a rowKey', () => {
    expect(() =>
      render(DataTable, { props: { data, columns, selectable: true } }),
    ).toThrow(/rowKey is required/);
    expect(() =>
      render(DataTable, {
        props: {
          data,
          columns,
          expandedContent: createRawSnippet(() => ({ render: () => '' })),
        },
      }),
    ).toThrow(/rowKey is required/);
    expect(() =>
      render(DataTable, {
        props: { data, columns, agentAddressable: true },
      }),
    ).toThrow(/rowKey is required/);
    expect(() =>
      render(DataTable, {
        props: { data, columns, modes: { pagination: 'manual' } },
      }),
    ).toThrow(/rowKey is required/);
  });

  it('links localized expansion controls to their row detail', async () => {
    render(DataTable, {
      props: {
        data,
        columns,
        rowKey: 'id',
        expandedContent: createRawSnippet(() => ({
          render: () => '<p>Row detail</p>',
        })),
      },
    });
    const expandButton = screen.getByRole('button', { name: 'Expand row 1' });
    await userEvent.click(expandButton);
    expect(screen.getByText('Row detail')).toBeInTheDocument();
    expect(expandButton).toHaveAttribute('aria-expanded', 'true');
    const expansionId = expandButton.getAttribute('aria-controls');
    expect(expansionId).toBeTruthy();
    expect(document.getElementById(expansionId ?? '')).toHaveTextContent(
      'Row detail',
    );
    expect(screen.getByRole('button', { name: 'Collapse row 1' })).toBe(
      expandButton,
    );
  });

  it('keeps clickable rows semantic and ignores nested row actions', async () => {
    const onRowClick = vi.fn();
    const actionCell = createRawSnippet(() => ({
      render: () => '<button type="button">Archive row</button>',
    }));
    const expandedContent = createRawSnippet(() => ({
      render: () => '<p>Row detail</p>',
    }));
    render(DataTable, {
      props: {
        data,
        columns: [
          ...columns,
          { id: 'actions', label: 'Actions', cell: actionCell },
        ],
        rowKey: 'id',
        selectable: true,
        expandedContent,
        onRowClick,
        rowLabel: (person: Person) => person.name,
      },
    });

    const adaRow = screen.getByRole('cell', { name: 'Ada' }).closest('tr');
    expect(adaRow).not.toHaveAttribute('role');
    expect(adaRow).toHaveAttribute('tabindex', '0');

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Ada' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand Ada' }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Archive row' })[0],
    );
    expect(onRowClick).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('cell', { name: 'Ada' }));
    expect(onRowClick).toHaveBeenLastCalledWith(data[0], 0);

    adaRow?.focus();
    await userEvent.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(data[0], 0);
  });

  it('announces async states without replacing usable stale rows', async () => {
    const onRetry = vi.fn();
    const props = {
      data,
      columns,
      rowKey: 'id' as const,
      selectable: true,
      loading: true,
      stale: true,
      partialResults: true,
      onRetry,
    };
    const { rerender } = render(DataTable, { props });

    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Refreshing table data',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing stale results',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Showing partial results',
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select row 1' }),
    );

    await rerender({ ...props, error: 'Request failed' });
    expect(screen.getByRole('cell', { name: 'Ada' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await rerender({
      ...props,
      data: [],
      stale: false,
      partialResults: false,
      error: null,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading table data');
    expect(screen.queryByText('No data available')).not.toBeInTheDocument();

    await rerender({
      ...props,
      data: [],
      loading: false,
      error: 'Request failed',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Request failed');

    await rerender({ ...props, data: [], loading: false, error: '' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to load table data',
    );
  });

  it('rejects duplicate stable row keys and local totals that imply server paging', () => {
    expect(() =>
      render(DataTable, {
        props: {
          data: [data[0], { ...data[1], id: 'ada' }],
          columns,
          rowKey: 'id',
        },
      }),
    ).toThrow(/unique row ids/);
    expect(() =>
      render(DataTable, {
        props: { data, columns, rowKey: 'id', totalRows: 10 },
      }),
    ).toThrow(/only valid when pagination mode is manual/);
  });

  it('uses stable row IDs as the final local sort tie-breaker', () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: { sorting: [{ columnId: 'age', direction: 'asc' }] },
    });
    render(DataTable, {
      props: {
        data: [
          { id: 'z', name: 'Zed', age: 36 },
          { id: 'a', name: 'Ada', age: 36 },
        ],
        columns,
        rowKey: 'id',
        controller,
      },
    });
    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(['Ada', 'Zed']);
  });

  it('makes only an overflowing narrow table a named, focusable scroll region', async () => {
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    const tableContainer = container.querySelector(
      '.data-table-container',
    ) as HTMLDivElement;

    expect(tableContainer).not.toHaveAttribute('role');
    expect(tableContainer).not.toHaveAttribute('tabindex');

    setHorizontalOverflow(tableContainer, 320, 960);

    await vi.waitFor(() => {
      expect(
        screen.getByRole('region', {
          name: 'People table, scroll horizontally to view more columns',
        }),
      ).toBe(tableContainer);
      expect(tableContainer).toHaveAttribute('tabindex', '0');
      expect(screen.getByText('More columns →')).toBeVisible();
      expect(tableContainer).not.toContainElement(
        screen.getByText('More columns →'),
      );
    });
    await expectNoA11yViolations(container);

    setHorizontalOverflow(tableContainer, 320, 320);
    await vi.waitFor(() => {
      expect(tableContainer).not.toHaveAttribute('role');
      expect(tableContainer).not.toHaveAttribute('tabindex');
      expect(screen.queryByText('More columns →')).not.toBeInTheDocument();
    });
  });

  it('scrolls an overflowing narrow table with the keyboard', async () => {
    const user = userEvent.setup();
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    const tableContainer = container.querySelector(
      '.data-table-container',
    ) as HTMLDivElement;
    setHorizontalOverflow(tableContainer, 320, 960);

    await vi.waitFor(() =>
      expect(tableContainer).toHaveAttribute('role', 'region'),
    );
    tableContainer.focus();
    await user.keyboard('{ArrowRight}');
    expect(tableContainer.scrollLeft).toBe(256);
    expect(screen.getByText('← More columns')).toBeVisible();

    await user.keyboard('{End}');
    expect(tableContainer.scrollLeft).toBe(640);
    await user.keyboard('{Home}');
    expect(tableContainer.scrollLeft).toBe(0);
  });

  it('renders grouped headers from final visible leaf columns without losing leaf sort controls', async () => {
    const groupedColumns = [
      {
        ...columns[0],
        headerPath: [{ id: 'identity', label: 'Identity' }],
      },
      {
        ...columns[1],
        sortable: true,
        headerPath: [{ id: 'measures', label: 'Measures' }],
      },
    ];
    render(DataTable, {
      props: { data, columns: groupedColumns, sortable: true },
    });

    const identity = screen.getByRole('columnheader', { name: 'Identity' });
    expect(identity).toHaveAttribute('scope', 'colgroup');
    expect(identity).toHaveAttribute('colspan', '1');
    expect(screen.getAllByRole('row')).toHaveLength(data.length + 2);

    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
  });

  it('keeps a group header aligned when all of its leaves are pinned', () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: {
        columnPinning: [
          { columnId: 'name', position: 'start' },
          { columnId: 'age', position: 'start' },
        ],
      },
    });
    render(DataTable, {
      props: {
        data,
        controller,
        columns: columns.map((column) => ({
          ...column,
          headerPath: [{ id: 'detail', label: 'Detail' }],
        })),
      },
    });

    const group = screen.getByRole('columnheader', { name: 'Detail' });
    expect(group).toHaveClass('data-table__cell--pinned-start');
    expect(group).toHaveStyle({ left: '0px' });
  });

  it('keeps report structural rows semantic and outside data-row selection', () => {
    const { container } = render(DataTable, {
      props: {
        data,
        columns,
        rowKey: 'id',
        selectable: true,
        structuralRows: [
          {
            id: 'subtotal',
            kind: 'subtotal',
            label: 'Current page total',
            values: { age: 90 },
          },
          {
            id: 'footer',
            kind: 'footer',
            label: 'All people',
            values: { age: 90 },
          },
        ],
      },
    });

    expect(
      screen.getByRole('rowheader', { name: /Subtotal: Current page total/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('rowheader', { name: /Footer: All people/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(data.length + 1);
    expect(
      container.querySelectorAll('tbody.data-table__body--structural input'),
    ).toHaveLength(0);
    expect(container.querySelector('tfoot')).toContainElement(
      screen.getByRole('rowheader', { name: /Footer: All people/ }),
    );
  });

  it('uses controlled width and pin state for the accessible header resize control', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: {
        columnWidths: [{ columnId: 'name', width: 120 }],
        columnPinning: [{ columnId: 'name', position: 'start' }],
      },
    });
    const { container } = render(DataTable, {
      props: {
        data,
        columns: [{ ...columns[0], resizable: true }, columns[1]],
        controller,
      },
    });

    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    expect(nameHeader).toHaveClass('data-table__cell--pinned-start');
    expect(nameHeader).toHaveStyle({ width: '120px', left: '0px' });
    expect(nameHeader).toHaveAttribute('data-column-id', 'name');
    const separator = screen.getByRole('separator', { name: 'Resize Name' });
    separator.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(controller.getState().columnWidths).toContainEqual({
      columnId: 'name',
      width: 128,
    });
    expect(container.querySelector('[data-column-id="name"]')).toHaveAttribute(
      'data-column-id',
      'name',
    );
  });

  it('keeps statically hidden columns hidden when a controller restores them visible', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
      initialState: {
        columnVisibility: [
          { columnId: 'name', visible: true },
          { columnId: 'age', visible: true },
        ],
      },
    });
    render(DataTable, {
      props: {
        data,
        columns: [columns[0], { ...columns[1], hidden: true }],
        controller,
      },
    });

    await vi.waitFor(() =>
      expect(controller.getState().columnVisibility).toContainEqual({
        columnId: 'age',
        visible: false,
      }),
    );
    expect(
      screen.queryByRole('columnheader', { name: 'Age' }),
    ).not.toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    await expectNoA11yViolations(container);
  });
});
