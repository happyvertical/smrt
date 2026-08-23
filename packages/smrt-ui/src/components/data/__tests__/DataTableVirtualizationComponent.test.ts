import { fireEvent, render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import DataTable from '../DataTable.svelte';
import { createDataTableController } from '../DataTableController.js';

interface Row {
  id: string;
  name: string;
}

interface IdentityRow {
  id: string | number;
  name: string;
}

const rows: Row[] = Array.from({ length: 100 }, (_, index) => ({
  id: `row-${index}`,
  name: `Record ${index.toString().padStart(5, '0')}`,
}));
const columns = [{ id: 'name', label: 'Name', accessor: 'name' }];
const virtualization = { rowHeight: 20, viewportHeight: 100, overscan: 1 };

function getScrollContainer(container: HTMLElement): HTMLDivElement {
  const node = container.querySelector<HTMLDivElement>('.data-table-container');
  if (!node) throw new Error('Expected DataTable scroll container');
  return node;
}

describe('DataTable virtualization seam', () => {
  it('renders only a fixed-height body window with accessible row context', async () => {
    const { container } = render(DataTable, {
      props: { data: rows, columns, rowKey: 'id', virtualization },
    });
    const scrollContainer = getScrollContainer(container);

    expect(
      screen.getByRole('columnheader', { name: 'Name' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '101');
    expect(getScrollContainer(container)).toHaveAttribute('role', 'region');
    expect(getScrollContainer(container)).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Record 00000')).toBeInTheDocument();
    expect(screen.getByText('Record 00000').closest('tr')).toHaveAttribute(
      'aria-rowindex',
      '2',
    );
    expect(screen.queryByText('Record 00020')).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('.data-table__virtual-spacer'),
    ).toHaveLength(1);

    scrollContainer.scrollTop = 200;
    await fireEvent.scroll(scrollContainer);

    await vi.waitFor(() => {
      expect(screen.queryByText('Record 00000')).not.toBeInTheDocument();
      expect(screen.getByText('Record 00010')).toBeInTheDocument();
    });
    expect(screen.getByText('Record 00010').closest('tr')).toHaveAttribute(
      'aria-rowindex',
      '12',
    );
    expect(
      container.querySelectorAll('.data-table__virtual-spacer'),
    ).toHaveLength(2);
  });

  it('keeps manual pages and selected stable IDs independent of the rendered window', async () => {
    const footer = createRawSnippet(() => ({
      render: () => '<strong>Remote summary</strong>',
    }));
    const controller = createDataTableController({
      columnIds: ['name'],
      modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
      initialState: { page: 12, pageSize: 100 },
    });
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'id',
        selectable: true,
        controller,
        totalRows: 10_000,
        footer,
        virtualization,
      },
    });
    const scrollContainer = getScrollContainer(container);

    expect(screen.getByRole('table')).toHaveAttribute('aria-rowcount', '10002');
    expect(screen.getByText('Remote summary').closest('tr')).toHaveAttribute(
      'aria-rowindex',
      '10002',
    );
    await userEvent.click(
      screen.getAllByRole('checkbox', { name: 'Select row' })[0],
    );
    expect(controller.getState().selectedRowIds).toEqual(['row-0']);

    scrollContainer.scrollTop = 400;
    await fireEvent.scroll(scrollContainer);
    await vi.waitFor(() =>
      expect(screen.getByText('Record 00020')).toBeInTheDocument(),
    );
    expect(screen.getByText('Record 00020').closest('tr')).toHaveAttribute(
      'aria-rowindex',
      '1122',
    );

    expect(controller.getState().selectedRowIds).toEqual(['row-0']);
    expect(screen.queryByText('Record 00099')).not.toBeInTheDocument();
  });

  it('restores a controlled focused row by stable identity and reports row focus', async () => {
    const onFocusedRowIdChange = vi.fn();
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'id',
        onRowClick: () => undefined,
        virtualization: {
          ...virtualization,
          focusedRowId: 'row-40',
          onFocusedRowIdChange,
        },
      },
    });
    const scrollContainer = getScrollContainer(container);

    const focusedRow = await screen.findByText('Record 00040');
    expect(scrollContainer.scrollTop).toBeGreaterThan(0);
    expect(document.activeElement).toBe(focusedRow.closest('tr'));
    expect(onFocusedRowIdChange).toHaveBeenCalledWith('row-40');
  });

  it('restores focus without aliasing numeric and string row identities', async () => {
    const identityRows: IdentityRow[] = [
      { id: 1, name: 'Numeric row' },
      { id: '1', name: 'String row' },
    ];
    const { container } = render(DataTable, {
      props: {
        data: identityRows,
        columns,
        rowKey: 'id',
        virtualization: { ...virtualization, focusedRowId: '1' },
      },
    });

    const stringRow = await screen.findByText('String row');
    expect(stringRow.closest('tr')).toHaveAttribute('data-row-id', 'string:1');
    expect(document.activeElement).toBe(stringRow.closest('tr'));
    expect(container.querySelector('tr[data-row-id="number:1"]')).toBeTruthy();
  });

  it('scrolls the virtual body from the keyboard-accessible region', async () => {
    const onScrollTopChange = vi.fn();
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'id',
        virtualization: { ...virtualization, onScrollTopChange },
      },
    });
    const scrollContainer = getScrollContainer(container);

    scrollContainer.focus();
    await fireEvent.keyDown(scrollContainer, { key: 'PageDown' });

    expect(scrollContainer.scrollTop).toBe(80);
    expect(onScrollTopChange).toHaveBeenCalledWith(80);
    await vi.waitFor(() =>
      expect(screen.getByText('Record 00004')).toBeInTheDocument(),
    );
  });

  it('stripes virtual rows by their logical display index', async () => {
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'id',
        striped: true,
        virtualization,
      },
    });
    const scrollContainer = getScrollContainer(container);

    scrollContainer.scrollTop = 40;
    await fireEvent.scroll(scrollContainer);

    await vi.waitFor(() =>
      expect(screen.getByText('Record 00001')).toBeInTheDocument(),
    );
    expect(screen.getByText('Record 00001').closest('tr')).toHaveClass(
      'data-table__row--striped',
    );
    expect(screen.getByText('Record 00002').closest('tr')).not.toHaveClass(
      'data-table__row--striped',
    );
  });

  it('keeps the summary footer reachable at the end of the virtual scroll range', async () => {
    const footer = createRawSnippet(() => ({
      render: () => '<strong>Summary total</strong>',
    }));
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function () {
        return this.tagName === 'TFOOT' ? 24 : 0;
      });
    const onScrollTopChange = vi.fn();

    try {
      const { container } = render(DataTable, {
        props: {
          data: rows,
          columns,
          rowKey: 'id',
          footer,
          virtualization: { ...virtualization, onScrollTopChange },
        },
      });
      const scrollContainer = getScrollContainer(container);

      await fireEvent.keyDown(scrollContainer, { key: 'End' });

      expect(scrollContainer.scrollTop).toBe(1_924);
      expect(onScrollTopChange).toHaveBeenCalledWith(1_924);
      expect(screen.getByText('Summary total')).toBeInTheDocument();
    } finally {
      offsetHeight.mockRestore();
    }
  });

  it('falls back for expansion without virtual scroll behavior', async () => {
    const expandedContent = createRawSnippet(() => ({
      render: () => '<p>Variable detail</p>',
    }));
    const footer = createRawSnippet(() => ({
      render: () => '<strong>Summary total</strong>',
    }));
    const onScrollTopChange = vi.fn();
    const { container } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'id',
        expandedContent,
        footer,
        virtualization: { ...virtualization, onScrollTopChange },
      },
    });

    expect(screen.getByText('Record 00099')).toBeInTheDocument();
    expect(screen.getByText('Summary total')).toBeInTheDocument();
    expect(container.querySelector('.data-table__virtual-spacer')).toBeNull();
    const scrollContainer = getScrollContainer(container);
    expect(scrollContainer).not.toHaveAttribute('tabindex');
    scrollContainer.scrollTop = 200;
    await fireEvent.scroll(scrollContainer);
    expect(onScrollTopChange).not.toHaveBeenCalled();
  });

  it('is axe-clean with virtual spacer rows', async () => {
    const { container } = render(DataTable, {
      props: { data: rows, columns, rowKey: 'id', virtualization },
    });

    await expectNoA11yViolations(container);
  });
});
