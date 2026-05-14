/**
 * Tests for defineToolsDock factory.
 *
 * These tests exercise the reactive API surface directly. Svelte `setContext`
 * is called inside the factory, but the returned `ToolsDockInstance` is the
 * subject under test — we don't need a full component tree to verify the
 * state machine.
 *
 * `setContext` only works inside a component init scope, so we invoke the
 * factory inside Svelte's `mount` (via a thin host component) so that all
 * `$state` runes wire up correctly.
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  defineToolsDock,
  ToolsDockInstance,
} from '../tools-dock/define-tools-dock.svelte.js';
import type { ToolDef } from '../types.js';
import HostHarness from './harness.svelte';

const noopTool = {} as ToolDef['component'];

interface HarnessExposed {
  dock: ToolsDockInstance;
}

function mountDock(options: Parameters<typeof defineToolsDock>[0]): {
  dock: ToolsDockInstance;
  teardown: () => void;
} {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const exposed: HarnessExposed = {
    dock: undefined as unknown as ToolsDockInstance,
  };
  const component = mount(HostHarness, {
    target,
    props: {
      options,
      onReady: (dock: ToolsDockInstance) => {
        exposed.dock = dock;
      },
    },
  });
  return {
    dock: exposed.dock,
    teardown: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('defineToolsDock', () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
    if (typeof window !== 'undefined') {
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  function track<T>(value: { teardown: () => void } & T): T {
    cleanup.push(value.teardown);
    return value;
  }

  it('creates an API with sensible defaults', () => {
    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
        ],
      }),
    );

    expect(dock.isOpen).toBe(false);
    expect(dock.activeTool).toBeNull();
    expect(dock.layout).toBe('rail');
    expect(dock.storageKey).toBeNull();
    expect(dock.availableTools.map((t) => t.id)).toEqual(['chat', 'jobs']);
  });

  it('open() / close() / toggle() update isOpen and activeTool', () => {
    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
        ],
      }),
    );

    dock.open('chat');
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBe('chat');

    dock.close();
    flushSync();
    expect(dock.isOpen).toBe(false);
    // activeTool persists so re-opening lands on the same tool.
    expect(dock.activeTool).toBe('chat');

    dock.toggle('jobs');
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBe('jobs');

    // toggle on the same id closes.
    dock.toggle('jobs');
    flushSync();
    expect(dock.isOpen).toBe(false);

    // toggle without id flips just isOpen.
    dock.toggle();
    flushSync();
    expect(dock.isOpen).toBe(true);
  });

  it('open() on unknown id is a no-op (does not crash, does not open)', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
      }),
    );

    dock.open('does-not-exist');
    flushSync();
    expect(dock.isOpen).toBe(false);
    expect(dock.activeTool).toBeNull();
  });

  it('respects initialOpen and picks first tool when toggled', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        initialOpen: true,
      }),
    );

    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBeNull();

    dock.toggle();
    flushSync();
    // First toggle while no tool active selects the first available.
    // (Was open → now closed; activeTool now set on the next open.)
    expect(dock.isOpen).toBe(false);

    dock.toggle();
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBe('chat');
  });

  it('setContext updates context and triggers fetchAvailability', async () => {
    const fetchAvailability = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'chat' }])
      .mockResolvedValueOnce([{ id: 'chat' }, { id: 'jobs' }]);

    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
          { id: 'hidden', label: 'Hidden', component: noopTool },
        ],
        fetchAvailability,
      }),
    );

    // No call yet — fetchAvailability only fires on setContext.
    expect(fetchAvailability).not.toHaveBeenCalled();

    dock.setContext({ type: 'thing', title: 'A' });
    // setContext invokes fetchAvailability synchronously; the promise resolves
    // on the next microtask, so flushSync after a few microtasks is required
    // for Svelte to settle the resulting state update.
    expect(fetchAvailability).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(dock.availableTools.map((t) => t.id)).toEqual(['chat']);

    dock.setContext({ type: 'thing', title: 'B' });
    expect(fetchAvailability).toHaveBeenCalledTimes(2);
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(dock.availableTools.map((t) => t.id)).toEqual(['chat', 'jobs']);
  });

  it('drops stale fetchAvailability results (race-safety)', async () => {
    let resolveFirst: ((v: { id: string }[]) => void) | null = null;
    let resolveSecond: ((v: { id: string }[]) => void) | null = null;

    const fetchAvailability = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }[]>((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ id: string }[]>((r) => {
            resolveSecond = r;
          }),
      );

    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
        ],
        fetchAvailability,
      }),
    );

    dock.setContext({ type: 'A' });
    await Promise.resolve();
    dock.setContext({ type: 'B' });
    await Promise.resolve();

    // Resolve the *stale* (first) call after the newer one. Then resolve the
    // newer one. The stale value must not stomp the fresh value.
    resolveFirst?.([{ id: 'chat' }]);
    resolveSecond?.([{ id: 'jobs' }]);
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    expect(dock.availableTools.map((t) => t.id)).toEqual(['jobs']);
  });

  it('emit / on / unsubscribe', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
      }),
    );

    const handler = vi.fn();
    const off = dock.on<{ ok: boolean }>('test', handler);
    dock.emit('test', { ok: true });
    expect(handler).toHaveBeenCalledWith({ ok: true });

    off();
    dock.emit('test', { ok: false });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emit catches handler errors without dropping later handlers', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
      }),
    );

    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const after = vi.fn();
    dock.on('test', throwing);
    dock.on('test', after);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => dock.emit('test', null)).not.toThrow();
    expect(throwing).toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('persists state to localStorage when storageKey provided', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        storageKey: 'tdtest:v1',
      }),
    );

    dock.open('chat');
    flushSync();
    const raw = window.localStorage.getItem('tdtest:v1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual({ isOpen: true, activeTool: 'chat' });
  });

  it('hydrates state from localStorage on hydrate()', () => {
    window.localStorage.setItem(
      'tdtest:v2',
      JSON.stringify({ isOpen: true, activeTool: 'jobs' }),
    );

    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
        ],
        storageKey: 'tdtest:v2',
      }),
    );

    dock.hydrate();
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBe('jobs');
  });

  it('hydrate() ignores activeTool that no longer matches a registered tool', () => {
    window.localStorage.setItem(
      'tdtest:v3',
      JSON.stringify({ isOpen: true, activeTool: 'gone' }),
    );

    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        storageKey: 'tdtest:v3',
      }),
    );

    dock.hydrate();
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBeNull();
  });

  it('clears activeTool when availability removes the active tool', async () => {
    let availability: { id: string }[] = [{ id: 'chat' }, { id: 'jobs' }];
    const fetchAvailability = vi.fn(async () => availability);

    const { dock } = track(
      mountDock({
        tools: [
          { id: 'chat', label: 'Chat', component: noopTool },
          { id: 'jobs', label: 'Jobs', component: noopTool },
        ],
        fetchAvailability,
      }),
    );

    dock.setContext({ type: 'a' });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    dock.open('jobs');
    flushSync();
    expect(dock.activeTool).toBe('jobs');

    availability = [{ id: 'chat' }];
    dock.setContext({ type: 'b' });
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(dock.availableTools.map((t) => t.id)).toEqual(['chat']);
    expect(dock.activeTool).toBeNull();
  });
});
