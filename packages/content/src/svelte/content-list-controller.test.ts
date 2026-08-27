import {
  createDataSurfaceRegistry,
  normalizeDataSurfaceDescriptor,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import type { ContentData } from '../mock-smrt-client.js';
import {
  applyContentListFilter,
  buildContentListColumns,
  buildContentListSurfaceDescriptor,
  CONTENT_LIST_STATUS_FILTER_ID,
  CONTENT_LIST_SURFACE_ID,
  CONTENT_LIST_TYPE_FILTER_ID,
  contentListFilters,
  contentListRowActions,
  createContentListController,
  isContentListFilterExactly,
  paginateContentListRows,
  readContentListFilter,
  resolveContentHref,
  resolveSelectedContentListRows,
  selectableContentListRowIds,
  selectContentListRows,
  toContentListRows,
} from './content-list-controller.js';

const contents: ContentData[] = [
  {
    id: 'content-1',
    type: 'Article',
    title: 'Council budget explained',
    description: 'A close read of the tabled budget.',
    author: 'Ada Lovelace',
    status: 'published',
    state: 'active',
    publish_date: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    url: 'https://news.example.com/budget',
  },
  {
    id: 'content-2',
    type: 'document',
    title: 'Zoning appendix',
    description: 'Reference tables.',
    author: 'Grace Hopper',
    status: 'draft',
    state: 'deprecated',
    updatedAt: '2026-01-20T10:00:00.000Z',
  },
  {
    id: 'content-3',
    type: 'mirror',
    title: 'Mirrored release',
    description: 'Captured from the wire.',
    author: 'Alan Turing',
    status: 'archived',
    state: 'highlighted',
    source: 'wire-service',
  },
];

function rowsOf(list: ContentData[] = contents) {
  return toContentListRows(list);
}

describe('content list rows', () => {
  it('normalizes display and query values from raw content', () => {
    const [article, , mirror] = rowsOf();

    expect(article).toMatchObject({
      id: 'content-1',
      identified: true,
      type: 'article',
      typeLabel: 'Article',
      status: 'published',
      statusLabel: 'published',
      state: 'active',
      publishLabel: '2026-01-05',
      updatedLabel: '2026-02-01',
      site: 'news.example.com',
    });
    expect(mirror.site).toBe('wire-service');
  });

  it('falls back to a placeholder title and an unknown type label', () => {
    const [row] = rowsOf([{ id: 'content-x' }]);

    expect(row.title).toBe('Untitled content');
    expect(row.type).toBe('content');
    expect(row.typeLabel).toBe('Content');
  });

  it('keeps rows without a durable id renderable but not selection eligible', () => {
    const rows = rowsOf([
      { title: 'No id' },
      { id: 'content-1', title: 'First' },
      { id: 'content-1', title: 'Duplicate id' },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.identified)).toEqual([false, true, false]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(selectableContentListRowIds(rows)).toEqual(['content-1']);
  });

  it('resolves a selection to durable contents only', () => {
    const rows = rowsOf([{ title: 'No id' }, { id: 'content-1' }]);
    const controller = createContentListController();
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: rows.map((row) => row.id),
    });

    const selected = resolveSelectedContentListRows(
      rows,
      controller.getState(),
    );

    expect(selected.map((row) => row.id)).toEqual(['content-1']);
  });
});

