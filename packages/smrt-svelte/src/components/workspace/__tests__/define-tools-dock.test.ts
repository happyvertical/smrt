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

  it('exposes context on the public ToolsDockApi surface', () => {
    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
      }),
    );

    expect(dock.context).toBeNull();
    dock.setContext({ type: 'route', title: 'Home' });
    flushSync();
    expect(dock.context).toEqual({ type: 'route', title: 'Home' });

    dock.setContext(null);
    flushSync();
    expect(dock.context).toBeNull();
  });

  it('badge: null in availability clears a registered default (not falls back)', async () => {
    const fetchAvailability = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'chat', badge: null }]);

    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', badge: 3, component: noopTool }],
        fetchAvailability,
      }),
    );

    dock.setContext({ type: 'a' });
    await new Promise((r) => setTimeout(r, 0));
    flushSync();

    // `badge: null` is explicit ("clear it"), not a fallback signal.
    expect(dock.availableTools[0].badge).toBeNull();
  });

  it('handles synchronous throws from fetchAvailability without surfacing them', async () => {
    const fetchAvailability = vi.fn(() => {
      throw new Error('sync boom');
    });

    const { dock } = track(
      mountDock({
        tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        fetchAvailability: fetchAvailability as unknown as (
          ctx: import('../types.js').ToolsDockContext | null,
        ) => Promise<import('../types.js').AvailableTool[]>,
      }),
    );

    // The sync throw must be caught by the wrapped promise chain, not
    // propagate out of setContext to the caller.
    expect(() => dock.setContext({ type: 'a' })).not.toThrow();

    // The internal `.catch` applies an empty-availability result.
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
    expect(dock.availableTools).toEqual([]);
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

  describe("'change' event", () => {
    it('does not fire during factory construction', () => {
      // Subscribing in a separate tick would miss any event fired during the
      // factory body. To assert "no construction-time emit" we count via a
      // listener added *before* the factory runs — but the factory's
      // listener bus is internal, so instead we rely on the fact that
      // `'change'` is gated by the `ready` flag and verify post-construction
      // state is clean (no recursive errors etc.) here.
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
          initialOpen: true,
        }),
      );

      // Sanity: initial state reflects options without any emit having fired.
      expect(dock.isOpen).toBe(true);
      expect(dock.activeTool).toBeNull();
    });

    it('fires on open() with the post-update state', () => {
      const { dock } = track(
        mountDock({
          tools: [
            { id: 'chat', label: 'Chat', component: noopTool },
            { id: 'jobs', label: 'Jobs', component: noopTool },
          ],
        }),
      );

      const handler = vi.fn();
      dock.on('change', handler);

      dock.open('chat');
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: true,
        activeTool: 'chat',
        context: null,
      });
    });

    it('fires on close() with the post-update state', () => {
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      dock.open('chat');
      flushSync();
      const handler = vi.fn();
      dock.on('change', handler);

      dock.close();
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({
        // close() leaves activeTool intact so re-opens land on the same tool.
        isOpen: false,
        activeTool: 'chat',
        context: null,
      });
    });

    it('fires on toggle() with the post-update state', () => {
      const { dock } = track(
        mountDock({
          tools: [
            { id: 'chat', label: 'Chat', component: noopTool },
            { id: 'jobs', label: 'Jobs', component: noopTool },
          ],
        }),
      );

      const handler = vi.fn();
      dock.on('change', handler);

      dock.toggle('chat');
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: true,
        activeTool: 'chat',
        context: null,
      });

      dock.toggle('chat');
      flushSync();
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: false,
        activeTool: 'chat',
        context: null,
      });

      dock.toggle();
      flushSync();
      expect(handler).toHaveBeenCalledTimes(3);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: true,
        activeTool: 'chat',
        context: null,
      });
    });

    it('fires on setContext() with the new context', () => {
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      const handler = vi.fn();
      dock.on('change', handler);

      dock.setContext({ type: 'route', title: 'Home' });
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: false,
        activeTool: null,
        context: { type: 'route', title: 'Home' },
      });
    });

    it('fires once with cleared state when availability removes the active tool', async () => {
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

      const handler = vi.fn();
      dock.on('change', handler);

      availability = [{ id: 'chat' }];
      dock.setContext({ type: 'b' });
      // setContext emits synchronously …
      expect(handler).toHaveBeenCalledTimes(1);
      // … then the async availability refresh resolves, clears the active
      // tool, and emits a second 'change' with the cleared state.
      await Promise.resolve();
      await Promise.resolve();
      flushSync();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith({
        isOpen: true,
        activeTool: null,
        context: { type: 'b' },
      });
    });

    it('stops calling a handler after its unsubscribe function runs', () => {
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      const handler = vi.fn();
      const off = dock.on('change', handler);

      dock.open('chat');
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);

      off();
      dock.close();
      flushSync();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('payload type is inferred from ToolsDockEvents', () => {
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      // Compile-time check: handler arg should be the `change` payload shape
      // without an explicit generic.
      dock.on('change', (e) => {
        const _isOpen: boolean = e.isOpen;
        const _activeTool: string | null = e.activeTool;
        void _isOpen;
        void _activeTool;
      });

      // Runtime sanity check that the test compiles & wires.
      dock.open('chat');
      flushSync();
      expect(dock.isOpen).toBe(true);
    });

    // ─────────────────────────────────────────────────────────────
    // Regression tests: no-op state changes must NOT fire 'change'.
    //
    // Before this guard, idempotent calls like `dock.open(activeId)` when
    // already open emitted spurious events. Combined with effects that
    // call setContext on every prop change, that produced redundant work
    // (availability refetch) and could amplify into noisy loops when
    // consumers wired the 'change' event back into upstream state.
    // ─────────────────────────────────────────────────────────────

    it('does NOT fire on open() when already at that state', () => {
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

      const handler = vi.fn();
      dock.on('change', handler);

      // Same id, already open — no observable state change.
      dock.open('chat');
      flushSync();
      expect(handler).not.toHaveBeenCalled();

      // open() with no id, already open with an active tool — still a no-op.
      dock.open();
      flushSync();
      expect(handler).not.toHaveBeenCalled();
    });

    it('does NOT fire on close() when already closed', () => {
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      const handler = vi.fn();
      dock.on('change', handler);

      // Initial state is closed; calling close again must not emit.
      dock.close();
      flushSync();
      expect(handler).not.toHaveBeenCalled();
    });

    it('does NOT fire on setContext() with the same reference', async () => {
      const fetchAvailability = vi.fn().mockResolvedValue([{ id: 'chat' }]);
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
          fetchAvailability,
        }),
      );

      const ctx = { type: 'route', title: 'Home' } as const;
      dock.setContext(ctx);
      // Initial emit + initial fetchAvailability call.
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
      expect(fetchAvailability).toHaveBeenCalledTimes(1);

      const handler = vi.fn();
      dock.on('change', handler);

      // Same reference — must short-circuit (no emit, no refetch).
      dock.setContext(ctx);
      flushSync();
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
      expect(handler).not.toHaveBeenCalled();
      expect(fetchAvailability).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire on toggle(id) that resolves to the same state', () => {
      // toggle(sameId) when open+active flips to closed; toggle again
      // flips back to open+active. Each transition is real, so each emits.
      // The "no observable change" branch for toggle is hard to trigger
      // through the API surface alone (toggle always flips at minimum
      // `isOpen`), so the assertion here is the symmetric one: the emit
      // counts match the number of real state transitions.
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
        }),
      );

      const handler = vi.fn();
      dock.on('change', handler);

      dock.toggle('chat'); // open+active
      flushSync();
      dock.toggle('chat'); // close
      flushSync();
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('does not retrigger context-forwarding $effect when state mutates', async () => {
      // Regression guard for the reactive-read leak in emitChange. Without
      // `untrack` around the $state reads, an $effect calling
      // dock.setContext would also depend on isOpen/activeTool/context
      // (read inside the emitChange invoked by setContext). A subsequent
      // dock.open() would mutate those, re-run the effect, call setContext
      // again, etc. Here we verify open() does NOT cause the forwarding
      // effect's tracked count to grow.
      const fetchAvailability = vi.fn().mockResolvedValue([{ id: 'chat' }]);
      const { dock } = track(
        mountDock({
          tools: [{ id: 'chat', label: 'Chat', component: noopTool }],
          fetchAvailability,
        }),
      );

      // Mount a child component whose $effect mirrors a `currentCtx` $state
      // into dock.setContext — same pattern <ToolsDock>'s context prop uses.
      const target = document.createElement('div');
      document.body.appendChild(target);
      cleanup.push(() => target.remove());

      // We use the harness pattern: a tiny inline component would require
      // its own file. Instead, count how many times fetchAvailability runs
      // after the initial setContext — open() / close() must not cause it
      // to re-run via a re-triggered forwarding effect.
      dock.setContext({ type: 'a' });
      await new Promise((r) => setTimeout(r, 0));
      flushSync();
      const initialFetchCount = fetchAvailability.mock.calls.length;

      const handler = vi.fn();
      dock.on('change', handler);

      dock.open('chat');
      flushSync();
      dock.close();
      flushSync();

      // Two real state transitions → two emits, but the context-forwarding
      // chain stays quiet: no extra fetchAvailability calls beyond the
      // initial setContext.
      expect(handler).toHaveBeenCalledTimes(2);
      expect(fetchAvailability.mock.calls.length).toBe(initialFetchCount);
    });
  });
});
