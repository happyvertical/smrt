import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fixture from './surfaces.fixture.svelte';

const rows = [
  {
    id: 'a1',
    title: 'Council approves budget',
    status: 'published',
    token: 's3cret',
  },
  { id: 'a2', title: 'Café opens downtown', status: 'draft', token: 's3cret' },
  {
    id: 'a3',
    title: 'Council meeting moved',
    status: 'review',
    token: 's3cret',
  },
];

let sequence = 0;
function command(
  identity: { surfaceId: string; kind: 'list' | 'custom' },
  controlId: string,
  expectedRevision: number,
  payload?: unknown,
) {
  sequence += 1;
  return {
    version: 1 as const,
    commandId: `cmd-${sequence}`,
    identity,
    expectedRevision,
    controlId,
    ...(payload === undefined ? {} : { payload: payload as never }),
  };
}

afterEach(() => {
  delete document.modelContext;
});

describe('surface hooks on the Provider registry', () => {
  it('tryUseWebMcpUi is null without a Provider and the hooks register nothing', () => {
    const registry = createDataSurfaceRegistry();
    const onContext = vi.fn();
    render(Fixture, {
      props: {
        dataSurfaceRegistry: registry,
        withProvider: false,
        rows,
        navigate: vi.fn(),
        onContext,
        create: vi.fn(),
      },
    });
    expect(onContext).toHaveBeenCalledWith(false);
    expect(registry.list()).toEqual([]);
  });

  it('useListSurface publishes projected rows and finds rows by title across all rows', async () => {
    const registry = createDataSurfaceRegistry();
    const onContext = vi.fn();
    const view = render(Fixture, {
      props: {
        dataSurfaceRegistry: registry,
        rows,
        navigate: vi.fn(),
        onContext,
        create: vi.fn(),
      },
    });
    await tick();
    expect(onContext).toHaveBeenCalledWith(true);
    const identity = { surfaceId: 'articles-ui', kind: 'list' as const };
    const before = registry.inspect(identity);
    expect(before?.state.rows).toEqual([
      { id: 'a1', title: 'Council approves budget', status: 'published' },
      { id: 'a2', title: 'Café opens downtown', status: 'draft' },
    ]);
    expect(before?.state.rowsTruncated).toBe(true);
    expect(JSON.stringify(before?.state)).not.toContain('s3cret');
    expect(before?.descriptor.query.searchableColumnIds).toEqual(['title']);

    const found = await registry.execute(
      command(identity, 'find', before?.revision ?? 0, { text: 'MEETING' }),
    );
    expect(found.ok).toBe(true);
    const after = registry.inspect(identity);
    expect(after?.state.rows).toEqual([
      { id: 'a3', title: 'Council meeting moved', status: 'review' },
    ]);
    expect(after?.state.find).toEqual({ text: 'MEETING', matches: 1 });

    const accent = await registry.execute(
      command(identity, 'find', after?.revision ?? 0, 'cafe'),
    );
    expect(accent.ok).toBe(true);
    expect(registry.inspect(identity)?.state.rows).toEqual([
      { id: 'a2', title: 'Café opens downtown', status: 'draft' },
    ]);

    const cleared = await registry.execute(
      command(identity, 'find', registry.inspect(identity)?.revision ?? 0, {
        text: '',
      }),
    );
    expect(cleared.ok).toBe(true);
    expect(registry.inspect(identity)?.state.find).toBeUndefined();

    // Table commands stay refused: the page's own controls own its state.
    const refused = await registry.execute(
      command(
        identity,
        'set-search',
        registry.inspect(identity)?.revision ?? 0,
        {
          search: 'x',
        },
      ),
    );
    expect(refused.ok).toBe(false);

    view.unmount();
    expect(registry.list()).toEqual([]);
  });

  it('useLinkSurface navigates to a published link', async () => {
    const registry = createDataSurfaceRegistry();
    const navigate = vi.fn();
    render(Fixture, {
      props: { dataSurfaceRegistry: registry, rows, navigate, create: vi.fn() },
    });
    await tick();
    const identity = { surfaceId: 'site-sections-ui', kind: 'list' as const };
    const snapshot = registry.inspect(identity);
    expect(snapshot?.state.active).toBe('articles');
    const result = await registry.execute(
      command(identity, 'open', snapshot?.revision ?? 0, { target: 'events' }),
    );
    expect(result.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/s/events');
  });

  it('useStepSurface moves a wizard forward and leaves the writing step to the person', async () => {
    const registry = createDataSurfaceRegistry();
    const create = vi.fn();
    render(Fixture, {
      props: { dataSurfaceRegistry: registry, rows, navigate: vi.fn(), create },
    });
    await tick();
    const identity = { surfaceId: 'new-site-steps', kind: 'custom' as const };
    const first = registry.inspect(identity);
    expect(first?.state.current).toBe('town');
    expect(
      (await registry.execute(command(identity, 'next', first?.revision ?? 0)))
        .ok,
    ).toBe(true);
    await tick();
    expect(screen.getByTestId('step')).toHaveTextContent('features');
    const second = registry.inspect(identity);
    expect(second?.state).toMatchObject({
      current: 'features',
      nextWrites: true,
    });

    expect(
      (await registry.execute(command(identity, 'next', second?.revision ?? 0)))
        .ok,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Create site' }),
    );
    expect(registry.inspect(identity)?.state.awaitingPerson).toBe(true);
  });
});