describe('content list controller', () => {
  it('declares the adapter as the only owner of the query and hides the search-only column', () => {
    const controller = createContentListController();

    // Manual modes keep the renderer from applying a second, subtly different
    // pass over rows this adapter has already filtered, sorted, and paged.
    expect(controller.getModes()).toEqual({
      filtering: 'manual',
      sorting: 'manual',
      pagination: 'manual',
    });
    expect(controller.getState().pageSize).toBeNull();
    expect(controller.getState().columnVisibility).toContainEqual({
      columnId: 'description',
      visible: false,
    });
  });

  it('seeds the locked type filter and normalizes its value', () => {
    const controller = createContentListController({ type: 'Article' });

    expect(
      readContentListFilter(controller.getState(), CONTENT_LIST_TYPE_FILTER_ID),
    ).toBe('article');
  });

  it('replaces one filter without discarding the other', () => {
    const controller = createContentListController({ status: 'Published' });
    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, 'Mirror');

    expect(controller.getState().filters).toEqual([
      { columnId: 'status', operator: 'equals', value: 'published' },
      { columnId: 'type', operator: 'equals', value: 'mirror' },
    ]);

    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, null);

    expect(
      readContentListFilter(controller.getState(), CONTENT_LIST_TYPE_FILTER_ID),
    ).toBeNull();
    expect(
      readContentListFilter(
        controller.getState(),
        CONTENT_LIST_STATUS_FILTER_ID,
      ),
    ).toBe('published');
  });

  it('clears a filter instead of matching the empty string for a blank value', () => {
    const controller = createContentListController({ type: 'article' });

    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, '   ');

    expect(controller.getState().filters).toEqual([]);
    expect(selectContentListRows(rowsOf(), controller.getState())).toHaveLength(
      3,
    );
  });

  it('normalizes an applied filter exactly as the seeded filter does', () => {
    const seeded = createContentListController({
      type: '  Article ',
      status: ' Published ',
    });
    const applied = createContentListController();

    applyContentListFilter(applied, CONTENT_LIST_TYPE_FILTER_ID, '  Article ');
    applyContentListFilter(
      applied,
      CONTENT_LIST_STATUS_FILTER_ID,
      ' Published ',
    );

    expect(applied.getState().filters).toEqual(seeded.getState().filters);
    expect(
      readContentListFilter(applied.getState(), CONTENT_LIST_TYPE_FILTER_ID),
    ).toBe('article');
  });

  it('accepts a locked filter only when it is one equals on the locked value', () => {
    const controller = createContentListController({ type: 'article' });
    expect(
      isContentListFilterExactly(
        controller.getState(),
        CONTENT_LIST_TYPE_FILTER_ID,
        'article',
      ),
    ).toBe(true);

    // Negating the locked value names it without selecting it.
    controller.dispatch({
      type: 'setFilters',
      filters: [
        {
          columnId: CONTENT_LIST_TYPE_FILTER_ID,
          operator: 'notEquals',
          value: 'article',
        },
      ],
    });
    expect(
      isContentListFilterExactly(
        controller.getState(),
        CONTENT_LIST_TYPE_FILTER_ID,
        'article',
      ),
    ).toBe(false);

    // A second filter on the same column widens the query past the lock.
    controller.dispatch({
      type: 'setFilters',
      filters: [
        {
          columnId: CONTENT_LIST_TYPE_FILTER_ID,
          operator: 'equals',
          value: 'article',
        },
        {
          columnId: CONTENT_LIST_TYPE_FILTER_ID,
          operator: 'notEquals',
          value: 'article',
        },
      ],
    });
    expect(
      isContentListFilterExactly(
        controller.getState(),
        CONTENT_LIST_TYPE_FILTER_ID,
        'article',
      ),
    ).toBe(false);
  });

  it('builds declarative filters only for the values that are set', () => {
    expect(contentListFilters({ type: null, status: null })).toEqual([]);
    expect(contentListFilters({ type: 'Document' })).toEqual([
      { columnId: 'type', operator: 'equals', value: 'document' },
    ]);
  });
});

