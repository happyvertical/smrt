import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import Fixture from './list-sort-surface.fixture.svelte';

const rows = [
  { id: 's1', title: 'Budget passes', published: '2026-09-01' },
  { id: 's2', title: 'Arena opens', published: '2026-09-20' },
];
const identity = { surfaceId: 'stories-ui', kind: 'list' as const };
let sequence = 0;
function setSorting(expectedRevision: number, sorting: unknown) {
  sequence += 1;
  return {
    version: 1 as const,
    commandId: `sort-${sequence}`,
    identity,
    expectedRevision,
    controlId: 'set-sorting',
    payload: { sorting } as never,
  };
}

describe('useListSurface sorting', () => {
  it('reports the page sort and applies an agent sort through onSort', async () => {
    const registry = createDataSurfaceRegistry();
    render(Fixture, { props: { registry, rows } });
    await tick();
    const before = registry.inspect(identity);
    expect(
      [...(before?.descriptor.query.sortableColumnIds ?? [])].sort(),
    ).toEqual(['published', 'title']);
    expect(before?.descriptor.controls.map((control) => control.id)).toContain(
      'set-sorting',
    );
    expect(before?.state.sort).toEqual({
      columnId: 'published',
      direction: 'desc',
    });

    const result = await registry.execute(
      setSorting(before?.revision ?? 0, [
        { columnId: 'title', direction: 'asc' },
      ]),
    );
    expect(result.ok).toBe(true);
    await tick();
    expect(screen.getByTestId('sort').textContent).toBe('title:asc');
    expect(registry.inspect(identity)?.state.sort).toEqual({
      columnId: 'title',
      direction: 'asc',
    });
  });

  it('refuses unsortable columns, multiple rules, and a denied onSort', async () => {
    const registry = createDataSurfaceRegistry();
    render(Fixture, { props: { registry, rows, deny: true } });
    await tick();
    const revision = () => registry.inspect(identity)?.revision ?? 0;
    expect(
      (
        await registry.execute(
          setSorting(revision(), [{ columnId: 'id', direction: 'asc' }]),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await registry.execute(
          setSorting(revision(), [
            { columnId: 'title', direction: 'asc' },
            { columnId: 'published', direction: 'desc' },
          ]),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await registry.execute(
          setSorting(revision(), [{ columnId: 'title', direction: 'asc' }]),
        )
      ).ok,
    ).toBe(false);
    expect(screen.getByTestId('sort').textContent).toBe('published:desc');
  });
});
