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
});