describe('content list query', () => {
  it('searches title, description, and author but not status tokens', () => {
    const controller = createContentListController();
    const rows = rowsOf();

    controller.dispatch({ type: 'setSearch', search: 'grace' });
    expect(
      selectContentListRows(rows, controller.getState()).map((row) => row.id),
    ).toEqual(['content-2']);

    controller.dispatch({ type: 'setSearch', search: 'wire' });
    expect(
      selectContentListRows(rows, controller.getState()).map((row) => row.id),
    ).toEqual(['content-3']);

    controller.dispatch({ type: 'setSearch', search: 'published' });
    expect(selectContentListRows(rows, controller.getState())).toEqual([]);
  });

  it('applies the type and status filters together', () => {
    const controller = createContentListController();
    const rows = rowsOf();

    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, 'article');
    expect(
      selectContentListRows(rows, controller.getState()).map((row) => row.id),
    ).toEqual(['content-1']);

    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, null);
    applyContentListFilter(controller, CONTENT_LIST_STATUS_FILTER_ID, 'Draft');
    expect(
      selectContentListRows(rows, controller.getState()).map((row) => row.id),
    ).toEqual(['content-2']);
  });

  it('sorts by a declared column in both directions', () => {
    const controller = createContentListController();
    const rows = rowsOf();

    controller.dispatch({
      type: 'setSorting',
      sorting: [{ columnId: 'title', direction: 'asc' }],
    });
    expect(
      selectContentListRows(rows, controller.getState()).map(
        (row) => row.title,
      ),
    ).toEqual([
      'Council budget explained',
      'Mirrored release',
      'Zoning appendix',
    ]);

    controller.dispatch({
      type: 'setSorting',
      sorting: [{ columnId: 'title', direction: 'desc' }],
    });
    expect(
      selectContentListRows(rows, controller.getState()).map(
        (row) => row.title,
      ),
    ).toEqual([
      'Zoning appendix',
      'Mirrored release',
      'Council budget explained',
    ]);
  });

  it('keeps the whole result when no page size is set and slices when one is', () => {
    const controller = createContentListController();
    const rows = rowsOf();

    expect(paginateContentListRows(rows, controller.getState())).toHaveLength(
      3,
    );

    controller.dispatch({ type: 'setPageSize', pageSize: 2 });
    controller.dispatch({ type: 'setPage', page: 2 });
    expect(
      paginateContentListRows(rows, controller.getState()).map((row) => row.id),
    ).toEqual(['content-3']);
  });
});

describe('content list actions', () => {
  it('resolves a view href only when the host can route to the content', () => {
    const [row] = rowsOf();

    expect(resolveContentHref(row.content)).toBeNull();
    expect(resolveContentHref(row.content, () => null)).toBeNull();
    expect(resolveContentHref(row.content, () => '')).toBeNull();
    expect(resolveContentHref(row.content, () => '/articles/content-1')).toBe(
      '/articles/content-1',
    );
  });

  it('degrades to plain text when the host resolver rejects an unknown subtype', () => {
    const [row] = rowsOf([{ id: 'content-9', type: 'unknown-subtype' }]);

    expect(
      resolveContentHref(row.content, () => {
        throw new Error('unknown content subtype');
      }),
    ).toBeNull();
    expect(
      contentListRowActions(row, {
        getViewHref: () => {
          throw new Error('unknown content subtype');
        },
      }),
    ).toEqual(['edit', 'delete']);
  });

  it('offers view only for routable rows and honours host capability flags', () => {
    const [row] = rowsOf();

    expect(contentListRowActions(row)).toEqual(['edit', 'delete']);
    expect(
      contentListRowActions(row, { getViewHref: () => '/articles/content-1' }),
    ).toEqual(['view', 'edit', 'delete']);
    expect(contentListRowActions(row, { canDelete: false })).toEqual(['edit']);
  });
});

