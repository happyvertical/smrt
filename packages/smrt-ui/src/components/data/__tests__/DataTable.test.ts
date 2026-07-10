/**
 * Golden test for DataTable (Sweep L4, #1423).
 *
 * Covers the semantic table structure (caption → accessible name, column
 * headers, cells, row count), the empty state, sortable-header interaction
 * (aria-sort transition), and axe-cleanliness.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DataTable from '../DataTable.svelte';

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
