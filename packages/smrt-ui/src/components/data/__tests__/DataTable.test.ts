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
  name: string;
  age: number;
}

const columns = [
  { id: 'name', label: 'Name', accessor: 'name', sortable: true },
  { id: 'age', label: 'Age', accessor: 'age' },
];
const data: Person[] = [
  { name: 'Ada', age: 36 },
  { name: 'Linus', age: 54 },
];

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
        data: [...data, { name: 'Grace', age: 85 }],
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
        data: [...data, { name: 'Grace', age: 85 }],
        columns,
        controller,
      },
    });

    const names = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(names).toEqual(expected);
  });

  it('keeps fallback selection keys unique across pages', async () => {
    const onSelectionChange = vi.fn();
    render(DataTable, {
      props: {
        data,
        columns,
        pageSize: 1,
        selectable: true,
        onSelectionChange,
      },
    });

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select all rows' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select all rows' }),
    );

    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set([0, 1]));
  });

  it('does not carry fallback expansion keys onto the next page', async () => {
    render(DataTable, {
      props: {
        data,
        columns,
        pageSize: 1,
        expandedContent: createRawSnippet(() => ({
          render: () => '<p>Row detail</p>',
        })),
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Expand row' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(screen.queryByText('Row detail')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Expand row' }),
    ).toBeInTheDocument();
  });

  it('reveals expandable row content', async () => {
    render(DataTable, {
      props: {
        data,
        columns,
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

  it('is axe-clean', async () => {
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    await expectNoA11yViolations(container);
  });
});
