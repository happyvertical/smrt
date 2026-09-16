import {
  createDataSurfaceRegistry,
  createDataTableController,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  type ListDataSurfaceContext,
  mountListDataSurface,
} from '../list-data-surface.svelte.js';

const identity: DataSurfaceIdentity = {
  surfaceId: 'custom-list',
  kind: 'list',
};

function descriptor(
  overrides: Partial<DataSurfaceDescriptor> = {},
): DataSurfaceDescriptor {
  return {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Custom list',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read', 'project'] },
      {
        id: 'title',
        label: 'Title',
        capabilities: ['read', 'search', 'filter', 'sort', 'project'],
        operators: { filter: ['contains'] },
      },
    ],
    query: {
      modes: ['rows', 'count'],
      projectableColumnIds: ['id', 'title'],
      filterableColumnIds: ['title'],
      sortableColumnIds: ['title'],
    },
    controls: [
      { id: 'set-filters', label: 'Filter' },
      { id: 'refresh', label: 'Refresh' },
      { id: 'retry', label: 'Retry' },
      { id: 'focus', label: 'Focus' },
      { id: 'reveal', label: 'Reveal' },
      { id: 'highlight', label: 'Highlight' },
      { id: 'star', label: 'Star selected' },
    ],
    actions: [],
    limits: { maxQueryRows: 50, maxQueryBytes: 10_000, maxSelectionSize: 2 },
    ...overrides,
  };
}

function context(
  overrides: Partial<ListDataSurfaceContext> = {},
): ListDataSurfaceContext {
  return {
    totalRows: 2,
    queryFingerprint: 'query-1',
    ...overrides,
  };
}

