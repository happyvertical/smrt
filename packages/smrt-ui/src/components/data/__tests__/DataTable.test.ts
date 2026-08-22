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

  it('toggles aria-sort when a sortable header is activated', async () => {
    render(DataTable, { props: { data, columns, sortable: true } });
    const nameHeader = screen.getByRole('columnheader', { name: 'Name' });
    // aria-sort is only present on the actively-sorted column.
    expect(nameHeader).not.toHaveAttribute('aria-sort');
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
  });

  it('routes a human sort click through the same controller transition as a command', async () => {
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const before = controller.getState();
    render(DataTable, { props: { data, columns, sortable: true, controller } });

    await userEvent.click(screen.getByRole('button', { name: 'Name' }));

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
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
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
      screen.getAllByRole('checkbox', { name: 'Select row' })[0],
    );
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Expand row' })[0],
    );
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

  it('reveals expandable row content', async () => {
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
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Expand row' })[0],
    );
    expect(screen.getByText('Row detail')).toBeInTheDocument();
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
    });
    await expectNoA11yViolations(container);
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

  it('is axe-clean', async () => {
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    await expectNoA11yViolations(container);
  });
});
