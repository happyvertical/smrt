import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Wrap the registrar in a spy so a test can observe *which* policy each
// `useWebMcpTool` effect run handed it, including runs the policy excludes
// before they ever reach document.modelContext.registerTool (#2599).
const registerBespokeSpy = vi.hoisted(() => vi.fn());
vi.mock('@happyvertical/smrt-web', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-web')>();
  registerBespokeSpy.mockImplementation(actual.registerWebMcpBespokeTool);
  return { ...actual, registerWebMcpBespokeTool: registerBespokeSpy };
});

import EffectsReactivity from './webmcp-effects-reactivity.fixture.svelte';
import Harness from './webmcp-harness.svelte';
import HarnessReactiveSameName from './webmcp-harness-reactive-samename.svelte';
import HarnessUnannotated from './webmcp-harness-unannotated.svelte';

/**
 * Mimics a host that rejects a duplicate tool name while it still considers
 * an earlier registration of that name live, and only forgets that name one
 * microtask after the earlier registration's abort signal fires — modeling
 * a host that does not process deregistration perfectly synchronously with
 * `AbortController.abort()`.
 */
function installCollisionAwareModelContext() {
  const registered: Array<{ name: string; signal?: AbortSignal }> = [];
  const liveNames = new Set<string>();
  document.modelContext = {
    async registerTool(
      tool: { name: string },
      options?: { signal?: AbortSignal },
    ) {
      if (liveNames.has(tool.name)) {
        throw new Error(`host collision: ${tool.name}`);
      }
      liveNames.add(tool.name);
      registered.push({ name: tool.name, signal: options?.signal });
      options?.signal?.addEventListener('abort', () => {
        void Promise.resolve().then(() => {
          liveNames.delete(tool.name);
        });
      });
    },
  };
  return { registered, liveNames };
}

function installModelContext() {
  const registered: Array<{
    name: string;
    signal?: AbortSignal;
  }> = [];
  document.modelContext = {
    async registerTool(
      tool: { name: string },
      options?: { signal?: AbortSignal },
    ) {
      registered.push({ name: tool.name, signal: options?.signal });
    },
  };
  return registered;
}

afterEach(() => {
  delete document.modelContext;
  registerBespokeSpy.mockClear();
});

