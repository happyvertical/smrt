import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CollectionToolbar from '../CollectionToolbar.svelte';
import DataTable from '../DataTable.svelte';
import { createDataTableController } from '../DataTableController.js';
import {
  createDataSurfaceRegistry,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '../data-surface.js';

const columns = [
  { id: 'name', label: 'Name', accessor: 'name', sortable: true },
  { id: 'age', label: 'Age', accessor: 'age', sortable: true },
];
const rows = [
  { name: 'Ada', age: 36 },
  { name: 'Grace', age: 85 },
];

function descriptor(
  identity: DataSurfaceIdentity,
  controls: string[],
): DataSurfaceDescriptor {
  return {
    version: 1,
    identity,
    schemaVersion: 1,
    label: identity.surfaceId,
    rowKey: 'name',
    columns: columns.map((column) => ({
      id: column.id,
      label: column.label,
      capabilities: ['read', 'search', 'filter', 'sort', 'project'],
    })),
    query: { modes: ['rows', 'count'], projectableColumnIds: ['name', 'age'] },
    controls: controls.map((id) => ({ id, label: id })),
    actions: [],
    limits: { maxQueryRows: 100, maxQueryBytes: 10_000, maxSelectionSize: 10 },
  };
}

describe('mounted data surfaces', () => {
  it('registers a DataTable explicitly and acknowledges the same controller state used by a header click', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'people-table',
      kind: 'table',
    };
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        sortable: true,
        controller,
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['toggle-sorting', 'set-search']),
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await userEvent.click(
      screen.getByRole('button', { name: 'Sort Name ascending' }),
    );
    const humanSnapshot = registry.inspect(identity);

    expect(humanSnapshot).toMatchObject({
      revision: 1,
      state: {
        table: { state: { sorting: [{ columnId: 'name', direction: 'asc' }] } },
      },
    });

    const result = await registry.execute({
      version: 1,
      commandId: 'sort-age',
      identity,
      expectedRevision: humanSnapshot?.revision ?? -1,
      controlId: 'toggle-sorting',
      payload: { columnId: 'age', multi: true },
    });

    expect(result).toMatchObject({ ok: true, revision: 2 });
    expect(controller.getState().sorting).toEqual([
      { columnId: 'name', direction: 'asc' },
      { columnId: 'age', direction: 'asc' },
    ]);
  });

  it('focuses a normal mounted table through its programmatic focus target', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'focusable-people-table',
      kind: 'table',
    };
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['focus']),
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await expect(
      registry.execute({
        version: 1,
        commandId: 'focus-table',
        identity,
        expectedRevision: 0,
        controlId: 'focus',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(document.activeElement).toBe(
      document.querySelector('.data-table-container'),
    );
  });

  it('enforces descriptor membership and filter/sort capabilities before dispatch', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'policy-filtered-people-table',
      kind: 'table',
    };
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller,
        dataSurface: {
          registry,
          descriptor: {
            ...descriptor(identity, [
              'set-filters',
              'set-sorting',
              'toggle-sorting',
              'set-column-order',
              'set-column-visibility',
            ]),
            columns: [
              {
                id: 'name',
                label: 'Name',
                capabilities: ['read', 'sort'],
              },
            ],
            query: { modes: ['rows'], projectableColumnIds: ['name'] },
          },
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    for (const [commandId, controlId, payload] of [
      [
        'hidden-age-filter',
        'set-filters',
        { filters: [{ columnId: 'age', operator: 'equals', value: 36 }] },
      ],
      [
        'hidden-age-sort',
        'set-sorting',
        { sorting: [{ columnId: 'age', direction: 'asc' }] },
      ],
      ['hidden-age-toggle', 'toggle-sorting', { columnId: 'age' }],
      ['hidden-age-order', 'set-column-order', { columnIds: ['name', 'age'] }],
      [
        'hidden-age-visibility',
        'set-column-visibility',
        { columns: [{ columnId: 'age', visible: true }] },
      ],
      [
        'non-filterable-name',
        'set-filters',
        { filters: [{ columnId: 'name', operator: 'equals', value: 'Ada' }] },
      ],
    ] as const) {
      await expect(
        registry.execute({
          version: 1,
          commandId,
          identity,
          expectedRevision: 0,
          controlId,
          payload,
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    }
    expect(controller.getState().filters).toEqual([]);
    expect(controller.getState().sorting).toEqual([]);
  });

  it('preserves page and all-matching selection scopes in mounted snapshots', async () => {
    const registry = createDataSurfaceRegistry();
    const pageIdentity: DataSurfaceIdentity = {
      surfaceId: 'page-selection-table',
      kind: 'table',
    };
    const allMatchingIdentity: DataSurfaceIdentity = {
      surfaceId: 'all-matching-selection-table',
      kind: 'table',
    };
    const props = {
      data: rows,
      columns,
      rowKey: 'name' as const,
      dataSurface: {
        registry,
        descriptor: descriptor(pageIdentity, []),
      },
    };
    render(DataTable, {
      props: {
        ...props,
        controller: createDataTableController({
          initialState: { selection: { scope: 'page', rowIds: ['Ada'] } },
        }),
      },
    });
    render(DataTable, {
      props: {
        ...props,
        controller: createDataTableController({
          initialState: {
            selection: {
              scope: 'allMatching',
              expectedCount: 42,
              queryFingerprint: 'people-query',
              queryRevision: 'revision-1',
            },
          },
          columnIds: columns.map((column) => column.id),
        }),
        dataSurface: {
          registry,
          descriptor: descriptor(allMatchingIdentity, []),
        },
      },
    });

    await vi.waitFor(() => {
      expect(registry.inspect(pageIdentity)?.selection).toEqual({
        scope: 'current-page',
      });
      expect(registry.inspect(allMatchingIdentity)?.selection).toEqual({
        scope: 'all-matching',
        queryFingerprint: 'people-query',
      });
    });
  });

  it('rejects visibility commands that would hide declared surface columns', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'visible-columns-table',
      kind: 'table',
    };
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller,
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['set-column-visibility']),
        },
      },
    });
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());

    await expect(
      registry.execute({
        version: 1,
        commandId: 'hide-age',
        identity,
        expectedRevision: 0,
        controlId: 'set-column-visibility',
        payload: {
          columns: [
            { columnId: 'name', visible: true },
            { columnId: 'age', visible: false },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(controller.getState().columnVisibility).toEqual([
      { columnId: 'age', visible: true },
      { columnId: 'name', visible: true },
    ]);
  });

  it('restores declared columns after an external controller visibility transition', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'external-visible-columns-table',
      kind: 'table',
    };
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller,
        dataSurface: {
          registry,
          descriptor: descriptor(identity, []),
        },
      },
    });
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());

    controller.dispatch({
      type: 'setColumnVisibility',
      columns: [
        { columnId: 'name', visible: true },
        { columnId: 'age', visible: false },
      ],
    });

    expect(controller.getState().columnVisibility).toEqual([
      { columnId: 'age', visible: true },
      { columnId: 'name', visible: true },
    ]);
    expect(registry.inspect(identity)?.descriptor.columns).toHaveLength(2);
  });

  it('turns malformed table command payloads into bounded denials', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'malformed-command-table',
      kind: 'table',
    };
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        dataSurface: {
          registry,
          descriptor: descriptor(identity, [
            'set-filters',
            'set-sorting',
            'set-column-visibility',
          ]),
        },
      },
    });
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    for (const [commandId, controlId, payload] of [
      [
        'bad-filter',
        'set-filters',
        { filters: [{ columnId: 'name', operator: 'unknown' }] },
      ],
      [
        'bad-sort',
        'set-sorting',
        { sorting: [{ columnId: 'name', direction: 'sideways' }] },
      ],
      [
        'bad-visibility',
        'set-column-visibility',
        { columns: [{ columnId: 'name', visible: 'yes' }] },
      ],
    ] as const) {
      await expect(
        registry.execute({
          version: 1,
          commandId,
          identity,
          expectedRevision: 0,
          controlId,
          payload,
        }),
      ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    }
  });

  it('waits for a controlled DataTable host to settle candidate state before acknowledgement', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'controlled-people-table',
      kind: 'table',
    };
    const initial = createDataTableController({
      columnIds: columns.map((column) => column.id),
    }).getState();
    const controller = createDataTableController({
      state: initial,
      columnIds: columns.map((column) => column.id),
    });
    const applyControlledState = vi.fn((state) => state);
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller,
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['set-search']),
          applyControlledState,
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    const result = await registry.execute({
      version: 1,
      commandId: 'search-grace',
      identity,
      expectedRevision: 0,
      controlId: 'set-search',
      payload: { search: 'Grace' },
    });

    expect(applyControlledState).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      snapshot: { state: { table: { state: { search: 'Grace' } } } },
    });
  });

  it('denies or fails controlled commands when the host does not settle them', async () => {
    const registry = createDataSurfaceRegistry();
    const initial = createDataTableController({
      columnIds: columns.map((column) => column.id),
    }).getState();
    const deniedIdentity: DataSurfaceIdentity = {
      surfaceId: 'denied-controlled-table',
      kind: 'table',
    };
    const failedIdentity: DataSurfaceIdentity = {
      surfaceId: 'failed-controlled-table',
      kind: 'table',
    };
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller: createDataTableController({
          state: initial,
          columnIds: columns.map((column) => column.id),
        }),
        dataSurface: {
          registry,
          descriptor: descriptor(deniedIdentity, ['set-search']),
          applyControlledState: () => undefined,
        },
      },
    });
    render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller: createDataTableController({
          state: initial,
          columnIds: columns.map((column) => column.id),
        }),
        dataSurface: {
          registry,
          descriptor: descriptor(failedIdentity, ['set-search']),
          applyControlledState: () => {
            throw new Error('host rejected state');
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(registry.inspect(deniedIdentity)).toBeDefined();
      expect(registry.inspect(failedIdentity)).toBeDefined();
    });
    await expect(
      registry.execute({
        version: 1,
        commandId: 'denied-search',
        identity: deniedIdentity,
        expectedRevision: 0,
        controlId: 'set-search',
        payload: { search: 'Ada' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    await expect(
      registry.execute({
        version: 1,
        commandId: 'failed-search',
        identity: failedIdentity,
        expectedRevision: 0,
        controlId: 'set-search',
        payload: { search: 'Ada' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'execution_failed' });
  });

  it('unregisters a mounted DataTable when the component unmounts', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'unmounted-table',
      kind: 'table',
    };
    const { unmount } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['set-search']),
        },
      },
    });
    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    unmount();
    expect(registry.inspect(identity)).toBeUndefined();
  });

  it('reactively registers delayed and replacement DataTable surface props', async () => {
    const registry = createDataSurfaceRegistry();
    const firstIdentity: DataSurfaceIdentity = {
      surfaceId: 'first-people-table',
      kind: 'table',
    };
    const nextIdentity: DataSurfaceIdentity = {
      surfaceId: 'next-people-table',
      kind: 'table',
    };
    const firstController = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const nextController = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const { rerender } = render(DataTable, {
      props: {
        data: rows,
        columns,
        rowKey: 'name',
        controller: firstController,
      },
    });

    expect(registry.inspect(firstIdentity)).toBeUndefined();
    await rerender({
      data: rows,
      columns,
      rowKey: 'name',
      controller: firstController,
      dataSurface: {
        registry,
        descriptor: descriptor(firstIdentity, ['set-search']),
      },
    });
    await vi.waitFor(() =>
      expect(registry.inspect(firstIdentity)).toBeDefined(),
    );

    await rerender({
      data: rows,
      columns,
      rowKey: 'name',
      controller: nextController,
      dataSurface: {
        registry,
        descriptor: descriptor(nextIdentity, ['set-search']),
      },
    });
    await vi.waitFor(() => {
      expect(registry.inspect(firstIdentity)).toBeUndefined();
      expect(registry.inspect(nextIdentity)).toBeDefined();
    });

    await registry.execute({
      version: 1,
      commandId: 'next-search',
      identity: nextIdentity,
      expectedRevision: 0,
      controlId: 'set-search',
      payload: { search: 'Grace' },
    });
    expect(firstController.getState().search).toBe('');
    expect(nextController.getState().search).toBe('Grace');
  });

  it('allows a stable row key that is not a rendered column', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'hidden-id-table',
      kind: 'table',
    };
    render(DataTable, {
      props: {
        data: [{ id: 'ada', name: 'Ada' }],
        columns: [{ id: 'name', label: 'Name', accessor: 'name' }],
        rowKey: 'id',
        dataSurface: {
          registry,
          descriptor: {
            ...descriptor(identity, []),
            rowKey: 'id',
            columns: [
              { id: 'id', label: 'ID', capabilities: ['read'] },
              { id: 'name', label: 'Name', capabilities: ['read'] },
            ],
            query: {
              modes: ['rows'],
              projectableColumnIds: ['id', 'name'],
            },
          },
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
  });

  it('registers a CollectionToolbar without a hidden automation path and shares its controller search', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'people-toolbar',
      kind: 'custom',
    };
    const controller = createDataTableController();
    render(CollectionToolbar, {
      props: {
        controller,
        views: ['list', 'grid', 'table'],
        dataSurface: {
          registry,
          descriptor: descriptor(identity, ['set-search', 'set-view']),
        },
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    const search = await registry.execute({
      version: 1,
      commandId: 'toolbar-search',
      identity,
      expectedRevision: 0,
      controlId: 'set-search',
      payload: { search: 'Ada' },
    });
    const view = await registry.execute({
      version: 1,
      commandId: 'toolbar-grid',
      identity,
      expectedRevision: search.revision ?? -1,
      controlId: 'set-view',
      payload: { view: 'grid' },
    });

    expect(controller.getState().search).toBe('Ada');
    expect(view).toMatchObject({
      ok: true,
      snapshot: { state: { search: 'Ada', view: 'grid' } },
    });
  });

  it('reactively registers delayed and replacement CollectionToolbar surface props', async () => {
    const registry = createDataSurfaceRegistry();
    const firstIdentity: DataSurfaceIdentity = {
      surfaceId: 'first-people-toolbar',
      kind: 'custom',
    };
    const nextIdentity: DataSurfaceIdentity = {
      surfaceId: 'next-people-toolbar',
      kind: 'custom',
    };
    const firstController = createDataTableController();
    const nextController = createDataTableController();
    const { rerender } = render(CollectionToolbar, {
      props: { controller: firstController },
    });

    expect(registry.inspect(firstIdentity)).toBeUndefined();
    await rerender({
      controller: firstController,
      dataSurface: {
        registry,
        descriptor: descriptor(firstIdentity, ['set-search']),
      },
    });
    await vi.waitFor(() =>
      expect(registry.inspect(firstIdentity)).toBeDefined(),
    );

    await rerender({
      controller: nextController,
      dataSurface: {
        registry,
        descriptor: descriptor(nextIdentity, ['set-search']),
      },
    });
    await vi.waitFor(() => {
      expect(registry.inspect(firstIdentity)).toBeUndefined();
      expect(registry.inspect(nextIdentity)).toBeDefined();
    });

    await registry.execute({
      version: 1,
      commandId: 'next-toolbar-search',
      identity: nextIdentity,
      expectedRevision: 0,
      controlId: 'set-search',
      payload: { search: 'Grace' },
    });
    expect(firstController.getState().search).toBe('');
    expect(nextController.getState().search).toBe('Grace');
  });

  it('revisions externally changed uncontrolled toolbar state', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'externally-controlled-toolbar',
      kind: 'custom',
    };
    const dataSurface = {
      registry,
      descriptor: descriptor(identity, ['set-search', 'set-view']),
    };
    const { rerender } = render(CollectionToolbar, {
      props: {
        search: 'Ada',
        view: 'list',
        dataSurface,
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await rerender({
      search: 'Grace',
      view: 'grid',
      dataSurface,
    });
    await vi.waitFor(() =>
      expect(registry.inspect(identity)).toMatchObject({
        revision: 1,
        state: { search: 'Grace', view: 'grid' },
      }),
    );

    await expect(
      registry.execute({
        version: 1,
        commandId: 'stale-toolbar-command',
        identity,
        expectedRevision: 0,
        controlId: 'set-view',
        payload: { view: 'list' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_revision' });
  });

  it('preserves toolbar revisions for equivalent surface bindings', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'equivalent-toolbar-binding',
      kind: 'custom',
    };
    const surface = () => ({
      registry,
      descriptor: descriptor(identity, ['set-view']),
    });
    const { rerender } = render(CollectionToolbar, {
      props: { dataSurface: surface() },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await expect(
      registry.execute({
        version: 1,
        commandId: 'change-toolbar-view',
        identity,
        expectedRevision: 0,
        controlId: 'set-view',
        payload: { view: 'grid' },
      }),
    ).resolves.toMatchObject({ ok: true, revision: 1 });

    await rerender({ dataSurface: surface() });
    await vi.waitFor(() =>
      expect(registry.inspect(identity)).toMatchObject({
        revision: 1,
        state: { search: '', view: 'grid' },
      }),
    );
    await expect(
      registry.execute({
        version: 1,
        commandId: 'stale-equivalent-toolbar-command',
        identity,
        expectedRevision: 0,
        controlId: 'set-view',
        payload: { view: 'list' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_revision' });
  });

  it('preserves DataTable registration and replay state for equivalent bindings', async () => {
    const registry = createDataSurfaceRegistry();
    const identity: DataSurfaceIdentity = {
      surfaceId: 'equivalent-table-binding',
      kind: 'table',
    };
    const equivalentColumns = () => columns.map((column) => ({ ...column }));
    const surface = () => ({
      registry,
      descriptor: descriptor(identity, ['toggle-sorting']),
    });
    const controller = createDataTableController({
      columnIds: columns.map((column) => column.id),
    });
    const { rerender } = render(DataTable, {
      props: {
        data: rows,
        columns: equivalentColumns(),
        rowKey: 'name',
        sortable: true,
        controller,
        dataSurface: surface(),
      },
    });

    await vi.waitFor(() => expect(registry.inspect(identity)).toBeDefined());
    await expect(
      registry.execute({
        version: 1,
        commandId: 'table-sort',
        identity,
        expectedRevision: 0,
        controlId: 'toggle-sorting',
        payload: { columnId: 'name' },
      }),
    ).resolves.toMatchObject({ ok: true, revision: 1 });

    await rerender({
      data: rows,
      columns: equivalentColumns(),
      rowKey: 'name',
      sortable: true,
      controller,
      dataSurface: surface(),
    });
    await vi.waitFor(() =>
      expect(registry.inspect(identity)).toMatchObject({ revision: 1 }),
    );
    await expect(
      registry.execute({
        version: 1,
        commandId: 'stale-table-sort',
        identity,
        expectedRevision: 0,
        controlId: 'toggle-sorting',
        payload: { columnId: 'name' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_revision' });
  });
});
