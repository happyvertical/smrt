import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Harness from './webmcp-harness.svelte';

function installModelContext() {
  const registered: Array<{
    name: string;
    signal?: AbortSignal;
  }> = [];
  document.modelContext = {
    registerTool(tool: { name: string }, options?: { signal?: AbortSignal }) {
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
    await tick();

    expect(registered).toHaveLength(1);
    expect(registered[0].name).toBe('harness_tool_1');
    expect(registered[0].signal?.aborted).toBe(false);

    await view.rerender({ version: 2 });
    await tick();
    expect(registered).toHaveLength(2);
    expect(registered[0].signal?.aborted).toBe(true);
    expect(registered[1].name).toBe('harness_tool_2');

    view.unmount();
    expect(registered[1].signal?.aborted).toBe(true);
  });

  it('is a no-op when WebMCP is unavailable', async () => {
    const view = render(Harness);
    await tick();
    expect(view.container).toHaveTextContent('1');
    view.unmount();
  });
});