describe('useWebMcpTool', () => {
  it('registers on mount, aborts on spec changes, and aborts on unmount', async () => {
    const registered = installModelContext();
    const view = render(Harness, { props: { version: 1 } });
    // Registration now routes through a dynamically imported registrar
    // (#2586), so it lands one or more microtasks after mount.
    await vi.waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0].name).toBe('harness_tool_1');
    expect(registered[0].signal?.aborted).toBe(false);

    await view.rerender({ version: 2 });
    await vi.waitFor(() => expect(registered).toHaveLength(2));
    expect(registered[0].signal?.aborted).toBe(true);
    expect(registered[1].name).toBe('harness_tool_2');

    view.unmount();
    expect(registered[1].signal?.aborted).toBe(true);
  });

  it('observes asynchronous host rejection and aborts the failed registration', async () => {
    let rejectRegistration: ((reason?: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    document.modelContext = {
      registerTool(_tool, options) {
        signal = options?.signal;
        return new Promise<void>((_resolve, reject) => {
          rejectRegistration = reject;
        });
      },
    };

    const view = render(Harness);
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);

    rejectRegistration?.(new Error('host collision'));
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    view.unmount();
  });

  it('is a no-op when WebMCP is unavailable', async () => {
    const view = render(Harness);
    await tick();
    expect(view.container).toHaveTextContent('1');
    view.unmount();
  });

  it('excludes an undeclared tool under the default read-only exposure policy', async () => {
    const registered = installModelContext();
    const view = render(HarnessUnannotated);
    // No Provider ancestor: the hook falls back to the registrar's default
    // read-only policy. An undeclared spec classifies destructive (#2586)
    // and must never reach document.modelContext.registerTool.
    await tick();
    await tick();
    await tick();
    expect(registered).toHaveLength(0);
    view.unmount();
    expect(registered).toHaveLength(0);
  });

  it('disposes a registered destructive bespoke tool when a Provider policy tightens from destructive to read (#2586 F2)', async () => {
    const registered = installModelContext();
    const view = render(EffectsReactivity, {
      props: { effects: ['destructive'] },
    });
    await vi.waitFor(() =>
      expect(registered.map((tool) => tool.name)).toContain(
        'reactivity_destructive_tool',
      ),
    );
    expect(registered).toHaveLength(1);
    const first = registered[0];
    expect(first.signal?.aborted).toBe(false);

    // `bespokeContext.effects` is read synchronously at the top of the
    // `$effect` body (the F2 fix), so this Provider policy change is
    // tracked as a dependency and re-runs the effect: the previously
    // registered destructive tool is torn down, and re-registration under
    // the new read-only policy is excluded before it ever reaches
    // document.modelContext.registerTool again.
    await view.rerender({ effects: ['read'] });
    await vi.waitFor(() => expect(first.signal?.aborted).toBe(true));
    expect(registered).toHaveLength(1);

    view.unmount();
  });

  it('serializes same-name re-registration across rapid reactive reruns without a host collision', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registered, liveNames } = installCollisionAwareModelContext();
    const view = render(HarnessReactiveSameName, { props: { version: 1 } });
    await vi.waitFor(() => expect(registered.length).toBeGreaterThan(0));

    // Three reactive reruns in quick succession, all under the SAME tool
    // name. Without serializing against the previous run's registration
    // settling, a new run's registration attempt can reach the host before
    // it has processed the previous run's abort, producing a host
    // collision — this must never happen.
    await view.rerender({ version: 2 });
    await view.rerender({ version: 3 });
    await view.rerender({ version: 4 });

    await vi.waitFor(() => {
      const live = registered.filter((tool) => !tool.signal?.aborted);
      expect(live).toHaveLength(1);
      expect(live[0]?.name).toBe('harness_reactive_tool');
    });
    expect(liveNames.has('harness_reactive_tool')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();

    view.unmount();
    warnSpy.mockRestore();
  });

  it('registers a previously-excluded bespoke tool when a Provider policy loosens to permit it (#2599)', async () => {
    const registered = installModelContext();
    const view = render(EffectsReactivity, {
      props: { effects: ['read'] },
    });
    // The bespoke tool's static factory declares `destructiveHint: true` and
    // has no rune dependencies of its own, so under a read-only Provider
    // policy the registrar classifies it destructive and excludes it before
    // it ever reaches document.modelContext.registerTool. Wait for that
    // first evaluation to actually happen under the read-only policy — the
    // registrar is reached through a dynamic import, so without this the
    // policy change below could race ahead of the first evaluation and the
    // test would pass even if the effect never re-ran.
    await vi.waitFor(() => expect(registerBespokeSpy).toHaveBeenCalledTimes(1));
    expect(registerBespokeSpy.mock.calls[0][1]).toEqual({
      effects: ['read'],
    });
    expect(registered).toHaveLength(0);

    // `bespokeContext.effects` is read synchronously at the top of the
    // `$effect` body, so this Provider policy change is tracked as a
    // dependency and re-runs the effect even though the component's own
    // factory never changed: the registrar is consulted again under the
    // loosened policy and the tool newly registers.
    await view.rerender({ effects: ['destructive'] });
    await vi.waitFor(() => expect(registerBespokeSpy).toHaveBeenCalledTimes(2));
    expect(registerBespokeSpy.mock.calls[1][1]).toEqual({
      effects: ['destructive'],
    });
    await vi.waitFor(() =>
      expect(registered.map((tool) => tool.name)).toContain(
        'reactivity_destructive_tool',
      ),
    );
    expect(registered).toHaveLength(1);
    expect(registered[0].signal?.aborted).toBe(false);

    view.unmount();
    expect(registered[0].signal?.aborted).toBe(true);
  });
});