describe('mountListDataSurface', () => {
  it('registers a custom list, mirrors controller commands, and unregisters on destroy', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
    });

    const before = registry.inspect(identity);
    expect(before?.state.totalRows).toBe(2);

    const result = await registry.execute({
      version: 1,
      commandId: 'set-filter-1',
      identity,
      expectedRevision: before?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [{ columnId: 'title', operator: 'contains', value: 'x' }],
      },
    });
    expect(result.ok).toBe(true);
    expect(controller.getState().filters).toEqual([
      { columnId: 'title', operator: 'contains', value: 'x' },
    ]);
    expect(result.revision).toBeGreaterThan(before?.revision ?? -1);

    handle.destroy();
    expect(registry.inspect(identity)).toBeUndefined();
  });

  it('routes the fixed refresh/retry/focus/reveal/highlight controls to page callbacks', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const refresh = vi.fn().mockResolvedValue(true);
    const focus = vi.fn();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      refresh,
      focus,
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'do-refresh',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'refresh',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(refresh).toHaveBeenCalledOnce();

    await expect(
      registry.execute({
        version: 1,
        commandId: 'do-focus',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'focus',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(focus).toHaveBeenCalledOnce();

    // retry has no callback wired: denied rather than throwing.
    await expect(
      registry.execute({
        version: 1,
        commandId: 'do-retry',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'retry',
      }),
    ).resolves.toMatchObject({ ok: false });

    handle.destroy();
  });

  it('dispatches unrecognized controls through onControl, denying by default', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const onControl = vi.fn().mockResolvedValue(true);
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      onControl,
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'star-1',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'star',
        payload: { rowId: 'a' },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(onControl).toHaveBeenCalledWith('star', { rowId: 'a' });

    const registryTwo = createDataSurfaceRegistry();
    const controllerTwo = createDataTableController();
    const noHandler = mountListDataSurface({
      registry: registryTwo,
      descriptor: descriptor({
        identity: { surfaceId: 'no-handler', kind: 'list' },
      }),
      controller: controllerTwo,
      context: context(),
    });
    await expect(
      registryTwo.execute({
        version: 1,
        commandId: 'star-2',
        identity: { surfaceId: 'no-handler', kind: 'list' },
        expectedRevision:
          registryTwo.inspect({ surfaceId: 'no-handler', kind: 'list' })
            ?.revision ?? 0,
        controlId: 'star',
      }),
    ).resolves.toMatchObject({ ok: false });

    handle.destroy();
    noHandler.destroy();
  });

  it('treats a void onControl return as success and passes the raw payload through', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    let received: unknown;
    const onControl = vi.fn((_controlId: string, payload: unknown) => {
      received = payload;
      // Intentionally no return (void) — must still count as success.
    });
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      onControl,
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'star-void',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'star',
        payload: ['a', 'b'],
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(received).toEqual(['a', 'b']);

    handle.destroy();
  });

  it('denies a fixed control with no page callback even when onControl is supplied', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const onControl = vi.fn().mockResolvedValue(true);
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      onControl,
      // No `refresh` callback wired.
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'refresh-no-callback',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'refresh',
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(onControl).not.toHaveBeenCalled();

    handle.destroy();
  });

  it('rejects the reserved "table" context key at mount and on update()', () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    expect(() =>
      mountListDataSurface({
        registry,
        descriptor: descriptor(),
        controller,
        context: context({ table: 'nope' }),
      }),
    ).toThrow(/reserved key "table"/);

    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
    });
    expect(() => handle.update(context({ table: 'nope' }))).toThrow(
      /reserved key "table"/,
    );
    handle.destroy();
  });

  it('denies a declared table control whose payload fails to translate, never reaching onControl', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const onControl = vi.fn().mockResolvedValue(true);
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      onControl,
    });

    // `filters` must be an array; a string fails
    // `dataTableCommandFromDataSurfaceCommand`'s translation and returns null.
    await expect(
      registry.execute({
        version: 1,
        commandId: 'malformed-filters',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'set-filters',
        payload: { filters: 'not-an-array' },
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(onControl).not.toHaveBeenCalled();
    expect(controller.getState().filters).toEqual([]);

    handle.destroy();
  });

  it('does not leak a controller subscription or corrupt the shared revision counter when register() throws', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();

    // A duplicate identity makes registry.register() throw synchronously.
    const first = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: { surfaceId: 'dup', kind: 'list' } }),
      controller: createDataTableController(),
      context: context(),
    });

    expect(() =>
      mountListDataSurface({
        registry,
        descriptor: descriptor({
          identity: { surfaceId: 'dup', kind: 'list' },
        }),
        controller,
        context: context(),
      }),
    ).toThrow();

    // The failed mount must not have subscribed to this controller: dispatching
    // through it must not advance any registry-visible revision for 'dup'.
    const before = registry.inspect({
      surfaceId: 'dup',
      kind: 'list',
    })?.revision;
    controller.dispatch({ type: 'setSearch', search: 'x' });
    const after = registry.inspect({
      surfaceId: 'dup',
      kind: 'list',
    })?.revision;
    expect(after).toBe(before);

    // A later, successful mount of the same identity starts strictly above
    // the last revision the first (still-live) registration published.
    first.destroy();
    const rebound = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: { surfaceId: 'dup', kind: 'list' } }),
      controller,
      context: context(),
    });
    const reboundRevision = registry.inspect({
      surfaceId: 'dup',
      kind: 'list',
    })?.revision;
    expect(reboundRevision).toBeGreaterThan(before ?? -1);
    rebound.destroy();
  });

  it('bumps the revision when app-owned context changes via update()', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
    });
    const before = registry.inspect(identity)?.revision ?? 0;
    handle.update(context({ totalRows: 5 }));
    const after = registry.inspect(identity);
    expect(after?.revision).toBeGreaterThan(before);
    expect(after?.state.totalRows).toBe(5);
    handle.destroy();
  });

  it('keeps two mounted lists independently addressable', async () => {
    const registry = createDataSurfaceRegistry();
    const first = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: { surfaceId: 'a', kind: 'list' } }),
      controller: createDataTableController(),
      context: context(),
    });
    const second = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: { surfaceId: 'b', kind: 'list' } }),
      controller: createDataTableController(),
      context: context({ totalRows: 9 }),
    });
    expect(
      registry
        .list()
        .map((entry) => entry.identity.surfaceId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(
      registry.inspect({ surfaceId: 'b', kind: 'list' })?.state.totalRows,
    ).toBe(9);
    first.destroy();
    second.destroy();
  });
});
