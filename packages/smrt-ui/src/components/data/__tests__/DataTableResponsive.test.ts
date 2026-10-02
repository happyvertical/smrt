import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import DataTable from '../DataTable.svelte';
import { createDataTableController } from '../DataTableController.js';
import { responsiveColumns } from '../DataTableResponsive.js';
import type { DataTableColumn } from '../types.js';

const columns: DataTableColumn<Record<string, string>>[] = Array.from(
  { length: 6 },
  (_, index) => ({
    id: `c${index}`,
    label: `Column ${index}`,
    responsive: { priority: index, keepVisible: index === 0 },
    headerPath: [{ id: 'group', label: 'Group' }],
  }),
);
const data = [
  {
    id: 'row',
    ...Object.fromEntries(columns.map((column) => [column.id, column.label])),
  },
];
async function resize(container: HTMLElement, width: number) {
  const root = container.querySelector('.data-table-container');
  Object.defineProperty(root, 'clientWidth', {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
  await waitFor(() =>
    expect(root).toHaveClass(
      width <= 800 ? 'data-table-container--narrow' : 'data-table-container',
    ),
  );
}

describe('responsive column collapse', () => {
  it('keeps mandatory columns and highest priorities in display order', () => {
    expect(
      responsiveColumns(columns, 390, 160).map((column) => column.id),
    ).toEqual(['c0', 'c5']);
    expect(
      responsiveColumns(columns, 768, 160).map((column) => column.id),
    ).toEqual(['c0', 'c3', 'c4', 'c5']);
  });
  it('handles missing metadata, equal priorities, invalid numbers, and oversized mandatory sets', () => {
    const plain = columns.map((column) => ({
      ...column,
      responsive: undefined,
    }));
    expect(
      responsiveColumns(plain, 320, Number.NaN).map((column) => column.id),
    ).toEqual(['c0', 'c1']);
    expect(
      responsiveColumns(
        [{ ...plain[0], responsive: { priority: Number.NaN } }, plain[1]],
        160,
        160,
      ).map((column) => column.id),
    ).toEqual(['c0']);
    expect(
      responsiveColumns(
        columns.map((column) => ({
          ...column,
          responsive: { keepVisible: true },
        })),
        100,
        160,
      ),
    ).toHaveLength(6);
    expect(responsiveColumns([], 0, 160)).toEqual([]);
  });
  it('matches headers/cells/groups to container width and restores without mutating controller visibility', async () => {
    const controller = createDataTableController({
      initialState: { columnVisibility: [{ columnId: 'c5', visible: false }] },
    });
    const { container } = render(DataTable, {
      props: {
        data,
        columns,
        rowKey: 'id',
        controller,
        responsiveMode: 'hide-columns',
      },
    });
    const visibility = controller.getState().columnVisibility;
    await resize(container, 390);
    await waitFor(() => expect(screen.getAllByRole('cell')).toHaveLength(2));
    expect(screen.getByRole('columnheader', { name: 'Group' })).toHaveAttribute(
      'colspan',
      '2',
    );
    expect(screen.queryByRole('columnheader', { name: 'Column 5' })).toBeNull();
    expect(
      screen.getByRole('columnheader', { name: 'Column 4' }),
    ).toBeInTheDocument();
    expect(controller.getState().columnVisibility).toEqual(visibility);
    await resize(container, 1200);
    await waitFor(() => expect(screen.getAllByRole('cell')).toHaveLength(5));
    expect(screen.getByRole('columnheader', { name: 'Group' })).toHaveAttribute(
      'colspan',
      '5',
    );
  });
  it('preserves the scroll default regardless of narrow width', async () => {
    const { container } = render(DataTable, { props: { data, columns } });
    const root = container.querySelector('.data-table-container');
    Object.defineProperty(root, 'clientWidth', {
      configurable: true,
      value: 390,
    });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(screen.getAllByRole('cell')).toHaveLength(6));
    expect(root).not.toHaveClass('data-table-container--narrow');
  });
});
