/**
 * Regression tests for the typed-tool component pattern documented on
 * `ToolDef.component` and `ToolsDockContext`. The static type checks live
 * in `typed-tool-fixture/register-typed-tool.ts` — those files only need
 * to compile under `tsc --noEmit` to prove the documented pattern works.
 * This test verifies the runtime side: the typed component registers
 * cleanly, the dock activates it, and `dock.setContext` accepts both the
 * typed and untyped action shapes.
 *
 * If the type fixture ever stops compiling, `pnpm typecheck` (and CI) will
 * fail before this file runs — that's the load-bearing assertion. The
 * runtime test below guards against accidental regressions in the
 * `ToolDef` storage shape itself (e.g. registering a component that ends
 * up unreachable because of a runtime type assertion).
 */

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolsDockInstance } from '../tools-dock/define-tools-dock.svelte.js';
import HostHarness from './harness.svelte';
import {
  typedContext,
  typedOptions,
  untypedContext,
} from './typed-tool-fixture/register-typed-tool.js';

interface HarnessExposed {
  dock: ToolsDockInstance;
}

function mountTypedDock(): {
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
      options: typedOptions,
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

describe('typed-tool fixture (regression guard for PR #1239 review)', () => {
  let cleanup: Array<() => void> = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    for (const fn of cleanup.splice(0)) fn();
  });

  it('accepts a tool component with a narrowed context prop type', () => {
    const { dock, teardown } = mountTypedDock();
    cleanup.push(teardown);

    // The fixture registered TypedTool, whose `context` prop is
    // `ToolsDockContext<MyData, MyActions> | null`. If ToolDef.component's
    // type contravariantly required the wider base context, this
    // registration would not have compiled — which `pnpm typecheck` catches
    // first. At runtime, we just need to confirm the tool is registered
    // and reachable.
    expect(dock.availableTools.map((t) => t.id)).toEqual(['typed']);

    dock.open('typed');
    flushSync();
    expect(dock.isOpen).toBe(true);
    expect(dock.activeTool).toBe('typed');
  });

  it('accepts the typed context shape via setContext()', () => {
    const { dock, teardown } = mountTypedDock();
    cleanup.push(teardown);

    dock.setContext(typedContext);
    flushSync();
    // The context round-trips with the typed action shape intact at runtime
    // (the dock erases the generic but does not mutate the value).
    expect(dock.context?.data).toEqual({
      siteSlug: 'demo',
      contentId: 'demo-1',
    });
    // The action is callable — the runtime keeps reference identity.
    expect(typeof dock.context?.actions?.triggerSave).toBe('function');
  });

  it('accepts the untyped (back-compat) context shape via setContext()', () => {
    const { dock, teardown } = mountTypedDock();
    cleanup.push(teardown);

    // `untypedContext` uses the default `ToolsDockContext` (no generic
    // arguments). If the default `TActions` were the prior
    // `Record<string, never>`, this `actions: { triggerSave }` would have
    // been rejected at typecheck time — the regression Copilot flagged.
    dock.setContext(untypedContext);
    flushSync();
    expect(typeof dock.context?.actions?.triggerSave).toBe('function');
  });
});
