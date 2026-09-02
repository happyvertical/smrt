import {
  createDataSurfaceCommandBridge,
  type DataSurfaceBridgeConnectionState,
  type DataSurfaceBridgeMessage,
  type DataSurfaceBridgePeer,
} from '@happyvertical/smrt-chat';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { describe, expect, it, vi } from 'vitest';
import {
  buildContentListSurfaceDescriptor,
  createContentListController,
} from './content-list-controller.js';
import {
  type ContentListSurfaceContext,
  registerContentListDataSurface,
} from './content-list-data-surface.js';

function context(
  overrides: Partial<ContentListSurfaceContext> = {},
): ContentListSurfaceContext {
  return {
    viewMode: 'grid',
    queryFingerprint: 'query-1',
    totalRows: 2,
    freshness: {
      stale: false,
      refreshing: false,
      offline: false,
      lastUpdated: '2026-08-30T12:00:00.000Z',
      truncated: false,
      warnings: [],
    },
    ...overrides,
  };
}

function disconnectedTransport() {
  const listeners = new Set<
    (message: unknown, peer: DataSurfaceBridgePeer) => void
  >();
  const statuses = new Set<(state: DataSurfaceBridgeConnectionState) => void>();
  const messages: DataSurfaceBridgeMessage[] = [];
  return {
    messages,
    send(message: DataSurfaceBridgeMessage) {
      messages.push(message);
    },
    subscribe(
      listener: (message: unknown, peer: DataSurfaceBridgePeer) => void,
    ) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStatus(
      listener: (state: DataSurfaceBridgeConnectionState) => void,
    ) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
    disconnect() {
      for (const listener of statuses) listener('disconnected');
    },
  };
}

