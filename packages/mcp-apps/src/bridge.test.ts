import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MCP_APPS_PROTOCOL_VERSION, McpAppBridge } from './index.js';

function fixture(
  hostCapabilities: Record<string, unknown> = {
    serverTools: {},
    openLinks: {},
    message: { text: {} },
    updateModelContext: { text: {}, structuredContent: {} },
  },
) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: Record<string, unknown>[] = [];
  const host = {
    postMessage: vi.fn((value, origin) => {
      expect(origin).toBe('https://host.example');
      sent.push(value);
    }),
  } as unknown as Window;
  const local = {
    crypto: { randomUUID },
    addEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
  } as unknown as Window;
  const bridge = new McpAppBridge({
    hostWindow: host,
    hostOrigin: 'https://host.example',
    window: local,
    appInfo: { name: 'fixture', version: '1' },
    timeoutMs: 100,
    availableDisplayModes: ['inline', 'fullscreen'],
  });
  const receive = (
    data: unknown,
    source = host,
    origin = 'https://host.example',
  ) => {
    for (const listener of listeners)
      listener({ data, source, origin } as MessageEvent);
  };
  const reply = (result: unknown, request = sent.at(-1)) =>
    receive({ jsonrpc: '2.0', id: request?.id, result });
  const notify = (method: string, params: unknown) =>
    receive({ jsonrpc: '2.0', method, params });
  const initialized = {
    protocolVersion: MCP_APPS_PROTOCOL_VERSION,
    hostInfo: { name: 'synthetic', version: '1' },
    hostCapabilities,
    hostContext: {},
  };
  const connect = async () => {
    const promise = bridge.connect();
    reply(initialized);
    await promise;
  };
  return {
    bridge,
    sent,
    host,
    local,
    receive,
    reply,
    notify,
    initialized,
    connect,
    listeners,
  };
}

