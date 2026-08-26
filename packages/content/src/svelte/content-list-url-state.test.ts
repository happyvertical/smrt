import type { DataTableViewState } from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import {
  createContentListController,
  normalizeContentListFilterValue,
} from './content-list-controller.js';
import {
  applyContentListViewState,
  CONTENT_LIST_MAX_PAGE_SIZE,
  contentListViewStateFromSearchParams,
  contentListViewStateToSearchParams,
  mergeContentListViewStateIntoSearchParams,
  readContentListViewStateFromSearchParams,
  sanitizeContentListViewState,
} from './content-list-url-state.js';

const fullState: Partial<DataTableViewState> = {
  search: 'budget',
  filters: [
    { columnId: 'type', operator: 'equals', value: 'article' },
    { columnId: 'status', operator: 'in', value: ['draft', 'published'] },
    { columnId: 'title', operator: 'contains', value: 'zoning' },
    { columnId: 'author', operator: 'isNotNull' },
    { columnId: 'updated', operator: 'gte', value: '2026-01-01' },
  ],
  sorting: [
    { columnId: 'updated', direction: 'desc' },
    { columnId: 'title', direction: 'asc' },
  ],
  page: 3,
  pageSize: 25,
};

const cleanState: Partial<DataTableViewState> = {
  search: '',
  filters: [],
  sorting: [],
  page: 1,
  pageSize: null,
};