describe('ContentList mounted data surface', () => {
  it('keeps multiple lists independently addressable and acknowledges view changes', async () => {
    const registry = createDataSurfaceRegistry();
    const firstController = createContentListController();
    const secondController = createContentListController();
    let firstView: 'grid' | 'detailed' | 'compact' = 'grid';
    const first = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({ surfaceId: 'first' }),
      controller: firstController,
      context: context(),
      setViewMode: (view) => {
        firstView = view;
        first.update(context({ viewMode: view }));
      },
    });
    const second = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({ surfaceId: 'second' }),
      controller: secondController,
      context: context({ queryFingerprint: 'query-2' }),
      setViewMode: vi.fn(),
    });

    expect(registry.list().map((entry) => entry.identity.surfaceId)).toEqual([
      'first',
      'second',
    ]);
    const identity = { surfaceId: 'first', kind: 'table' as const };
    const before = registry.inspect(identity);
    const changed = await registry.execute({
      version: 1,
      commandId: 'view-detailed',
      identity,
      expectedRevision: before?.revision ?? 0,
      controlId: 'set-view',
      payload: { view: 'detailed' },
    });

    expect(changed.ok).toBe(true);
    expect(changed.revision).toBeGreaterThan(before?.revision ?? -1);
    expect(changed.snapshot?.state.viewMode).toBe('detailed');
    expect(firstView).toBe('detailed');
    expect(
      registry.inspect({ surfaceId: 'second', kind: 'table' })?.state
        .queryFingerprint,
    ).toBe('query-2');
    first.destroy();
    second.destroy();
  });

  it('publishes freshness and selection, rejects stale commands, and bounds selection', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createContentListController();
    const identity = { surfaceId: 'bounded', kind: 'table' as const };
    const handle = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({
        surfaceId: 'bounded',
        limits: { maxSelectionSize: 2 },
      }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
    });
    const initial = registry.inspect(identity);
    handle.update(
      context({
        freshness: {
          ...context().freshness,
          stale: true,
          offline: true,
          warnings: ['cached rows'],
        },
      }),
    );

    const stale = await registry.execute({
      version: 1,
      commandId: 'stale-search',
      identity,
      expectedRevision: initial?.revision ?? 0,
      controlId: 'set-search',
      payload: { search: 'draft' },
    });
    expect(stale).toMatchObject({ ok: false, reason: 'stale_revision' });

    const oversized = await registry.execute({
      version: 1,
      commandId: 'oversized-selection',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'set-selected-rows',
      payload: { rowIds: ['a', 'b', 'c'] },
    });
    expect(oversized).toMatchObject({ ok: false, reason: 'denied' });
    expect(registry.inspect(identity)?.state.freshness).toEqual({
      stale: true,
      refreshing: false,
      offline: true,
      lastUpdated: '2026-08-30T12:00:00.000Z',
      truncated: false,
      warnings: ['cached rows'],
    });
    handle.destroy();
    expect(registry.inspect(identity)).toBeUndefined();
  });

  it('rejects a revision from before a same-identity re-registration', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createContentListController();
    const identity = { surfaceId: 'rebound', kind: 'table' as const };
    let revision = -1;
    const first = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({ surfaceId: 'rebound' }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
      onRevision: (next) => {
        revision = next;
      },
    });
    const before = registry.inspect(identity);
    first.destroy();
    const rebound = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({
        surfaceId: 'rebound',
        lifecycle: true,
      }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
      initialRevision: revision + 1,
      onRevision: (next) => {
        revision = next;
      },
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'replayed-before-rebind',
        identity,
        expectedRevision: before?.revision ?? 0,
        controlId: 'set-view',
        payload: { view: 'compact' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'stale_revision' });
    rebound.destroy();
  });

  it('rejects filters whose operators are not published by a server-backed descriptor', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createContentListController();
    const identity = {
      surfaceId: 'server-filter-allowlist',
      kind: 'table' as const,
    };
    const handle = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({
        surfaceId: identity.surfaceId,
        serverBacked: true,
      }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'unpublished-not-contains',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'set-filters',
        payload: {
          filters: [
            { columnId: 'title', operator: 'notContains', value: 'draft' },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(controller.getState().filters).toEqual([]);
    handle.destroy();
  });

  it('refuses a toggle that would exceed the retained selection cap', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createContentListController();
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: ['retained-a', 'retained-b'],
    });
    const identity = {
      surfaceId: 'retained-selection',
      kind: 'table' as const,
    };
    const handle = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({
        surfaceId: identity.surfaceId,
        limits: { maxSelectionSize: 2 },
      }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'over-cap-cross-page-toggle',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'toggle-row-selection',
        payload: { rowId: 'current-row' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(controller.getState().selectedRowIds).toEqual([
      'retained-a',
      'retained-b',
    ]);
    handle.destroy();
  });

  it('counts type-distinct retained row ids when enforcing the toggle cap', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createContentListController();
    controller.dispatch({ type: 'setSelectedRows', rowIds: ['1'] });
    const identity = { surfaceId: 'typed-selection', kind: 'table' as const };
    const handle = registerContentListDataSurface({
      registry,
      descriptor: buildContentListSurfaceDescriptor({
        surfaceId: identity.surfaceId,
        limits: { maxSelectionSize: 2 },
      }),
      controller,
      context: context(),
      setViewMode: vi.fn(),
    });

    await expect(
      registry.execute({
        version: 1,
        commandId: 'add-number-one',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'toggle-row-selection',
        payload: { rowId: 1 },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(controller.getState().selectedRowIds).toEqual([1, '1']);

    await expect(
      registry.execute({
        version: 1,
        commandId: 'reject-over-cap-type-distinct',
        identity,
        expectedRevision: registry.inspect(identity)?.revision ?? 0,
        controlId: 'toggle-row-selection',
        payload: { rowId: '2' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'denied' });
    expect(controller.getState().selectedRowIds).toEqual([1, '1']);
    handle.destroy();
  });

  it('fails a visible ContentList command closed when its browser disconnects', async () => {
    const transport = disconnectedTransport();
    const bridge = createDataSurfaceCommandBridge({
      transport,
      sessionId: 'content-session',
      source: 'content-agent',
      peerSource: 'content-browser',
      authorize: (command) =>
        command.identity.surfaceId === 'content-list-disconnect',
      timeoutMs: 100,
    });
    const pending = bridge.send({
      version: 1,
      commandId: 'change-view',
      identity: { surfaceId: 'content-list-disconnect', kind: 'table' },
      expectedRevision: 0,
      controlId: 'set-view',
      payload: { view: 'compact' },
    });
    await vi.waitFor(() => expect(transport.messages).toHaveLength(1));

    transport.disconnect();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'disconnected',
    });
    bridge.dispose();
  });
});
