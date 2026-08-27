import type { DataTableSnapshot } from '@happyvertical/smrt-ui/data';
import { describe, expect, it } from 'vitest';
import { createContentListController } from './content-list-controller.js';
import {
  CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION,
  type ContentListSavedViewStorage,
  createContentListMemorySavedViewStore,
  createContentListSavedViewStore,
  restoreContentListSavedView,
  toContentListSavedViewInput,
} from './content-list-saved-views.js';
import {
  applyContentListViewState,
  CONTENT_LIST_MAX_PAGE_SIZE,
} from './content-list-url-state.js';

const STORAGE_KEY = 'test:content-list:saved-views';

function createTestStorage(): ContentListSavedViewStorage & {
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function createTestStore(
  storage: ContentListSavedViewStorage | null = createTestStorage(),
) {
  let tick = 0;
  return createContentListSavedViewStore({
    storage,
    storageKey: STORAGE_KEY,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)),
    createId: () => `view-${tick}`,
  });
}

function snapshotOf(
  state: Partial<DataTableSnapshot['state']> = {},
): DataTableSnapshot {
  const controller = createContentListController({ pageSize: 25 });
  const snapshot = controller.snapshot();
  return { ...snapshot, state: { ...snapshot.state, ...state } };
}

/** A view saved when the list still published a `legacyScore` column. */
const staleSnapshot = {
  version: 3,
  modes: { filtering: 'manual', sorting: 'manual', pagination: 'manual' },
  state: {
    search: 'audit',
    filters: [
      { columnId: 'status', operator: 'equals', value: 'draft' },
      { columnId: 'legacyScore', operator: 'gt', value: 5 },
      { columnId: 'description', operator: 'contains', value: 'secret' },
    ],
    sorting: [
      { columnId: 'legacyScore', direction: 'desc' },
      { columnId: 'title', direction: 'asc' },
    ],
    page: 1,
    pageSize: 25,
    columnOrder: ['legacyScore', 'title'],
    columnVisibility: [{ columnId: 'description', visible: true }],
    columnWidths: [],
    columnPinning: [],
    selection: { scope: 'explicit', rowIds: [] },
    selectedRowIds: [],
    expandedRowIds: [],
  },
};

