import { describe, expect, it, vi } from 'vitest';
import { createDataSurfaceRegistry } from '../data-surface.js';
import { registerLinkSurface, resolveLinkTarget } from '../link-surface.js';
import { registerStepSurface } from '../step-surface.js';

const links = [
  { id: 'events', label: 'Events', href: '/s/events', group: 'Content' },
  { id: 'articles', label: 'Articles', href: '/s/articles', group: 'Content' },
  { id: 'ads', label: 'Advertising', href: '/s/ads' },
];

let sequence = 0;
function command(
  surfaceId: string,
  kind: 'list' | 'custom',
  controlId: string,
  expectedRevision: number,
  payload?: unknown,
) {
  sequence += 1;
  return {
    version: 1 as const,
    commandId: `c${sequence}`,
    identity: { surfaceId, kind },
    expectedRevision,
    controlId,
    ...(payload === undefined ? {} : { payload: payload as never }),
  };
}

describe('link surface', () => {
  it('resolves by id, label, and unique prefix; refuses ambiguity', () => {
    expect(resolveLinkTarget('events', links)).toBe('/s/events');
    expect(resolveLinkTarget({ target: 'ARTICLES' }, links)).toBe(
      '/s/articles',
    );
    expect(resolveLinkTarget({ page: 'adv' }, links)).toBe('/s/ads');
    expect(resolveLinkTarget('a', links)).toBeNull();
    expect(resolveLinkTarget({ nope: 1 }, links)).toBeNull();
  });

  it('publishes links without hrefs and navigates through the open control', async () => {
    const registry = createDataSurfaceRegistry();
    const navigate = vi.fn();
    const handle = registerLinkSurface({
      registry,
      surfaceId: 'site-sections',
      label: 'Site sections',
      description: 'Pages in this site',
      links,
      navigate,
    });
    const snapshot = registry.inspect({
      surfaceId: 'site-sections',
      kind: 'list',
    });
    expect(JSON.stringify(snapshot?.state)).not.toContain('/s/');
    expect(snapshot?.state.links).toEqual([
      { id: 'events', label: 'Events', group: 'Content' },
      { id: 'articles', label: 'Articles', group: 'Content' },
      { id: 'ads', label: 'Advertising' },
    ]);
    const ok = await registry.execute(
      command('site-sections', 'list', 'open', snapshot?.revision ?? 0, {
        target: 'Events',
      }),
    );
    expect(ok.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/s/events');
    const refused = await registry.execute(
      command('site-sections', 'list', 'open', snapshot?.revision ?? 0, {
        target: 'https://evil.example',
      }),
    );
    expect(refused.ok).toBe(false);

    handle.update({ state: { active: 'events' } });
    expect(
      registry.inspect({ surfaceId: 'site-sections', kind: 'list' })?.revision,
    ).toBe((snapshot?.revision ?? 0) + 1);
    handle.destroy();
    expect(registry.list()).toHaveLength(0);
  });
});

describe('step surface', () => {
  const steps = [
    { id: 'town', label: 'Your town' },
    { id: 'features', label: 'Features' },
    { id: 'live', label: 'Go live' },
  ];
  const identity = { surfaceId: 'new-site-steps', kind: 'custom' as const };

  it('advances a non-writing step through the page handler', async () => {
    const registry = createDataSurfaceRegistry();
    const next = vi.fn(() => true);
    const handle = registerStepSurface({
      registry,
      surfaceId: 'new-site-steps',
      label: 'New site steps',
      description: 'Start a new town site',
      steps,
      current: 'town',
      next,
    });
    const before = registry.inspect(identity);
    expect(before?.state).toMatchObject({
      current: 'town',
      currentLabel: 'Your town',
      stepNumber: 1,
      stepCount: 3,
      nextWrites: false,
      awaitingPerson: false,
    });
    const result = await registry.execute(
      command('new-site-steps', 'custom', 'next', before?.revision ?? 0),
    );
    expect(result.ok).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
    handle.update({
      current: 'features',
      steps: [{ ...steps[0], complete: true }, steps[1], steps[2]],
    });
    const after = registry.inspect(identity);
    expect(after?.state.current).toBe('features');
    expect(after?.state.steps).toEqual([
      { id: 'town', label: 'Your town', status: 'complete' },
      { id: 'features', label: 'Features', status: 'current' },
      { id: 'live', label: 'Go live', status: 'upcoming' },
    ]);
  });

  it('refuses when the page handler rejects the step (validation failed)', async () => {
    const registry = createDataSurfaceRegistry();
    registerStepSurface({
      registry,
      surfaceId: 'new-site-steps',
      label: 'New site steps',
      description: 'Start a new town site',
      steps,
      current: 'town',
      next: () => false,
    });
    const result = await registry.execute(
      command('new-site-steps', 'custom', 'next', 1),
    );
    expect(result.ok).toBe(false);
  });

  it('never presses a writing step: it shows the button and waits for the person', async () => {
    const registry = createDataSurfaceRegistry();
    const create = vi.fn();
    const showNext = vi.fn();
    const handle = registerStepSurface({
      registry,
      surfaceId: 'new-site-steps',
      label: 'New site steps',
      description: 'Start a new town site',
      steps,
      current: 'features',
      next: create,
      nextWrites: true,
      showNext,
    });
    const result = await registry.execute(
      command('new-site-steps', 'custom', 'next', 1),
    );
    expect(result.ok).toBe(true);
    expect(create).not.toHaveBeenCalled();
    expect(showNext).toHaveBeenCalledTimes(1);
    expect(registry.inspect(identity)?.state).toMatchObject({
      nextWrites: true,
      awaitingPerson: true,
    });
    handle.update({ current: 'live', nextWrites: false });
    expect(registry.inspect(identity)?.state.awaitingPerson).toBe(false);
  });

  it('goes back and jumps only to available steps', async () => {
    const registry = createDataSurfaceRegistry();
    const back = vi.fn();
    const goTo = vi.fn();
    registerStepSurface({
      registry,
      surfaceId: 'new-site-steps',
      label: 'New site steps',
      description: 'Start a new town site',
      steps: [{ ...steps[0], complete: true }, steps[1], steps[2]],
      current: 'features',
      back,
      goTo,
    });
    expect(
      (await registry.execute(command('new-site-steps', 'custom', 'back', 1)))
        .ok,
    ).toBe(true);
    expect(back).toHaveBeenCalled();
    expect(
      (
        await registry.execute(
          command('new-site-steps', 'custom', 'go-to', 1, {
            target: 'Go live',
          }),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await registry.execute(
          command('new-site-steps', 'custom', 'go-to', 1, 'your town'),
        )
      ).ok,
    ).toBe(true);
    expect(goTo).toHaveBeenCalledWith('town');
  });
});