describe('content list URL state', () => {
  it('round-trips a fully populated view through the query string', () => {
    const params = contentListViewStateToSearchParams(fullState);
    expect(contentListViewStateFromSearchParams(params)).toEqual(fullState);
  });

  it('writes compact, human-legible parameters rather than an opaque blob', () => {
    const params = contentListViewStateToSearchParams(fullState);
    expect(params.get('q')).toBe('budget');
    expect(params.get('type')).toBe('article');
    expect(params.get('status.in')).toBe('draft,published');
    expect(params.get('title.contains')).toBe('zoning');
    expect(params.get('author.isNotNull')).toBe('1');
    expect(params.get('updated.gte')).toBe('2026-01-01');
    expect(params.get('sort')).toBe('-updated,title');
    expect(params.get('page')).toBe('3');
    expect(params.get('size')).toBe('25');
  });

  it('omits every default so a clean view produces a clean URL', () => {
    expect(contentListViewStateToSearchParams(cleanState).toString()).toBe('');
    expect(contentListViewStateToSearchParams({}).toString()).toBe('');
  });

  it('restores defaults for parameters a clean URL omits', () => {
    expect(contentListViewStateFromSearchParams(new URLSearchParams())).toEqual(
      cleanState,
    );
  });

  it('honours a caller-declared default page size in both directions', () => {
    const options = { defaultPageSize: 25 };
    expect(
      contentListViewStateToSearchParams(
        { ...cleanState, pageSize: 25 },
        options,
      ).toString(),
    ).toBe('');
    expect(
      contentListViewStateFromSearchParams(new URLSearchParams(), options)
        .pageSize,
    ).toBe(25);
    expect(
      contentListViewStateToSearchParams(
        { ...cleanState, pageSize: null },
        options,
      ).get('size'),
    ).toBe('all');
    expect(
      contentListViewStateFromSearchParams(
        new URLSearchParams('size=all'),
        options,
      ).pageSize,
    ).toBeNull();
  });

  it('drops a filter or sort on a column the adapter does not publish', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('evil.contains=payload&sort=-evil'),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.state.sorting).toEqual([]);
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        { scope: 'filter', reason: 'unknown-column', columnId: 'evil' },
        { scope: 'sorting', reason: 'unknown-column', columnId: 'evil' },
      ]),
    );
  });

  it('ignores foreign parameters instead of reporting them as filters', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('utm_source=newsletter&redirect=/admin'),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.dropped).toEqual([]);
  });

  it('drops the hidden, search-only description column', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('description=classified&sort=description'),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.state.sorting).toEqual([]);
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        { scope: 'filter', reason: 'hidden-column', columnId: 'description' },
        { scope: 'sorting', reason: 'hidden-column', columnId: 'description' },
      ]),
    );
  });

  it('drops the structural select and actions columns', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('select=1&actions.contains=delete&sort=-actions'),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.state.sorting).toEqual([]);
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        { scope: 'filter', reason: 'structural-column', columnId: 'select' },
        { scope: 'filter', reason: 'structural-column', columnId: 'actions' },
        { scope: 'sorting', reason: 'structural-column', columnId: 'actions' },
      ]),
    );
  });

  it('drops a filter whose operator is outside the allowed set', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('title.regex=.%2A&status.eval=1'),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        {
          scope: 'filter',
          reason: 'unsupported-operator',
          columnId: 'title',
          detail: 'regex',
        },
        {
          scope: 'filter',
          reason: 'unsupported-operator',
          columnId: 'status',
          detail: 'eval',
        },
      ]),
    );
  });

  it('never serializes an unauthorized filter, even from a caller state', () => {
    const params = contentListViewStateToSearchParams({
      ...cleanState,
      filters: [
        { columnId: 'description', operator: 'contains', value: 'secret' },
        { columnId: 'select', operator: 'equals', value: 'all' },
        { columnId: 'ghost', operator: 'equals', value: 'x' },
      ],
      sorting: [{ columnId: 'description', direction: 'asc' }],
    });
    expect(params.toString()).toBe('');
  });

  it('tolerates missing and garbage parameters without throwing', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams(
        'page=abc&size=-4&sort=&type=&title.contains=&status.in=',
      ),
    );
    expect(reading.state).toEqual(cleanState);
    expect(reading.dropped.length).toBeGreaterThan(0);
    expect(() =>
      contentListViewStateFromSearchParams(new URLSearchParams('sort=-')),
    ).not.toThrow();
    expect(sanitizeContentListViewState(null)).toEqual({
      state: {},
      dropped: [{ scope: 'state', reason: 'malformed' }],
    });
    expect(sanitizeContentListViewState('nonsense').state).toEqual({});
  });

  it('normalizes filter values exactly as the adapter does', () => {
    const state = contentListViewStateFromSearchParams(
      new URLSearchParams(
        'type=%20ARTICLE%20&status=Draft&title.contains=Zoning',
      ),
    );
    expect(state.filters).toEqual([
      {
        columnId: 'type',
        operator: 'equals',
        value: normalizeContentListFilterValue('type', ' ARTICLE '),
      },
      {
        columnId: 'status',
        operator: 'equals',
        value: normalizeContentListFilterValue('status', 'Draft'),
      },
      {
        columnId: 'title',
        operator: 'contains',
        value: normalizeContentListFilterValue('title', 'Zoning'),
      },
    ]);
    expect(state.filters?.[0].value).toBe('article');
    expect(state.filters?.[1].value).toBe('draft');
  });

  it('refuses a non-scalar filter value from a crafted state', () => {
    const { state, dropped } = sanitizeContentListViewState({
      filters: [
        { columnId: 'title', operator: 'equals', value: { $ne: null } },
        { columnId: 'title', operator: 'in', value: 'not-an-array' },
      ],
    });
    expect(state.filters).toEqual([]);
    expect(dropped).toHaveLength(2);
    expect(dropped.every((drop) => drop.reason === 'unsupported-value')).toBe(
      true,
    );
  });

  it('clamps an oversized page size to the surface row budget', () => {
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('size=1000000'),
    );
    expect(reading.state.pageSize).toBe(CONTENT_LIST_MAX_PAGE_SIZE);
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        { scope: 'pageSize', reason: 'out-of-range', detail: '1000000' },
      ]),
    );
  });

  it('never restores selection or expansion from a link', () => {
    const params = contentListViewStateToSearchParams({
      ...fullState,
      selection: { scope: 'explicit', rowIds: ['content-1'] },
      selectedRowIds: ['content-1'],
      expandedRowIds: ['content-2'],
    });
    expect(params.toString()).not.toContain('content-1');
    const state = contentListViewStateFromSearchParams(params);
    expect(state.selection).toBeUndefined();
    expect(state.selectedRowIds).toBeUndefined();
    expect(state.expandedRowIds).toBeUndefined();
  });

  it('namespaces parameters with a prefix and reports refused prefixed keys', () => {
    const options = { prefix: 'list_' };
    const params = contentListViewStateToSearchParams(fullState, options);
    expect(params.get('list_q')).toBe('budget');
    expect(params.get('q')).toBeNull();
    expect(contentListViewStateFromSearchParams(params, options)).toEqual(
      fullState,
    );
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('list_ghost=1&q=other-list'),
      options,
    );
    expect(reading.state.search).toBe('');
    expect(reading.dropped).toEqual(
      expect.arrayContaining([
        { scope: 'filter', reason: 'unknown-column', columnId: 'ghost' },
      ]),
    );
  });

  it('preserves parameters it does not own when merging', () => {
    const merged = mergeContentListViewStateIntoSearchParams(
      new URLSearchParams('utm_source=newsletter&type=mirror&page=9'),
      { ...cleanState, filters: [], search: 'audit' },
    );
    expect(merged.get('utm_source')).toBe('newsletter');
    expect(merged.get('type')).toBeNull();
    expect(merged.get('page')).toBeNull();
    expect(merged.get('q')).toBe('audit');
  });

  it('applies a restored patch to a controller without touching selection', () => {
    const controller = createContentListController({ pageSize: 10 });
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: ['content-1', 'content-2'],
    });
    const patch = contentListViewStateFromSearchParams(
      new URLSearchParams('q=budget&type=article&sort=-updated&page=2&size=10'),
    );
    applyContentListViewState(controller, patch);
    const state = controller.getState();
    expect(state.search).toBe('budget');
    expect(state.filters).toEqual([
      { columnId: 'type', operator: 'equals', value: 'article' },
    ]);
    expect(state.sorting).toEqual([{ columnId: 'updated', direction: 'desc' }]);
    expect(state.page).toBe(2);
    expect(state.pageSize).toBe(10);
    expect(state.selectedRowIds).toEqual(['content-1', 'content-2']);
  });

  it('keeps a crafted hidden-column filter away from the controller', () => {
    // The controller's own known-column list includes `description`, so
    // without this validator a crafted link would restore a filter on the
    // search-only column the surface never publishes.
    const controller = createContentListController();
    const patch = contentListViewStateFromSearchParams(
      new URLSearchParams('description=classified'),
    );
    applyContentListViewState(controller, patch);
    expect(controller.getState().filters).toEqual([]);
  });
});

