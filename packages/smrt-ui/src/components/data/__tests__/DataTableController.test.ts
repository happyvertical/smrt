import { describe, expect, it, vi } from 'vitest';
import {
  assertDataTableSelectionCurrent,
  createDataTableController,
  type DataTableViewState,
  hydrateDataTableSnapshot,
  transitionDataTableState,
} from '../DataTableController.js';

const state: DataTableViewState = {
  search: '',
  filters: [],
  sorting: [],
  page: 3,
  pageSize: 10,
  columnOrder: ['name', 'age'],
  columnVisibility: [
    { columnId: 'age', visible: true },
    { columnId: 'name', visible: true },
  ],
  selection: { scope: 'explicit', rowIds: [] },
  selectedRowIds: [],
  expandedRowIds: [],
};

describe('DataTableController', () => {
  it('uses canonical JSON-safe snapshots regardless of insertion order', () => {
    const first = createDataTableController({
      initialState: {
        ...state,
        filters: [
          {
            columnId: 'age',
            operator: 'gte',
            value: { minimum: 18, maximum: 65 },
          },
          { columnId: 'name', operator: 'contains', value: 'a' },
        ],
        selectedRowIds: ['2', 1, '1', 2],
        expandedRowIds: [3, '3', 1],
      },
    });
    const second = createDataTableController({
      initialState: {
        ...state,
        filters: [
          { columnId: 'name', operator: 'contains', value: 'a' },
          {
            columnId: 'age',
            operator: 'gte',
            value: { maximum: 65, minimum: 18 },
          },
        ],
        selectedRowIds: [2, '1', 1, '2'],
        expandedRowIds: [1, '3', 3],
      },
    });

    expect(JSON.stringify(first.snapshot())).toBe(
      JSON.stringify(second.snapshot()),
    );
    expect(JSON.parse(JSON.stringify(first.snapshot()))).toEqual(
      first.snapshot(),
    );
  });

  it('resets page only when a query-shape value changes and clamps reliable totals', () => {
    const controller = createDataTableController({ initialState: state });

    expect(controller.dispatch({ type: 'setSearch', search: '' }).changed).toBe(
      false,
    );
    expect(controller.snapshot().state.page).toBe(3);

    controller.dispatch({ type: 'setSearch', search: 'ada' });
    expect(controller.snapshot().state.page).toBe(1);

    controller.replaceState({ ...controller.getState(), page: 4 });
    controller.dispatch({ type: 'setColumnOrder', columnIds: ['age', 'name'] });
    expect(controller.snapshot().state.page).toBe(4);

    controller.clampPage(11);
    expect(controller.snapshot().state.page).toBe(2);
    controller.clampPage(0);
    expect(controller.snapshot().state.page).toBe(1);
  });

  it('keeps multi-sort priority while cycling a column through asc, desc, and clear', () => {
    const controller = createDataTableController({ initialState: state });

    controller.dispatch({ type: 'toggleSorting', columnId: 'name' });
    controller.dispatch({
      type: 'toggleSorting',
      columnId: 'age',
      multi: true,
    });
    expect(controller.snapshot().state.sorting).toEqual([
      { columnId: 'name', direction: 'asc' },
      { columnId: 'age', direction: 'asc' },
    ]);

    controller.dispatch({
      type: 'toggleSorting',
      columnId: 'name',
      multi: true,
    });
    expect(controller.snapshot().state.sorting).toEqual([
      { columnId: 'name', direction: 'desc' },
      { columnId: 'age', direction: 'asc' },
    ]);
    controller.dispatch({
      type: 'toggleSorting',
      columnId: 'name',
      multi: true,
    });
    expect(controller.snapshot().state.sorting).toEqual([
      { columnId: 'age', direction: 'asc' },
    ]);
  });

  it('proposes controlled transitions without mutating until the host reconciles state', () => {
    const onStateChange = vi.fn();
    const controller = createDataTableController({ state, onStateChange });

    const transition = controller.dispatch({ type: 'setPage', page: 2 });
    expect(transition.next.state.page).toBe(2);
    expect(controller.snapshot().state.page).toBe(3);
    expect(onStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2 }),
      { type: 'setPage', page: 2 },
    );

    controller.replaceState(transition.next.state);
    expect(controller.snapshot().state.page).toBe(2);
  });

  it('notifies subscribers with defensive selection and expansion snapshots', () => {
    const controller = createDataTableController({ initialState: state });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.dispatch({ type: 'toggleRowSelection', rowId: 'row-1' });
    controller.dispatch({ type: 'toggleRowExpansion', rowId: 2 });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0].next.state).toMatchObject({
      selectedRowIds: ['row-1'],
      expandedRowIds: [2],
    });
    listener.mock.calls[1][0].next.state.selectedRowIds.push('mutated');
    expect(controller.snapshot().state.selectedRowIds).toEqual(['row-1']);

    unsubscribe();
    controller.dispatch({ type: 'setSearch', search: 'Ada' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('defensively copies state and validates persisted snapshots', () => {
    const controller = createDataTableController({ initialState: state });
    const snapshot = controller.snapshot();
    snapshot.state.selectedRowIds.push('unexpected');
    expect(controller.snapshot().state.selectedRowIds).toEqual([]);

    expect(
      hydrateDataTableSnapshot(
        JSON.parse(JSON.stringify(controller.snapshot())),
      ),
    ).toEqual(controller.snapshot());
    const { selection: _selection, ...legacyState } = state;
    expect(
      hydrateDataTableSnapshot({
        version: 1,
        modes: controller.getModes(),
        state: legacyState,
      }),
    ).toMatchObject({
      version: 2,
      state: { selection: { scope: 'explicit', rowIds: [] } },
    });
    expect(() => hydrateDataTableSnapshot({ version: 3 })).toThrow(/version/);
    expect(() =>
      transitionDataTableState(state, { type: 'setPageSize', pageSize: 0 }),
    ).toThrow(/pageSize/);
  });

  it('models current-page and explicit row selections separately', () => {
    const controller = createDataTableController({ initialState: state });

    controller.dispatch({
      type: 'setPageSelection',
      rowIds: ['row-2', 'row-1'],
    });
    expect(controller.getState().selection).toEqual({
      scope: 'page',
      rowIds: ['row-1', 'row-2'],
    });

    controller.dispatch({ type: 'setPage', page: 4 });
    expect(controller.getState().selection).toEqual({
      scope: 'page',
      rowIds: [],
    });

    controller.dispatch({ type: 'setSelectedRows', rowIds: ['row-2'] });
    controller.dispatch({ type: 'setPage', page: 5 });
    expect(controller.getState().selection).toEqual({
      scope: 'explicit',
      rowIds: ['row-2'],
    });
  });

  it('binds all-matching selection to an exact query revision and invalidates it on query changes', () => {
    const controller = createDataTableController({ initialState: state });
    controller.dispatch({
      type: 'selectAllMatching',
      queryFingerprint: 'dq1_example',
      queryRevision: 'revision-7',
      expectedCount: 42,
    });

    expect(controller.getState().selection).toEqual({
      scope: 'allMatching',
      queryFingerprint: 'dq1_example',
      queryRevision: 'revision-7',
      expectedCount: 42,
    });
    expect(controller.getState().selectedRowIds).toEqual([]);
    expect(() =>
      assertDataTableSelectionCurrent(controller.getState().selection, {
        queryFingerprint: 'dq1_example',
        queryRevision: 'revision-8',
      }),
    ).toThrow(/stale/);

    controller.dispatch({ type: 'setSearch', search: 'Ada' });
    expect(controller.getState().selection).toEqual({
      scope: 'explicit',
      rowIds: [],
    });
  });
});
