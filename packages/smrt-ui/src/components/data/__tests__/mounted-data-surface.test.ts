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
    await userEvent.click(screen.getByRole('button', { name: 'Name' }));
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
});
