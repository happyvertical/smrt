import { mount, tick, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import RuntimeDiagnosticsWebMcp from '../RuntimeDiagnosticsWebMcp.svelte';
import {
  createRuntimeDiagnosticsWebMcpTool,
  RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
  registerRuntimeDiagnosticsWebMcp,
} from '../runtime-diagnostics-webmcp.js';

describe('runtime diagnostics WebMCP', () => {
  it('is a no-op without document.modelContext', () => {
    expect(registerRuntimeDiagnosticsWebMcp({})).toBeNull();
  });

  it('registers one read-only tool and aborts on dispose', () => {
    const registerTool = vi.fn();
    const owner = registerRuntimeDiagnosticsWebMcp({
      modelContext: { registerTool },
    });
    expect(registerTool).toHaveBeenCalledOnce();
    const [tool, opts] = registerTool.mock.calls[0];
    expect(tool.name).toBe(RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME);
    expect(tool.annotations.readOnlyHint).toBe(true);
    owner?.dispose();
    expect(opts.signal.aborted).toBe(true);
  });

  it('maps endpoint failures to stable error codes and honours a custom endpoint', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 }));
    const tool = createRuntimeDiagnosticsWebMcpTool(
      fetchFn as never,
      '/custom',
    );
    expect(JSON.parse(await tool.execute({}))).toEqual({
      ok: false,
      error: { code: 'authentication_required' },
    });
    expect(fetchFn.mock.calls[0][0]).toBe('/custom');
    const ok = createRuntimeDiagnosticsWebMcpTool(
      (async () => new Response('{"a":1}')) as never,
    );
    expect(JSON.parse(await ok.execute({}))).toEqual({ a: 1 });
  });

  it('component registers only while enabled and disposes on unmount', async () => {
    const registerTool = vi.fn();
    Object.defineProperty(document, 'modelContext', {
      value: { registerTool },
      configurable: true,
    });
    try {
      const target = document.createElement('div');
      const off = mount(RuntimeDiagnosticsWebMcp, {
        target,
        props: { enabled: false },
      });
      await tick();
      expect(registerTool).not.toHaveBeenCalled();
      unmount(off);
      const on = mount(RuntimeDiagnosticsWebMcp, {
        target,
        props: { enabled: true },
      });
      await tick();
      expect(registerTool).toHaveBeenCalledOnce();
      const signal = registerTool.mock.calls[0][1].signal as AbortSignal;
      unmount(on);
      await tick();
      expect(signal.aborted).toBe(true);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test cleanup
      delete (document as any).modelContext;
    }
  });
});
