import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EffectsReactivity from './webmcp-effects-reactivity.fixture.svelte';
import Harness from './webmcp-harness.svelte';
import HarnessUnannotated from './webmcp-harness-unannotated.svelte';

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
});
