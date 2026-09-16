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

  it('rejects a registry-forbidden boundary key at update() instead of deferring the failure to a later read', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
    });
    const before = registry.inspect(identity);

    // `tenantId` is one of the registry's own boundary-forbidden keys
    // (FORBIDDEN_BOUNDARY_KEYS in @happyvertical/smrt-ui/data) — not
    // something this module hand-copies. update() must throw here, not
    // leave the surface poisoned for a later inspect()/execute().
    expect(() => handle.update(context({ tenantId: 'nope' }))).toThrow();

    // The surface must be unaffected: still readable, at the same revision.
    const after = registry.inspect(identity);
    expect(after).toEqual(before);

    handle.destroy();
  });

  it('denies a table command on a controlled controller when the settled state does not converge', async () => {
    const registry = createDataSurfaceRegistry();
    const controlledState = { filters: [] as unknown[] } as ReturnType<
      ReturnType<typeof createDataTableController>['getState']
    >;
    const controller = createDataTableController({
      state: controlledState,
      onStateChange: () => {
        // Simulate a host that never feeds the proposed state back.
      },
    });
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      // No applyControlledState supplied — the proposal is never settled.
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'controlled-unsettled',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'set-filters',
        payload: {
          filters: [{ columnId: 'title', operator: 'contains', value: 'x' }],
        },
      }),
    ).resolves.toMatchObject({ ok: false });
    // The controller's own state must be unaffected — dispatch on a
    // controlled controller never applies state on its own.
    expect(controller.getState().filters).toEqual([]);

    handle.destroy();
  });

  it('acknowledges a table command on a controlled controller once applyControlledState settles it', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController({
      state: { filters: [] },
    });
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      applyControlledState: (state) => {
        // Simulate a host that immediately accepts and feeds back the
        // proposed state.
        return state;
      },
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'controlled-settled',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'set-filters',
        payload: {
          filters: [{ columnId: 'title', operator: 'contains', value: 'x' }],
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(controller.getState().filters).toEqual([
      { columnId: 'title', operator: 'contains', value: 'x' },
    ]);

    handle.destroy();
  });

  it('merges update() context over the previous published state instead of replacing it', () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context({ totalRows: 2, queryFingerprint: 'query-1' }),
    });

    handle.update({ totalRows: 5 });
    const after = registry.inspect(identity);
    expect(after?.state.totalRows).toBe(5);
    // queryFingerprint was not mentioned in this update() call and must be
    // retained, not dropped.
    expect(after?.state.queryFingerprint).toBe('query-1');

    handle.update({ queryFingerprint: undefined });
    const cleared = registry.inspect(identity);
    expect(cleared?.state.queryFingerprint).toBeUndefined();
    expect(cleared?.state.totalRows).toBe(5);

    handle.destroy();
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

  it('ignores update() called after destroy() instead of corrupting a later mount of the same identity', () => {
    const registry = createDataSurfaceRegistry();
    const controllerA = createDataTableController();
    const surfaceIdentity = { surfaceId: 'reused', kind: 'list' as const };
    const first = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: surfaceIdentity }),
      controller: controllerA,
      context: context(),
    });
    first.destroy();

    const controllerB = createDataTableController();
    const second = mountListDataSurface({
      registry,
      descriptor: descriptor({ identity: surfaceIdentity }),
      controller: controllerB,
      context: context(),
    });
    const beforeStaleUpdate = registry.inspect(surfaceIdentity)?.revision ?? 0;

    // A callback captured by `first` (e.g. an async refresh) resolves late,
    // after `first.destroy()` and after `second` has already mounted the
    // same identity. It must be a no-op, not resurrect the shared revision
    // counter for an identity `first` no longer owns.
    expect(() => first.update(context({ totalRows: 999 }))).not.toThrow();
    expect(registry.inspect(surfaceIdentity)?.revision).toBe(beforeStaleUpdate);
    expect(registry.inspect(surfaceIdentity)?.state.totalRows).not.toBe(999);

    second.destroy();
  });

  describe('commandAllowed descriptor-driven refusal', () => {
    async function expectDeniedUnchanged(
      extra: Partial<Parameters<typeof mountListDataSurface>[0]> = {},
      buildCommand: (
        rev: number,
      ) => Parameters<
        ReturnType<typeof createDataSurfaceRegistry>['execute']
      >[0],
    ) {
      const registry = createDataSurfaceRegistry();
      const controller = createDataTableController();
      const handle = mountListDataSurface({
        registry,
        descriptor: descriptor(),
        controller,
        context: context(),
        ...extra,
      });
      const before = controller.snapshot();
      const rev = registry.inspect(identity)?.revision ?? 0;
      const result = await registry.execute(buildCommand(rev));
      expect(result.ok).toBe(false);
      expect(controller.snapshot()).toEqual(before);
      handle.destroy();
    }

    it('denies set-filters on a column outside filterableColumnIds', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-1',
        identity,
        expectedRevision: rev,
        controlId: 'set-filters',
        payload: {
          filters: [{ columnId: 'id', operator: 'contains', value: 'x' }],
        },
      }));
    });

    it('denies set-filters with an operator outside the column allowlist', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-2',
        identity,
        expectedRevision: rev,
        controlId: 'set-filters',
        payload: {
          filters: [{ columnId: 'title', operator: 'notContains', value: 'x' }],
        },
      }));
    });

    it('denies set-sorting on a column outside sortableColumnIds', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-3',
        identity,
        expectedRevision: rev,
        controlId: 'set-sorting',
        payload: { sorting: [{ columnId: 'id', direction: 'asc' }] },
      }));
    });

    it('denies toggle-sorting on a column outside sortableColumnIds', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-4',
        identity,
        expectedRevision: rev,
        controlId: 'toggle-sorting',
        payload: { columnId: 'id' },
      }));
    });

    it('denies set-selected-rows over maxSelectionSize', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-5',
        identity,
        expectedRevision: rev,
        controlId: 'set-selected-rows',
        payload: { rowIds: ['a', 'b', 'c'] },
      }));
    });

    it('denies toggle-row-selection that would exceed maxSelectionSize', async () => {
      const registry = createDataSurfaceRegistry();
      const controller = createDataTableController();
      controller.dispatch({ type: 'setSelectedRows', rowIds: ['a', 'b'] });
      const handle = mountListDataSurface({
        registry,
        descriptor: descriptor(),
        controller,
        context: context(),
      });
      const before = controller.snapshot();
      await expect(
        registry.execute({
          version: 1,
          commandId: 'deny-6',
          identity,
          expectedRevision: registry.inspect(identity)?.revision ?? 0,
          controlId: 'toggle-row-selection',
          payload: { rowId: 'c' },
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(controller.snapshot()).toEqual(before);
      handle.destroy();
    });

    it('denies set-column-order naming an unreadable column', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-7',
        identity,
        expectedRevision: rev,
        controlId: 'set-column-order',
        payload: { columnIds: ['missing-column'] },
      }));
    });

    it('denies set-column-visibility naming an unreadable column', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-8',
        identity,
        expectedRevision: rev,
        controlId: 'set-column-visibility',
        payload: { columns: [{ columnId: 'missing-column', visible: false }] },
      }));
    });

    it('denies set-page-size of 0', async () => {
      await expectDeniedUnchanged({}, (rev) => ({
        version: 1,
        commandId: 'deny-9',
        identity,
        expectedRevision: rev,
        controlId: 'set-page-size',
        payload: { pageSize: 0 },
      }));
    });

    it('denies an otherwise-allowed table command when acceptsTableCommand refuses it', async () => {
      await expectDeniedUnchanged(
        { acceptsTableCommand: () => false },
        (rev) => ({
          version: 1,
          commandId: 'deny-10',
          identity,
          expectedRevision: rev,
          controlId: 'set-filters',
          payload: {
            filters: [{ columnId: 'title', operator: 'contains', value: 'x' }],
          },
        }),
      );
    });
  });

  it('routes reveal and highlight to their page callbacks', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const reveal = vi.fn();
    const highlight = vi.fn();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      reveal,
      highlight,
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'do-reveal',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'reveal',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(reveal).toHaveBeenCalledOnce();

    await expect(
      registry.execute({
        version: 1,
        commandId: 'do-highlight',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'highlight',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(highlight).toHaveBeenCalledOnce();

    handle.destroy();
  });

  it('seeds and reports the mounted revision via initialRevision/onRevision', () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const onRevision = vi.fn();
    const handle = mountListDataSurface({
      registry,
      descriptor: descriptor(),
      controller,
      context: context(),
      initialRevision: 41,
      onRevision,
    });
    expect(registry.inspect(identity)?.revision).toBe(41);
    expect(onRevision).toHaveBeenCalledWith(41);
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