describe('content list projection validation', () => {
  it('drops projection entries for columns the table does not render', () => {
    const { state, dropped } = sanitizeContentListViewState({
      columnOrder: ['title', 'ghost', 'select'],
      columnWidths: [
        { columnId: 'title', width: 200 },
        { columnId: 'ghost', width: 200 },
      ],
      columnPinning: [
        { columnId: 'select', position: 'start' },
        { columnId: 'ghost', position: 'end' },
      ],
    });
    expect(state.columnOrder).toEqual(['title', 'select']);
    expect(state.columnWidths).toEqual([{ columnId: 'title', width: 200 }]);
    expect(state.columnPinning).toEqual([
      { columnId: 'select', position: 'start' },
    ]);
    expect(
      dropped.filter((drop) => drop.reason === 'unknown-column'),
    ).toHaveLength(3);
  });

  it('refuses to make the hidden description column visible', () => {
    const { state, dropped } = sanitizeContentListViewState({
      columnVisibility: [
        { columnId: 'description', visible: true },
        { columnId: 'title', visible: false },
      ],
    });
    expect(state.columnVisibility).toEqual([
      { columnId: 'description', visible: false },
      { columnId: 'title', visible: false },
    ]);
    expect(dropped).toEqual([
      {
        scope: 'columnVisibility',
        reason: 'hidden-column',
        columnId: 'description',
      },
    ]);
  });
});
