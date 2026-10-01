import { describe, expect, it } from 'vitest';
import {
  compareListValues,
  isValidListSort,
  type ListSortSpec,
  listSortAria,
  listSortHref,
  listSortOrderBy,
  listSortSearchParams,
  parseListSort,
  sortListRows,
  toggleListSort,
} from '../list-sort.js';

const spec: ListSortSpec = {
  columns: [
    { id: 'published', firstDirection: 'desc' },
    'title',
    { id: 'views', firstDirection: 'desc' },
  ],
  default: { columnId: 'published', direction: 'desc' },
};

describe('list sort', () => {
  it('parses the URL, falling back to the default for unknown values', () => {
    expect(parseListSort(new URLSearchParams(''), spec)).toEqual(spec.default);
    expect(
      parseListSort(new URLSearchParams('sort=title&dir=desc'), spec),
    ).toEqual({
      columnId: 'title',
      direction: 'desc',
    });
    expect(parseListSort(new URLSearchParams('sort=title'), spec)).toEqual({
      columnId: 'title',
      direction: 'asc',
    });
    expect(parseListSort(new URLSearchParams('sort=views'), spec)).toEqual({
      columnId: 'views',
      direction: 'desc',
    });
    expect(
      parseListSort(new URLSearchParams('sort=password&dir=asc'), spec),
    ).toEqual(spec.default);
    expect(parseListSort(new URLSearchParams('dir=asc'), spec)).toEqual({
      columnId: 'published',
      direction: 'asc',
    });
    expect(
      parseListSort(new URLSearchParams('sort=title&dir=sideways'), spec),
    ).toEqual({
      columnId: 'title',
      direction: 'asc',
    });
  });

  it('toggles asc/desc and starts a new column at its first direction', () => {
    const start = spec.default;
    expect(toggleListSort(start, 'published', spec)).toEqual({
      columnId: 'published',
      direction: 'asc',
    });
    expect(
      toggleListSort(
        { columnId: 'published', direction: 'asc' },
        'published',
        spec,
      ),
    ).toEqual(start);
    expect(toggleListSort(start, 'title', spec)).toEqual({
      columnId: 'title',
      direction: 'asc',
    });
    expect(toggleListSort(start, 'views', spec)).toEqual({
      columnId: 'views',
      direction: 'desc',
    });
    expect(toggleListSort(start, 'nope', spec)).toBe(start);
    expect(isValidListSort(spec, { columnId: 'nope', direction: 'asc' })).toBe(
      false,
    );
  });

  it('writes the sort to the URL, omits the default, and resets the page', () => {
    const params = listSortSearchParams(
      'status=draft&page=3',
      { columnId: 'title', direction: 'asc' },
      spec,
    );
    expect(params.toString()).toBe('status=draft&sort=title&dir=asc');
    expect(
      listSortSearchParams(
        'sort=title&dir=asc&page=2',
        spec.default,
        spec,
      ).toString(),
    ).toBe('');
    expect(
      listSortSearchParams(
        'sort=title&dir=asc&page=2',
        { columnId: 'title', direction: 'asc' },
        spec,
      ).toString(),
    ).toBe('sort=title&dir=asc&page=2');
    expect(
      listSortHref(
        new URL('https://x.test/a?page=2'),
        { columnId: 'views', direction: 'desc' },
        spec,
      ),
    ).toBe('/a?sort=views&dir=desc');
    expect(
      listSortHref(new URL('https://x.test/a?page=2'), spec.default, spec),
    ).toBe('/a?page=2');
  });

  it('reports aria-sort', () => {
    expect(listSortAria(spec.default, 'published')).toBe('descending');
    expect(listSortAria({ columnId: 'title', direction: 'asc' }, 'title')).toBe(
      'ascending',
    );
    expect(listSortAria(spec.default, 'title')).toBe('none');
  });

  it('sorts rows stably with empty values last in both directions', () => {
    const rows = [
      { id: 1, at: '2026-01-02' },
      { id: 2, at: null },
      { id: 3, at: '2026-03-01' },
      { id: 4, at: '2026-01-02' },
    ];
    const value = (row: (typeof rows)[number]) => row.at;
    expect(
      sortListRows(rows, { columnId: 'at', direction: 'desc' }, value).map(
        (r) => r.id,
      ),
    ).toEqual([3, 1, 4, 2]);
    expect(
      sortListRows(rows, { columnId: 'at', direction: 'asc' }, value).map(
        (r) => r.id,
      ),
    ).toEqual([1, 4, 3, 2]);
    expect(compareListValues('item 2', 'item 10', 'asc')).toBeLessThan(0);
    expect(
      compareListValues(new Date('2026-01-01'), new Date('2025-01-01'), 'desc'),
    ).toBeLessThan(0);
  });

  it('builds ORDER BY only from the allow-list', () => {
    const map = {
      published: 'COALESCE(c.publish_date, c.created_at)',
      title: 'c.title',
    };
    expect(listSortOrderBy(spec.default, map)).toBe(
      'COALESCE(c.publish_date, c.created_at) DESC NULLS LAST',
    );
    expect(
      listSortOrderBy({ columnId: 'title', direction: 'asc' }, map, {
        nulls: false,
      }),
    ).toBe('c.title ASC');
    expect(() =>
      listSortOrderBy({ columnId: 'title; drop', direction: 'asc' }, map),
    ).toThrow();
  });
});
