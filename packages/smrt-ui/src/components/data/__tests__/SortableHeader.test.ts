import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ListSortSelect from '../ListSortSelect.svelte';
import type { ListSortSpec } from '../list-sort.js';
import SortableHeader from '../SortableHeader.svelte';

const spec: ListSortSpec = {
  columns: [{ id: 'published', firstDirection: 'desc' }, 'title'],
  default: { columnId: 'published', direction: 'desc' },
};

describe('SortableHeader', () => {
  it('marks the sorted column with aria-sort and an arrow, and labels the next action', () => {
    render(SortableHeader, {
      props: {
        columnId: 'published',
        label: 'Published',
        sort: spec.default,
        spec,
        as: 'div',
      },
    });
    const header = screen.getByRole('columnheader');
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(header.textContent).toContain('↓');
    expect(
      screen.getByRole('button', { name: 'Sort by Published, ascending' }),
    ).toBeTruthy();
  });

  it('calls onSort from a button (keyboard-activatable) for client lists', async () => {
    const onSort = vi.fn();
    render(SortableHeader, {
      props: {
        columnId: 'title',
        label: 'Title',
        sort: spec.default,
        spec,
        onSort,
        as: 'div',
      },
    });
    const header = screen.getByRole('columnheader');
    expect(header.getAttribute('aria-sort')).toBe('none');
    const button = screen.getByRole('button', {
      name: 'Sort by Title, ascending',
    });
    await fireEvent.click(button);
    expect(onSort).toHaveBeenCalledWith('title');
  });

  it('renders a link for server-sorted lists', () => {
    render(SortableHeader, {
      props: {
        columnId: 'title',
        label: 'Title',
        sort: { columnId: 'title', direction: 'asc' },
        spec,
        href: '/list?sort=title&dir=desc',
        as: 'div',
      },
    });
    const link = screen.getByRole('link', {
      name: 'Sort by Title, descending',
    });
    expect(link.getAttribute('href')).toBe('/list?sort=title&dir=desc');
    expect(screen.getByRole('columnheader').getAttribute('aria-sort')).toBe(
      'ascending',
    );
  });
});

describe('ListSortSelect', () => {
  it('offers plain-language orders and reports the chosen sort', async () => {
    const onChange = vi.fn();
    render(ListSortSelect, {
      props: {
        columns: [
          { id: 'published', label: 'Published', kind: 'date' },
          { id: 'title', label: 'Title' },
        ],
        sort: spec.default,
        onChange,
      },
    });
    const select = screen.getByLabelText('Sort by') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Published, newest first',
      'Published, oldest first',
      'Title, A–Z',
      'Title, Z–A',
    ]);
    expect(select.value).toBe('published:desc');
    await fireEvent.change(select, { target: { value: 'title:asc' } });
    expect(onChange).toHaveBeenCalledWith({
      columnId: 'title',
      direction: 'asc',
    });
  });
});

describe('SortableHeader style hooks', () => {
  it('reads its control weight from --sortable-header-font-weight (default 600)', () => {
    const source = readFileSync(
      join(
        process.cwd().endsWith('packages/smrt-ui')
          ? process.cwd()
          : join(process.cwd(), 'packages/smrt-ui'),
        'src/components/data/SortableHeader.svelte',
      ),
      'utf8',
    );
    expect(source).toMatch(
      /font-weight:\s*var\(--sortable-header-font-weight,\s*600\)/,
    );
    expect(source).toMatch(/padding:\s*var\(--sortable-header-padding,/);
  });
});