describe('content list data surface descriptor', () => {
  it('publishes rendered columns only and validates against the registry', () => {
    const descriptor = buildContentListSurfaceDescriptor();

    expect(descriptor.identity).toEqual({
      surfaceId: CONTENT_LIST_SURFACE_ID,
      kind: 'table',
    });
    expect(descriptor.rowKey).toBe('id');
    expect(descriptor.columns.map((column) => column.id)).toEqual([
      'id',
      'type',
      'title',
      'author',
      'status',
      'state',
      'publish',
      'updated',
      'site',
    ]);
    expect(descriptor.query.searchableColumnIds).toEqual(['title', 'author']);
    expect(() => normalizeDataSurfaceDescriptor(descriptor)).not.toThrow();

    const registry = createDataSurfaceRegistry();
    const unregister = registry.register({
      descriptor,
      getSnapshot: () => ({ revision: 1, state: {} }),
    });
    expect(registry.inspect(descriptor.identity)?.descriptor.rowKey).toBe('id');
    unregister();
  });

  it('names the real ContentData field behind every published column', () => {
    const descriptor = buildContentListSurfaceDescriptor();
    const fieldNames = Object.fromEntries(
      descriptor.columns.map((column) => [column.id, column.fieldName]),
    );
    const [row] = rowsOf();

    expect(fieldNames.publish).toBe('publish_date');
    expect(fieldNames.updated).toBe('updatedAt');
    // A published field name must exist on the content the column reads.
    for (const column of descriptor.columns) {
      if (!column.fieldName || column.id === descriptor.rowKey) continue;
      expect(Object.hasOwn(row.content, column.fieldName)).toBe(true);
    }
    // `site` is derived from url/source, so it advertises no field at all.
    expect(fieldNames.site).toBeUndefined();
  });

  it('only declares columns the compact table renders', () => {
    const descriptor = buildContentListSurfaceDescriptor();
    const columns = buildContentListColumns();

    for (const declared of descriptor.columns) {
      if (declared.id === descriptor.rowKey) continue;
      const column = columns.find((candidate) => candidate.id === declared.id);
      expect(column).toBeDefined();
      expect(column?.hidden).not.toBe(true);
    }
    expect(
      descriptor.columns.some((column) => column.id === 'description'),
    ).toBe(false);
  });

  it('marks delete as a confirmed action and keeps view bound to the title column', () => {
    const { actions } = buildContentListSurfaceDescriptor();

    expect(actions.find((action) => action.id === 'delete')).toMatchObject({
      requiresConfirmation: true,
      selectionScopes: ['explicit-ids', 'current-page'],
    });
    expect(actions.find((action) => action.id === 'view')?.columnIds).toEqual([
      'title',
    ]);
  });

  it('publishes every bulk workflow with the same preview/confirmation scopes as the human UI', () => {
    const descriptor = buildContentListSurfaceDescriptor();
    const workflowIds = [
      'move-to-trash',
      'mark-draft',
      'submit-review',
      'publish',
      'archive',
      'restore',
      'automated-review',
      'format-body',
      'categorize',
      'optimize',
    ];

    expect(descriptor.schemaVersion).toBe(2);
    expect(descriptor.limits.maxSelectionSize).toBe(10_000);
    for (const id of workflowIds) {
      expect(
        descriptor.actions.find((action) => action.id === id),
      ).toMatchObject({
        requiresConfirmation: true,
        selectionScopes: ['current-page', 'explicit-ids', 'all-matching'],
      });
    }
  });

  it('accepts a host surface id, subject, and translated labels', () => {
    const descriptor = buildContentListSurfaceDescriptor({
      surfaceId: 'site-content-list',
      subject: { type: 'site', id: 'site-1', label: 'News' },
      columnLabels: { title: 'Titre' },
      actionLabels: { delete: 'Supprimer' },
    });

    expect(descriptor.identity.surfaceId).toBe('site-content-list');
    expect(descriptor.identity.subject?.id).toBe('site-1');
    expect(
      descriptor.columns.find((column) => column.id === 'title')?.label,
    ).toBe('Titre');
    expect(
      descriptor.actions.find((action) => action.id === 'delete')?.label,
    ).toBe('Supprimer');
    expect(() => normalizeDataSurfaceDescriptor(descriptor)).not.toThrow();
  });
});
