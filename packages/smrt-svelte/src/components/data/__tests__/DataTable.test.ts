/**
 * Golden test for DataTable (Sweep L4, #1423).
 *
 * Covers the semantic table structure (caption → accessible name, column
 * headers, cells, row count), the empty state, sortable-header interaction
 * (aria-sort transition), and axe-cleanliness.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
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

  it('is axe-clean', async () => {
    const { container } = render(DataTable, {
      props: { data, columns, caption: 'People' },
    });
    await expectNoA11yViolations(container);
  });
});