describe('content list saved view store', () => {
  it('saves, lists, gets, and deletes views', async () => {
    const store = createTestStore();
    const saved = await store.save({
      name: '  Drafts to review  ',
      snapshot: snapshotOf({ search: 'draft' }),
    });
    expect(saved.id).toBe('view-1');
    expect(saved.name).toBe('Drafts to review');
    expect(saved.schemaVersion).toBe(CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION);
    expect(saved.snapshot.state.search).toBe('draft');

    await store.save({ name: 'Archive', snapshot: snapshotOf() });
    const listed = await store.list();
    expect(listed.map((view) => view.name)).toEqual([
      'Archive',
      'Drafts to review',
    ]);

    expect((await store.get(saved.id))?.name).toBe('Drafts to review');
    expect(await store.get('missing')).toBeNull();

    expect(await store.delete(saved.id)).toBe(true);
    expect(await store.delete(saved.id)).toBe(false);
    expect((await store.list()).map((view) => view.id)).toEqual(['view-2']);
  });

  it('updates a view in place and keeps its creation time', async () => {
    const store = createTestStore();
    const created = await store.save({
      name: 'Weekly',
      snapshot: snapshotOf({ search: 'first' }),
    });
    const updated = await store.save({
      id: created.id,
      name: 'Weekly (revised)',
      snapshot: snapshotOf({ search: 'second' }),
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
    expect((await store.list()).map((view) => view.name)).toEqual([
      'Weekly (revised)',
    ]);
  });

  it('persists through the supplied storage rather than a closure', async () => {
    const storage = createTestStorage();
    const store = createTestStore(storage);
    expect(store.isPersistent()).toBe(true);
    await store.save({ name: 'Shared', snapshot: snapshotOf() });
    expect(storage.entries.get(STORAGE_KEY)).toContain('Shared');

    const reopened = createTestStore(storage);
    expect((await reopened.list()).map((view) => view.name)).toEqual([
      'Shared',
    ]);
  });

  it('rejects a nameless view and an unusable snapshot', async () => {
    const store = createTestStore();
    await expect(
      store.save({ name: '   ', snapshot: snapshotOf() }),
    ).rejects.toThrow(TypeError);
    await expect(
      store.save({
        name: 'Broken',
        snapshot: { version: 4 } as unknown as DataTableSnapshot,
      }),
    ).rejects.toThrow(/Unsupported DataTable snapshot version/);
    expect(await store.list()).toEqual([]);
  });

  it('skips entries that were tampered with outside the API', async () => {
    const storage = createTestStorage();
    const store = createTestStore(storage);
    await store.save({ name: 'Good', snapshot: snapshotOf() });
    const stored = JSON.parse(
      storage.entries.get(STORAGE_KEY) as string,
    ) as unknown[];
    storage.entries.set(
      STORAGE_KEY,
      JSON.stringify([
        ...stored,
        { id: 'bad-1', name: 'Bad version', snapshot: { version: 9 } },
        { id: 'bad-2', name: 'No snapshot' },
        { id: '', name: 'No id', snapshot: { version: 3 } },
        'not-an-object',
      ]),
    );
    expect((await store.list()).map((view) => view.name)).toEqual(['Good']);
    expect(await store.get('bad-1')).toBeNull();

    storage.entries.set(STORAGE_KEY, '{not json');
    expect(await store.list()).toEqual([]);
  });

  it('degrades to memory when storage is unavailable, without throwing', async () => {
    const blocked: ContentListSavedViewStorage = {
      getItem() {
        throw new Error('storage is blocked');
      },
      setItem() {
        throw new Error('storage is blocked');
      },
      removeItem() {
        throw new Error('storage is blocked');
      },
    };
    const store = createTestStore(blocked);
    expect(store.isPersistent()).toBe(true);
    const saved = await store.save({ name: 'Private', snapshot: snapshotOf() });
    expect(store.isPersistent()).toBe(false);
    expect((await store.list()).map((view) => view.id)).toEqual([saved.id]);
    expect(await store.delete(saved.id)).toBe(true);
  });

  it('degrades to memory when there is no ambient storage at all', async () => {
    // The test environment is Node, so `globalThis.localStorage` is absent —
    // exactly the server-render case the store has to survive.
    const store = createContentListSavedViewStore({ storageKey: STORAGE_KEY });
    expect(store.isPersistent()).toBe(false);
    await expect(
      store.save({ name: 'SSR', snapshot: snapshotOf() }),
    ).resolves.toMatchObject({ name: 'SSR' });

    const explicit = createContentListMemorySavedViewStore();
    expect(explicit.isPersistent()).toBe(false);
    await explicit.save({ name: 'Memory', snapshot: snapshotOf() });
    expect((await explicit.list()).map((view) => view.name)).toEqual([
      'Memory',
    ]);
  });
});

describe('restoring a saved view', () => {
  it('rejects an unsupported snapshot version through hydration', () => {
    expect(() =>
      restoreContentListSavedView({ version: 4, state: {} }),
    ).toThrow(/Unsupported DataTable snapshot version/);
    expect(() => restoreContentListSavedView(null)).toThrow(TypeError);
    expect(() =>
      restoreContentListSavedView({ id: 'a', name: 'b', snapshot: 'nope' }),
    ).toThrow(TypeError);
  });

  it('re-validates a tampered payload and drops unauthorized columns', () => {
    const { state, dropped } = restoreContentListSavedView({
      ...staleSnapshot,
      state: {
        ...staleSnapshot.state,
        filters: [
          { columnId: 'description', operator: 'contains', value: 'secret' },
          { columnId: 'select', operator: 'equals', value: 'all' },
          { columnId: 'actions', operator: 'equals', value: 'delete' },
        ],
        sorting: [{ columnId: 'description', direction: 'asc' }],
      },
    });
    expect(state.filters).toEqual([]);
    expect(state.sorting).toEqual([]);
    expect(dropped).toEqual(
      expect.arrayContaining([
        { scope: 'filter', reason: 'hidden-column', columnId: 'description' },
        { scope: 'filter', reason: 'structural-column', columnId: 'select' },
        { scope: 'filter', reason: 'structural-column', columnId: 'actions' },
        { scope: 'sorting', reason: 'hidden-column', columnId: 'description' },
      ]),
    );
  });

  it('restores the valid remainder of a stale view and reports the drops', () => {
    const { state, dropped } = restoreContentListSavedView(staleSnapshot);
    expect(state.search).toBe('audit');
    expect(state.filters).toEqual([
      { columnId: 'status', operator: 'equals', value: 'draft' },
    ]);
    expect(state.sorting).toEqual([{ columnId: 'title', direction: 'asc' }]);
    expect(state.pageSize).toBe(25);
    expect(state.columnOrder).toEqual(['title']);
    expect(state.columnVisibility).toEqual([
      { columnId: 'description', visible: false },
    ]);
    expect(dropped).toEqual(
      expect.arrayContaining([
        {
          scope: 'filter',
          reason: 'unknown-column',
          columnId: 'legacyScore',
        },
        {
          scope: 'sorting',
          reason: 'unknown-column',
          columnId: 'legacyScore',
        },
        {
          scope: 'columnOrder',
          reason: 'unknown-column',
          columnId: 'legacyScore',
        },
        {
          scope: 'columnVisibility',
          reason: 'hidden-column',
          columnId: 'description',
        },
      ]),
    );
  });

  it('never restores a selection saved with the view', async () => {
    const store = createTestStore();
    const controller = createContentListController({ pageSize: 25 });
    controller.dispatch({ type: 'setSearch', search: 'budget' });
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: ['content-1', 'content-2'],
    });
    const saved = await store.save(
      toContentListSavedViewInput('Mine', controller.snapshot()),
    );
    expect(saved.snapshot.state.selectedRowIds).toEqual([]);
    expect(saved.snapshot.state.selection).toEqual({
      scope: 'explicit',
      rowIds: [],
    });

    const { state } = restoreContentListSavedView(saved);
    expect(state.selection).toBeUndefined();
    expect(state.selectedRowIds).toBeUndefined();
    expect(state.expandedRowIds).toBeUndefined();
  });

  it('applies a restored view to a live controller', async () => {
    const store = createTestStore();
    const source = createContentListController({
      status: 'draft',
      pageSize: 25,
      search: 'zoning',
    });
    source.dispatch({
      type: 'setSorting',
      sorting: [{ columnId: 'updated', direction: 'desc' }],
    });
    const saved = await store.save(
      toContentListSavedViewInput('Draft backlog', source.snapshot()),
    );

    const target = createContentListController();
    const { state, dropped } = restoreContentListSavedView(saved);
    applyContentListViewState(target, state);
    expect(dropped).toEqual([]);
    expect(target.getState().search).toBe('zoning');
    expect(target.getState().filters).toEqual([
      { columnId: 'status', operator: 'equals', value: 'draft' },
    ]);
    expect(target.getState().sorting).toEqual([
      { columnId: 'updated', direction: 'desc' },
    ]);
    expect(target.getState().pageSize).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Review batch #2452: the exported store/apply composition must be safe
// ---------------------------------------------------------------------------

describe('a tampered stored blob cannot reach a controller (#2452)', () => {
  /** What someone with a console can write straight into `localStorage`. */
  const tamperedBlob = JSON.stringify([
    {
      id: 'tampered',
      name: 'Tampered',
      schemaVersion: CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      snapshot: {
        version: 3,
        modes: {
          filtering: 'manual',
          sorting: 'manual',
          pagination: 'manual',
        },
        state: {
          search: '',
          filters: [
            { columnId: 'tenantId', operator: 'equals', value: 'other-tenant' },
            { columnId: 'body', operator: 'contains', value: 'secret' },
            { columnId: 'description', operator: 'contains', value: 'secret' },
            { columnId: 'status', operator: 'equals', value: 'draft' },
          ],
          sorting: [{ columnId: 'tenantId', direction: 'asc' }],
          page: 1,
          pageSize: 100_000,
          columnOrder: [],
          columnVisibility: [{ columnId: 'description', visible: true }],
          columnWidths: [],
          columnPinning: [],
          selection: { scope: 'explicit', rowIds: [] },
          selectedRowIds: [],
          expandedRowIds: [],
        },
      },
    },
  ]);

  function tamperedStore() {
    const storage = createTestStorage();
    storage.entries.set(STORAGE_KEY, tamperedBlob);
    return createContentListSavedViewStore({
      storage,
      storageKey: STORAGE_KEY,
    });
  }

  it('keeps the raw payload on read, so the drops stay reportable', async () => {
    const [view] = await tamperedStore().list();
    // Deliberately unvalidated — this is what makes a stale view explainable.
    expect(view.snapshot.state.filters).toHaveLength(4);

    const { dropped } = restoreContentListSavedView(view);
    expect(dropped.map((drop) => drop.columnId)).toEqual(
      expect.arrayContaining(['tenantId', 'body', 'description']),
    );
  });

  it('is neutralized by applyContentListViewState, the only apply path', async () => {
    const [view] = await tamperedStore().list();
    const controller = createContentListController();

    // The dangerous composition: raw store payload straight onto a controller.
    applyContentListViewState(controller, view.snapshot.state);

    const state = controller.getState();
    expect(state.filters).toEqual([
      { columnId: 'status', operator: 'equals', value: 'draft' },
    ]);
    expect(state.sorting).toEqual([]);
    expect(state.pageSize).toBe(CONTENT_LIST_MAX_PAGE_SIZE);
    expect(state.columnVisibility).toContainEqual({
      columnId: 'description',
      visible: false,
    });
  });

  it('holds a saved view to a caller-supplied page-size ceiling', async () => {
    const [view] = await tamperedStore().list();
    const { state, dropped } = restoreContentListSavedView(view, {
      maxPageSize: 25,
    });
    expect(state.pageSize).toBe(25);
    expect(dropped).toContainEqual({
      scope: 'pageSize',
      reason: 'out-of-range',
      detail: '100000',
    });
  });
});
