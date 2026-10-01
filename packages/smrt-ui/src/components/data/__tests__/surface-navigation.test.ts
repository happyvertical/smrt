import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDataSurfaceRegistry } from '../data-surface.js';
import { registerLinkSurface } from '../link-surface.js';
import {
  hasPendingSurfaceNavigation,
  trackSurfaceNavigation,
  whenSurfaceNavigationSettled,
} from '../surface-navigation.js';

const links = [{ id: 'events', label: 'Events', href: '/s/events' }];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function openCommand(revision = 1) {
  return {
    version: 1 as const,
    commandId: `open-${Math.random()}`,
    identity: { surfaceId: 'site-sections', kind: 'list' as const },
    expectedRevision: revision,
    controlId: 'open',
    payload: { target: 'Events' },
  };
}

describe('whenSurfaceNavigationSettled', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for a link surface navigation and the new page to register', async () => {
    const registry = createDataSurfaceRegistry();
    const navigation = deferred();
    registerLinkSurface({
      registry,
      surfaceId: 'site-sections',
      label: 'Site sections',
      description: 'Pages',
      links,
      navigate: () => navigation.promise,
    });

    const result = await registry.execute(openCommand());
    // The command answers at once; the page change is still running.
    expect(result.ok).toBe(true);
    expect(hasPendingSurfaceNavigation(registry)).toBe(true);

    let settled = false;
    const waiting = whenSurfaceNavigationSettled(registry, {
      quietMs: 20,
    }).then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    // The new page mounts its surface as the navigation finishes.
    navigation.resolve();
    await Promise.resolve();
    registry.register({
      descriptor: {
        version: 1,
        identity: { surfaceId: 'events', kind: 'list' },
        schemaVersion: 1,
        label: 'Events',
        rowKey: 'id',
        columns: [
          { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
        ],
        query: { modes: ['rows'], projectableColumnIds: ['id'] },
        controls: [],
        actions: [],
        limits: { maxQueryRows: 1, maxQueryBytes: 1000, maxSelectionSize: 1 },
      },
      getSnapshot: () => ({ revision: 1, state: {}, selection: null }),
    });
    await waiting;
    expect(settled).toBe(true);
    expect(hasPendingSurfaceNavigation(registry)).toBe(false);
  });

  it('resolves after a quiet period when nothing navigates', async () => {
    const registry = createDataSurfaceRegistry();
    const started = Date.now();
    await whenSurfaceNavigationSettled(registry, { quietMs: 10 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('gives up after the timeout, and a failed navigation still settles', async () => {
    const registry = createDataSurfaceRegistry();
    void trackSurfaceNavigation(registry, new Promise(() => {}));
    const started = Date.now();
    await whenSurfaceNavigationSettled(registry, {
      quietMs: 5,
      timeoutMs: 40,
    });
    expect(Date.now() - started).toBeLessThan(1_000);

    const other = createDataSurfaceRegistry();
    const failing = trackSurfaceNavigation(
      other,
      Promise.reject(new Error('nope')),
    );
    await expect(failing).rejects.toThrow('nope');
    await whenSurfaceNavigationSettled(other, { quietMs: 5 });
    expect(hasPendingSurfaceNavigation(other)).toBe(false);
  });

  it('keeps waiting while a watched source keeps changing', async () => {
    const registry = createDataSurfaceRegistry();
    const listeners = new Set<(event: unknown) => void>();
    const tools = {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    let settled = false;
    const waiting = whenSurfaceNavigationSettled(registry, {
      quietMs: 30,
      alsoWatch: [tools],
    }).then(() => {
      settled = true;
    });
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
      for (const listener of listeners) listener({ type: 'registered' });
    }
    expect(settled).toBe(false);
    await waiting;
    expect(settled).toBe(true);
    expect(listeners.size).toBe(0);
  });
});
