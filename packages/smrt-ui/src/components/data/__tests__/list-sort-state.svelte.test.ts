import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ListSortSelect from '../ListSortSelect.svelte';
import type { ListSortSpec } from '../list-sort.js';
import {
  createLocalListSort,
  createUrlListSort,
} from '../list-sort-state.svelte.js';
import SortableHeader from '../SortableHeader.svelte';

const spec: ListSortSpec = {
  columns: [{ id: 'published', firstDirection: 'desc' }, 'title'],
  default: { columnId: 'published', direction: 'desc' },
};

describe('list sort state', () => {
  it('local: starts at the default and toggles', () => {
    const list = createLocalListSort(spec);
    expect(list.sort).toEqual(spec.default);
    list.toggle('title');
    expect(list.sort).toEqual({ columnId: 'title', direction: 'asc' });
    list.toggle('title');
    expect(list.sort).toEqual({ columnId: 'title', direction: 'desc' });
    expect(list.href('title')).toBeUndefined();
  });

  it('url: reads the URL, links headers, and navigates on set', async () => {
    let url = new URL('https://x.test/list?sort=title&dir=asc&page=3');
    const navigate = vi.fn((href: string) => {
      url = new URL(href, url);
    });
    const list = createUrlListSort(spec, { url: () => url, navigate });
    expect(list.sort).toEqual({ columnId: 'title', direction: 'asc' });
    expect(list.href('title')).toBe('/list?sort=title&dir=desc');
    expect(list.href('published')).toBe('/list');
    await list.set({ columnId: 'published', direction: 'asc' });
    expect(navigate).toHaveBeenCalledWith('/list?sort=published&dir=asc');
  });

  it('ignores an undeclared column or unknown direction on set', async () => {
    const local = createLocalListSort(spec);
    local.set({ columnId: 'secret_score', direction: 'asc' });
    expect(local.sort).toEqual(spec.default);
    local.set({ columnId: 'title', direction: 'sideways' as never });
    expect(local.sort).toEqual(spec.default);
    local.set({ columnId: 'title', direction: 'asc' });
    expect(local.sort).toEqual({ columnId: 'title', direction: 'asc' });

    // An invalid initial sort starts at the default.
    expect(
      createLocalListSort(spec, { columnId: 'nope', direction: 'asc' }).sort,
    ).toEqual(spec.default);

    const navigate = vi.fn();
    const url = new URL('https://x.test/list');
    const remote = createUrlListSort(spec, { url: () => url, navigate });
    await remote.set({ columnId: 'secret_score', direction: 'desc' });
    await remote.set(null as never);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('drives SortableHeader and ListSortSelect through `list`', async () => {
    const list = createLocalListSort(spec);
    render(SortableHeader, {
      props: { list, columnId: 'title', label: 'Title', as: 'div' },
    });
    const header = screen.getByRole('columnheader');
    expect(header.getAttribute('aria-sort')).toBe('none');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Sort by Title, ascending' }),
    );
    expect(list.sort).toEqual({ columnId: 'title', direction: 'asc' });

    render(ListSortSelect, {
      props: {
        list,
        columns: [
          { id: 'published', label: 'Published', kind: 'date' },
          { id: 'title', label: 'Title' },
        ],
      },
    });
    const select = screen.getByLabelText('Sort by') as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: 'published:desc' } });
    expect(list.sort).toEqual(spec.default);
  });
});
