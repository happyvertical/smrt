import type {
  DataTableFilter,
  DataTableViewState,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import {
  createContentListController,
  normalizeContentListFilterValue,
} from './content-list-controller.js';
import {
  createContentListMemorySavedViewStore,
  restoreContentListSavedView,
} from './content-list-saved-views.js';
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

// ---------------------------------------------------------------------------
// Review batch #2452
// ---------------------------------------------------------------------------

describe('list values containing the separator (#2452)', () => {
  it('round-trips a value containing a comma as ONE entry', () => {
    const params = contentListViewStateToSearchParams({
      filters: [
        {
          columnId: 'author',
          operator: 'in',
          value: ['Smith, John', 'Ada'],
        },
      ],
    });
    // Escaped on the way out, and free-text case is preserved (#2452 batch 3):
    // the value becomes a server predicate compared against the stored text.
    expect(params.get('author.in')).toBe('Smith\\, John,Ada');

    const restored = contentListViewStateFromSearchParams(params);
    expect(restored.filters).toEqual([
      { columnId: 'author', operator: 'in', value: ['Smith, John', 'Ada'] },
    ]);
  });

  it('round-trips the escape character itself', () => {
    const params = contentListViewStateToSearchParams({
      filters: [
        { columnId: 'author', operator: 'in', value: ['a\\b', 'c,d\\'] },
      ],
    });
    const restored = contentListViewStateFromSearchParams(params);
    expect(restored.filters?.[0].value).toEqual(['a\\b', 'c,d\\']);
  });

  it('still splits a plain comma-separated list', () => {
    const restored = contentListViewStateFromSearchParams(
      new URLSearchParams('status.in=draft,published'),
    );
    expect(restored.filters).toEqual([
      { columnId: 'status', operator: 'in', value: ['draft', 'published'] },
    ]);
  });
});

describe('foreign parameters survive a rewrite (#2452)', () => {
  it('keeps a dotted host parameter whose base is not a list column', () => {
    const merged = mergeContentListViewStateIntoSearchParams(
      new URLSearchParams(
        'facet.contains=blue&utm_source=newsletter&evil.gt=1&status=draft',
      ),
      { search: 'zoning', filters: [] },
    );
    // Host parameters are preserved even when they carry a known operator.
    expect(merged.get('facet.contains')).toBe('blue');
    expect(merged.get('utm_source')).toBe('newsletter');
    expect(merged.get('evil.gt')).toBe('1');
    // The list's own parameters are replaced, not appended to.
    expect(merged.get('status')).toBeNull();
    expect(merged.get('q')).toBe('zoning');
  });

  it('keeps a foreign dotted parameter for a prefixed instance too', () => {
    const merged = mergeContentListViewStateIntoSearchParams(
      new URLSearchParams('a.facet.contains=blue&a.status=draft&a.q=old'),
      { search: 'new', filters: [] },
      { prefix: 'a.' },
    );
    expect(merged.get('a.facet.contains')).toBe('blue');
    expect(merged.get('a.status')).toBeNull();
    expect(merged.get('a.q')).toBe('new');
  });
});

describe('applyContentListViewState validates its patch (#2452)', () => {
  it('cannot apply a filter on an undeclared or withheld column', () => {
    const controller = createContentListController();
    applyContentListViewState(controller, {
      filters: [
        { columnId: 'tenantId', operator: 'equals', value: 'other-tenant' },
        { columnId: 'body', operator: 'contains', value: 'secret' },
        { columnId: 'description', operator: 'contains', value: 'secret' },
        { columnId: 'status', operator: 'equals', value: 'draft' },
      ],
      columnVisibility: [{ columnId: 'description', visible: true }],
      pageSize: 100_000,
    } as Partial<DataTableViewState>);

    const state = controller.getState();
    expect(state.filters).toEqual([
      { columnId: 'status', operator: 'equals', value: 'draft' },
    ]);
    // The controller reconciles visibility across every known column; the
    // search-only one must still be forced back to hidden.
    expect(state.columnVisibility).toContainEqual({
      columnId: 'description',
      visible: false,
    });
    expect(state.pageSize).toBe(CONTENT_LIST_MAX_PAGE_SIZE);
  });

  it('honours a caller-supplied page-size ceiling', () => {
    const controller = createContentListController();
    applyContentListViewState(
      controller,
      { pageSize: 500 },
      {
        maxPageSize: 25,
      },
    );
    expect(controller.getState().pageSize).toBe(25);
  });

  it('preserves selection and expansion, which a patch never carries', () => {
    const controller = createContentListController();
    controller.dispatch({ type: 'setSelectedRows', rowIds: ['a', 'b'] });
    applyContentListViewState(controller, { search: 'zoning' });
    expect(controller.getState().selectedRowIds).toEqual(['a', 'b']);
    expect(controller.getState().search).toBe('zoning');
  });

  it('is idempotent over an already-validated patch', () => {
    const controller = createContentListController();
    const { state } = sanitizeContentListViewState({
      search: 'budget',
      filters: [{ columnId: 'status', operator: 'equals', value: 'DRAFT' }],
      sorting: [{ columnId: 'title', direction: 'asc' }],
      page: 3,
      pageSize: 25,
    });
    applyContentListViewState(controller, state);
    const first = controller.getState();
    applyContentListViewState(controller, state);
    expect(controller.getState()).toEqual(first);
    expect(first.filters).toEqual([
      {
        columnId: 'status',
        operator: 'equals',
        value: normalizeContentListFilterValue('status', 'DRAFT'),
      },
    ]);
    expect(first.page).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Review round 13: a value that reads as absent is still a value (#2452)
// ---------------------------------------------------------------------------

/**
 * `null` in a filter list means "and rows with no value at all". It has now
 * been silently discarded in three separate layers — the translator, the local
 * evaluator, and this one — because each layer asked whether the value was
 * PRESENT rather than whether it was VALID, and `null` reads as absent to any
 * check written with truthiness.
 *
 * Every layer a filter value passes through is asserted here or in the layer's
 * own suite; see `agents/content-list.md` for the table.
 */
describe('a null list entry survives every persistence layer', () => {
  const nullBearing = (
    operator: 'in' | 'notIn' = 'notIn',
  ): Partial<DataTableViewState> => ({
    filters: [
      { columnId: 'author', operator, value: ['Ada', null] },
    ] as DataTableFilter[],
  });

  it('LAYER sanitizer: keeps the null rather than widening the filter', () => {
    const { state, dropped } = sanitizeContentListViewState(nullBearing());
    expect(state.filters?.[0].value).toEqual(['Ada', null]);
    expect(dropped).toEqual([]);
  });

  it('LAYER sanitizer: still refuses an entry that is genuinely unusable', () => {
    const { state, dropped } = sanitizeContentListViewState({
      filters: [
        { columnId: 'author', operator: 'in', value: ['Ada', { bad: 1 }] },
      ] as DataTableFilter[],
    });
    expect(state.filters?.[0].value).toEqual(['Ada']);
    expect(dropped).toEqual([]);
  });

  it('LAYER URL write: encodes the null as a token, not as the word', () => {
    const params = contentListViewStateToSearchParams(nullBearing());
    // `null` written literally would be indistinguishable from an author
    // actually called "null".
    expect(params.get('author.notIn')).toBe('Ada,\\0');
  });

  it('LAYER URL read: decodes the token back to the value null', () => {
    const restored = contentListViewStateFromSearchParams(
      new URLSearchParams('author.notIn=Ada,\\0'),
    );
    expect(restored.filters?.[0].value).toEqual(['Ada', null]);
  });

  it('the token cannot collide with any real value, by construction', () => {
    // Every real backslash is doubled on the way out, so a LONE backslash
    // followed by `0` is unreachable from a string — including these.
    const collisionCandidates = ['null', '\\0', '\\\\0', '0', '\\'];
    const params = contentListViewStateToSearchParams({
      filters: [
        {
          columnId: 'author',
          operator: 'in',
          value: [...collisionCandidates, null],
        },
      ] as DataTableFilter[],
    });
    const restored = contentListViewStateFromSearchParams(params);
    expect(restored.filters?.[0].value).toEqual([...collisionCandidates, null]);
  });

  it('survives URL percent-encoding intact', () => {
    const params = contentListViewStateToSearchParams(nullBearing());
    // Through a real query string, not just the params object.
    const encoded = params.toString();
    expect(encoded).toContain('%5C0');
    expect(
      contentListViewStateFromSearchParams(new URLSearchParams(encoded))
        .filters?.[0].value,
    ).toEqual(['Ada', null]);
  });

  it('ROUND TRIP: a null-bearing filter means the same after persist/restore', () => {
    for (const operator of ['in', 'notIn'] as const) {
      const original = nullBearing(operator);
      const restored = contentListViewStateFromSearchParams(
        contentListViewStateToSearchParams(original),
      );
      expect(restored.filters, operator).toEqual(original.filters);
      // …and it is stable, not merely equal on the first pass.
      const again = contentListViewStateFromSearchParams(
        contentListViewStateToSearchParams(restored),
      );
      expect(again.filters, operator).toEqual(original.filters);
    }
  });

  it('ROUND TRIP: a scalar null becomes the valueless operator it equals', () => {
    // `equals null` and `isNull` are the same predicate, and the valueless
    // operator already has a query-string form — no second token needed.
    for (const [operator, expected] of [
      ['equals', 'isNull'],
      ['notEquals', 'isNotNull'],
    ] as const) {
      const params = contentListViewStateToSearchParams({
        filters: [{ columnId: 'author', operator, value: null }],
      } as Partial<DataTableViewState>);
      expect(params.get(`author.${expected}`), operator).toBe('1');
      expect(contentListViewStateFromSearchParams(params).filters?.[0]).toEqual(
        { columnId: 'author', operator: expected },
      );
    }
  });

  it('keeps an empty-string entry, which is a value for a column that stores one', () => {
    const params = contentListViewStateToSearchParams({
      filters: [
        { columnId: 'author', operator: 'in', value: ['Ada', ''] },
      ] as DataTableFilter[],
    });
    expect(params.get('author.in')).toBe('Ada,');
    expect(
      contentListViewStateFromSearchParams(params).filters?.[0].value,
    ).toEqual(['Ada', '']);
  });

  it('still treats an entirely empty list parameter as no values', () => {
    // `?author.in=` is a list with nothing in it, not a list containing the
    // empty string — refused and reported, as before.
    const reading = readContentListViewStateFromSearchParams(
      new URLSearchParams('author.in='),
    );
    expect(reading.state.filters).toEqual([]);
    expect(reading.dropped).toContainEqual(
      expect.objectContaining({ scope: 'filter', reason: 'unsupported-value' }),
    );
  });

  it('keeps `0` and `false`, which truthiness also discards', () => {
    // The bug is not really about null: it is about any value a check written
    // with truthiness reads as absent.
    const restored = contentListViewStateFromSearchParams(
      contentListViewStateToSearchParams({
        filters: [
          { columnId: 'author', operator: 'in', value: [0, false, null, ''] },
        ] as unknown as DataTableFilter[],
      }),
    );
    // Numbers and booleans normalize to their text form, as every filter value
    // does; what matters is that none of them vanish.
    expect(restored.filters?.[0].value).toEqual(['0', 'false', null, '']);
  });
});

describe('a null list entry survives the saved-view layers', () => {
  it('round-trips natively through JSON, where null needs no token', async () => {
    const store = createContentListMemorySavedViewStore({
      storageKey: 'test:content-list:null-entry',
    });
    const controller = createContentListController();
    controller.dispatch({
      type: 'setFilters',
      filters: [
        { columnId: 'author', operator: 'notIn', value: ['Ada', null] },
      ] as DataTableFilter[],
    });
    await store.save({
      name: 'Excludes Ada and the blanks',
      snapshot: controller.snapshot(),
    });

    const [saved] = await store.list();
    // The stored payload is raw, so the null is still there …
    expect(saved.snapshot.state.filters?.[0].value).toEqual(['Ada', null]);
    // … and the validated restoration keeps it too.
    const { state, dropped } = restoreContentListSavedView(saved);
    expect(state.filters?.[0].value).toEqual(['Ada', null]);
    expect(dropped).toEqual([]);
  });

  it('applies it to a controller unchanged', () => {
    const controller = createContentListController();
    applyContentListViewState(controller, {
      filters: [
        { columnId: 'author', operator: 'notIn', value: ['Ada', null] },
      ] as DataTableFilter[],
    });
    expect(controller.getState().filters[0].value).toEqual(['Ada', null]);
  });
});
