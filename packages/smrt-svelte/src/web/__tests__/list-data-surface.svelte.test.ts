/**
 * Component-lifecycle proof for `mountListDataSurface` (#2906), in the same
 * conformance style as `data-surface-conformance.integration.svelte.test.ts`:
 * a real Svelte component mounts a custom (non-DataTable) list, the registry
 * drives it with commands, and unmounting the component tears the
 * registration down. The registration/translation logic itself is unit
 * tested directly against the registry in `list-data-surface.test.ts`.
 */

import {
  createDataSurfaceRegistry,
  createDataTableController,
  type DataSurfaceDescriptor,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Fixture from './list-data-surface.fixture.svelte';

const identity: DataSurfaceIdentity = {
  surfaceId: 'fixture-list',
  kind: 'list',
};

function descriptor(): DataSurfaceDescriptor {
  return {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Fixture list',
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
      { id: 'star', label: 'Star selected' },
    ],
    actions: [],
    limits: { maxQueryRows: 50, maxQueryBytes: 10_000, maxSelectionSize: 5 },
  };
}

describe('mountListDataSurface (component integration)', () => {
  it('drives a mounted custom list from the registry and tears down on unmount', async () => {
    const registry = createDataSurfaceRegistry();
    const controller = createDataTableController();
    const onRefresh = vi.fn().mockResolvedValue(true);

    const { unmount } = render(Fixture, {
      props: {
        registry,
        descriptor: descriptor(),
        controller,
        context: { totalRows: 3, queryFingerprint: 'fixture-1' },
        onRefresh,
      },
    });

    expect(screen.getByTestId('filter-text').textContent).toBe('');
    const before = registry.inspect(identity);
    expect(before?.state.totalRows).toBe(3);

    const filtered = await registry.execute({
      version: 1,
      commandId: 'filter-1',
      identity,
      expectedRevision: before?.revision ?? 0,
      controlId: 'set-filters',
      payload: {
        filters: [{ columnId: 'title', operator: 'contains', value: 'draft' }],
      },
    });
    expect(filtered.ok).toBe(true);
    expect(screen.getByTestId('filter-text').textContent).toBe('draft');

    const refreshed = await registry.execute({
      version: 1,
      commandId: 'refresh-1',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'refresh',
    });
    expect(refreshed.ok).toBe(true);
    expect(onRefresh).toHaveBeenCalledOnce();

    const starred = await registry.execute({
      version: 1,
      commandId: 'star-1',
      identity,
      expectedRevision: registry.inspect(identity)?.revision ?? 0,
      controlId: 'star',
    });
    expect(starred.ok).toBe(true);
    expect(screen.getByTestId('starred-count').textContent).toBe('1');

    unmount();

    // Unmounting tore down the mounted surface — the identity is gone.
    expect(registry.inspect(identity)).toBeUndefined();
    await expect(
      registry.execute({
        version: 1,
        commandId: 'after-unmount',
        identity,
        expectedRevision: 0,
        controlId: 'refresh',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_found' });
  });
});