describe('portable Apps pinned wire boundary', () => {
  it('uses the pinned initialize shape and never advertises remote closure tools', async () => {
    const f = fixture();
    await f.connect();
    expect(f.sent[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'fixture', version: '1' },
        appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      },
    });
    expect(f.sent[1]).toEqual({
      jsonrpc: '2.0',
      method: 'ui/notifications/initialized',
    });
    expect(f.bridge.snapshot.state).toBe('ready');
    f.bridge.dispose();
  });
  it.each([
    { protocolVersion: '2026-07-28' },
    { hostContext: undefined },
    { hostCapabilities: [] },
    { hostCapabilities: { serverTools: true } },
    { hostContext: { displayMode: 'future' } },
    { hostContext: { platform: 'watch' } },
    { hostInfo: { name: 1, version: '1' } },
  ])('fails closed on incompatible handshake %j', async (patch) => {
    const f = fixture();
    const promise = f.bridge.connect();
    // Missing required hostContext is malformed; undefined is not transported JSON.
    const result = { ...f.initialized, ...patch };
    if (result.hostContext === undefined)
      delete (result as Record<string, unknown>).hostContext;
    f.reply(result);
    await expect(promise).rejects.toThrow();
    expect(f.listeners.size).toBe(0);
  });
  it('rejects wildcard, opaque and untrusted HTTP origins', () => {
    for (const hostOrigin of [
      '*',
      'null',
      'https://host.example/path',
      'http://evil.example',
    ])
      expect(
        () =>
          new McpAppBridge({
            hostWindow: {} as Window,
            window: {} as Window,
            hostOrigin,
            appInfo: { name: 'x', version: '1' },
          }),
      ).toThrow();
  });
  it('ignores wrong source/origin, IDs, malformed and bounded hostile data', async () => {
    const f = fixture();
    const promise = f.bridge.connect();
    const request = f.sent[0];
    const good = { jsonrpc: '2.0', id: request.id, result: f.initialized };
    f.receive(good, {} as Window);
    f.receive(good, f.host, 'https://evil.example');
    f.receive(good, f.host, 'null');
    f.receive({ ...good, id: 'other' });
    f.receive({ ...good, error: {} });
    f.receive({ ...good, result: 'x'.repeat(131073) });
    let deep: unknown = {};
    for (let n = 0; n < 30; n++) deep = { deep };
    f.receive({ ...good, result: deep });
    expect(f.bridge.snapshot.state).toBe('connecting');
    f.receive(good);
    await promise;
    f.receive(good);
    expect(
      f.sent.filter((v) => v.method === 'ui/notifications/initialized'),
    ).toHaveLength(1);
    f.bridge.dispose();
  });
  it('routes tools and preserves text/structured results without auth metadata', async () => {
    const f = fixture();
    await f.connect();
    const pending = f.bridge.callTool('opportunity_list', {});
    expect(f.sent.at(-1)).toMatchObject({
      method: 'tools/call',
      params: { name: 'opportunity_list', arguments: {} },
    });
    const result = {
      content: [{ type: 'text', text: 'One synthetic opportunity' }],
      structuredContent: { rows: [{ id: 'synthetic-1' }] },
    };
    f.reply(result);
    await expect(pending).resolves.toEqual(result);
    f.bridge.dispose();
  });
  it('treats missing/unknown caps as unavailable and snapshots cannot grant authority', async () => {
    const f = fixture({ futureCapability: {} });
    await f.connect();
    f.bridge.snapshot.hostCapabilities.serverTools = {};
    await expect(f.bridge.callTool('list')).rejects.toThrow('unavailable');
    await expect(f.bridge.sendMessage('hi')).rejects.toThrow('unavailable');
    await expect(
      f.bridge.openLink('https://app.example/review'),
    ).rejects.toThrow('unavailable');
    f.bridge.dispose();
  });
  it('uses runtime schema array messages and explicit modality capabilities', async () => {
    const f = fixture();
    await f.connect();
    const pending = f.bridge.sendMessage('Inspect');
    expect(f.sent.at(-1)).toMatchObject({
      method: 'ui/message',
      params: { role: 'user', content: [{ type: 'text', text: 'Inspect' }] },
    });
    f.reply({});
    await pending;
    const context = f.bridge.updateModelContext({
      structuredContent: { selected: 'synthetic-1' },
    });
    f.reply({});
    await context;
    await expect(f.bridge.openLink('javascript:alert(1)')).rejects.toThrow();
    const link = f.bridge.openLink('https://app.example/review');
    f.reply({ isError: true });
    await expect(link).rejects.toThrow('rejected');
    f.bridge.dispose();
    const noText = fixture({ message: {}, updateModelContext: {} });
    await noText.connect();
    await expect(noText.bridge.sendMessage('hi')).rejects.toThrow('modality');
    await expect(
      noText.bridge.updateModelContext({ structuredContent: {} }),
    ).rejects.toThrow('modality');
    noText.bridge.dispose();
  });
  it('defaults to inline and refuses unknown host enum updates', async () => {
    const f = fixture();
    await f.connect();
    await expect(f.bridge.requestDisplayMode('fullscreen')).rejects.toThrow(
      'unavailable',
    );
    f.notify('ui/notifications/host-context-changed', {
      theme: 'dark',
      availableDisplayModes: ['inline', 'fullscreen'],
    });
    f.notify('ui/notifications/host-context-changed', { theme: 'evil' });
    expect(f.bridge.snapshot.hostContext.theme).toBe('dark');
    const p = f.bridge.requestDisplayMode('fullscreen');
    f.reply({ mode: 'future' });
    await expect(p).rejects.toThrow('Unsupported');
    f.bridge.dispose();
  });
  it('ignores out-of-order and stale input/result updates', async () => {
    const f = fixture();
    await f.connect();
    const result = { content: [{ type: 'text', text: 'first' }] };
    f.notify('ui/notifications/tool-result', result);
    expect(f.bridge.snapshot.toolResult).toBeUndefined();
    f.notify('ui/notifications/tool-input', {});
    f.notify('ui/notifications/tool-result', result);
    f.notify('ui/notifications/tool-result', {
      content: [{ type: 'text', text: 'stale' }],
    });
    expect(f.bridge.snapshot.toolResult).toEqual(result);
    f.bridge.dispose();
    f.notify('ui/notifications/host-context-changed', { theme: 'dark' });
    expect(f.bridge.snapshot.hostContext.theme).toBeUndefined();
  });
  it('rejects malformed results and propagates correlated upstream failures', async () => {
    const f = fixture();
    await f.connect();
    const p = f.bridge.callTool('list');
    f.reply({ content: [{ type: 'future', text: 'x' }] });
    await expect(p).rejects.toThrow('modality');
    const q = f.bridge.callTool('list');
    f.receive({
      jsonrpc: '2.0',
      id: f.sent.at(-1)?.id,
      error: { code: -32000, message: 'Forbidden' },
    });
    await expect(q).rejects.toThrow('Forbidden');
    f.bridge.dispose();
  });
  it('teardown disposes listeners and pending calls, reports no app-tools method', async () => {
    const f = fixture();
    await f.connect();
    const pending = f.bridge.callTool('list');
    f.receive({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'apply' },
    });
    expect(f.sent.at(-1)).toMatchObject({ id: 1, error: { code: -32601 } });
    f.receive({
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/resource-teardown',
      params: {},
    });
    await expect(pending).rejects.toThrow('disposed');
    expect(f.bridge.signal.aborted).toBe(true);
    expect(f.listeners.size).toBe(0);
    f.bridge.dispose();
  });
  it('cancels and times out calls without accepting late replies', async () => {
    const f = fixture();
    await f.connect();
    const controller = new AbortController();
    const pending = f.bridge.callTool('list', {}, controller.signal);
    const request = f.sent.at(-1);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    f.reply({ content: [] }, request);
    expect(f.sent.at(-1)).toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: request?.id },
    });
    await expect(f.bridge.callTool('list')).rejects.toThrow('timed out');
    f.bridge.dispose();
  });
});

it('teardown still disposes when the host transport fails', async () => {
  const f = fixture();
  await f.connect();
  const pending = f.bridge.callTool('list');
  vi.mocked(f.host.postMessage).mockImplementation(() => {
    throw new Error('Host gone');
  });
  f.receive({
    jsonrpc: '2.0',
    id: 2,
    method: 'ui/resource-teardown',
    params: {},
  });
  await expect(pending).rejects.toThrow('disposed');
  expect(f.listeners.size).toBe(0);
  expect(f.bridge.signal.aborted).toBe(true);
});

it('bounds pending work and rejects non-JSON outgoing tool arguments', async () => {
  const f = fixture();
  await f.connect();
  await expect(
    f.bridge.callTool('list', { secret: () => 'closure' }),
  ).rejects.toThrow('JSON');
  const requests = Array.from({ length: 32 }, () =>
    f.bridge.callTool('pending').catch((error: Error) => error.message),
  );
  await expect(f.bridge.callTool('pending')).rejects.toThrow('Too many');
  f.bridge.dispose();
  expect(await Promise.all(requests)).toEqual(
    Array(32).fill('MCP Apps bridge disposed'),
  );
});
