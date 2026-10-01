import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MCP_APPS_PROTOCOL_VERSION, McpAppBridge } from './index.js';
import { json } from './validation.js';

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

it('preserves bounded extension data as isolated snapshots without granting capabilities', async () => {
  const f = fixture({ 'example/extension': { version: '1' } });
  const connecting = f.bridge.connect();
  f.reply({
    ...f.initialized,
    hostContext: { 'example/route': { path: 'list' } },
  });
  await connecting;
  expect(f.bridge.snapshot.rawHostContext).toEqual({
    'example/route': { path: 'list' },
  });
  expect(f.bridge.snapshot.hostContext).toEqual({});
  expect(f.bridge.snapshot.rawHostCapabilities).toEqual({
    'example/extension': { version: '1' },
  });
  expect(f.bridge.snapshot.hostCapabilities).toEqual({});
  const first = f.bridge.snapshot.rawHostContext['example/route'] as {
    path: string;
  };
  first.path = 'mutated by consumer';
  const observed: unknown[] = [];
  f.bridge.subscribe((snapshot) => {
    observed.push(snapshot.rawHostContext);
  });
  f.notify('ui/notifications/host-context-changed', {
    theme: 'dark',
    'example/route': { path: 'detail' },
  });
  expect(f.bridge.snapshot.rawHostContext).toEqual({
    theme: 'dark',
    'example/route': { path: 'detail' },
  });
  expect(observed).toHaveLength(2);
  await expect(f.bridge.callTool('list')).rejects.toThrow('unavailable');
  f.bridge.dispose();
});

it('rejects malicious extension payloads and drops extension changes after disposal', async () => {
  const f = fixture();
  await f.connect();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const malformed = [
    { 'example/extension': 'x'.repeat(131073) },
    { 'example/extension': cyclic },
    JSON.parse('{"example/extension":{"__proto__":{"admin":true}}}'),
    { 'example/extension': Object.create({ inherited: true }) },
    {
      'example/extension': {
        get unsafe() {
          throw new Error('Must not execute accessor');
        },
      },
    },
  ];
  for (const value of malformed)
    f.notify('ui/notifications/host-context-changed', value);
  expect(f.bridge.snapshot.rawHostContext).toEqual({});
  f.notify('ui/notifications/host-context-changed', {
    'example/extension': { valid: true },
  });
  f.bridge.dispose();
  f.notify('ui/notifications/host-context-changed', {
    'example/extension': { stale: true },
  });
  expect(f.bridge.snapshot.rawHostContext).toEqual({
    'example/extension': { valid: true },
  });
});

it('bounds accumulated raw context across individually valid updates atomically', async () => {
  const f = fixture();
  await f.connect();
  for (let n = 0; n < 100; n++)
    f.notify('ui/notifications/host-context-changed', {
      [`example/key-${n}`]: 'x'.repeat(1000),
    });
  expect(Object.keys(f.bridge.snapshot.rawHostContext).length).toBeLessThan(50);
  const before = f.bridge.snapshot;
  f.notify('ui/notifications/host-context-changed', {
    theme: 'dark',
    'example/overflow': 'x'.repeat(40000),
  });
  expect(f.bridge.snapshot.rawHostContext).toEqual(before.rawHostContext);
  expect(f.bridge.snapshot.hostContext).toEqual(before.hostContext);
  f.bridge.dispose();
});

const extensionDeclaration = () => ({
  id: 'example.resources',
  capability: { path: ['experimental', 'example/resources'] },
  methods: [
    'resources/read',
    'resources/subscribe',
    'resources/unsubscribe',
    'example/resources/write',
  ],
  notifications: ['notifications/resources/updated'],
});
const extensionCapabilities = { experimental: { 'example/resources': {} } };

it('requires initialized plain-object extension capability and declared matching versions', async () => {
  const absent = fixture({});
  expect(() => absent.bridge.registerExtension(extensionDeclaration())).toThrow(
    'not ready',
  );
  await absent.connect();
  (
    absent.bridge.snapshot.rawHostCapabilities as Record<string, unknown>
  ).experimental = extensionCapabilities.experimental;
  expect(() => absent.bridge.registerExtension(extensionDeclaration())).toThrow(
    'unavailable',
  );
  absent.bridge.dispose();
  const malformed = fixture({ experimental: { 'example/resources': true } });
  await malformed.connect();
  expect(() =>
    malformed.bridge.registerExtension(extensionDeclaration()),
  ).toThrow('object');
  malformed.bridge.dispose();
  const f = fixture({
    experimental: { 'example/resources': { version: '2' } },
  });
  await f.connect();
  expect(() =>
    f.bridge.registerExtension({
      ...extensionDeclaration(),
      capability: {
        path: ['experimental', 'example/resources'],
        version: { key: 'version', supported: ['1'] },
      },
    }),
  ).toThrow('version');
  const handle = f.bridge.registerExtension({
    ...extensionDeclaration(),
    capability: {
      path: ['experimental', 'example/resources'],
      version: { key: 'version', supported: ['2'] },
    },
  });
  expect(handle.signal.aborted).toBe(false);
  f.bridge.dispose();
});

it('copies allowlists, rejects reserved/unregistered methods and duplicate owners', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  for (const method of [
    'tools/call',
    'ui/initialize',
    'ui/open-link',
    'notifications/cancelled',
  ])
    expect(() =>
      f.bridge.registerExtension({
        ...extensionDeclaration(),
        methods: [method],
      }),
    ).toThrow('Reserved');
  const declaration = extensionDeclaration();
  const handle = f.bridge.registerExtension(declaration);
  declaration.methods.push('example/unsafe');
  expect(() => f.bridge.registerExtension(extensionDeclaration())).toThrow(
    'registered',
  );
  expect(() =>
    f.bridge.registerExtension({
      ...extensionDeclaration(),
      id: 'example.other',
    }),
  ).toThrow('registered');
  await expect(handle.request('example/unsafe', {})).rejects.toThrow(
    'not registered',
  );
  const promise = handle.request('resources/read', { uri: 'test://fixture' });
  expect(f.sent.at(-1)).toMatchObject({
    method: 'resources/read',
    params: { uri: 'test://fixture' },
  });
  f.reply({ contents: [{ uri: 'test://fixture', text: 'Synthetic content' }] });
  await expect(promise).resolves.toMatchObject({
    contents: [{ text: 'Synthetic content' }],
  });
  f.bridge.dispose();
});

it('isolates subscribed extension notifications and denies unknown/host-request dispatch', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  const handle = f.bridge.registerExtension(extensionDeclaration());
  const received = vi.fn();
  handle.subscribe((_method, params) => {
    params.uri = 'changed';
    throw new Error('Observer error');
  });
  const unsubscribe = handle.subscribe(received);
  f.notify('notifications/resources/updated', { uri: 'test://fixture' });
  expect(received).toHaveBeenCalledWith('notifications/resources/updated', {
    uri: 'test://fixture',
  });
  f.notify('notifications/resources/unknown', { uri: 'test://fixture' });
  f.receive({
    jsonrpc: '2.0',
    id: 'host-request',
    method: 'notifications/resources/updated',
    params: { uri: 'test://fixture' },
  });
  expect(f.sent.at(-1)).toMatchObject({ error: { code: -32601 } });
  expect(received).toHaveBeenCalledTimes(1);
  unsubscribe();
  f.notify('notifications/resources/updated', { uri: 'test://fixture' });
  expect(received).toHaveBeenCalledTimes(1);
  f.bridge.dispose();
});

it('drops hostile extension messages before notification observers', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  const handle = f.bridge.registerExtension(extensionDeclaration());
  const received = vi.fn();
  handle.subscribe(received);
  const data = {
    jsonrpc: '2.0',
    method: 'notifications/resources/updated',
    params: { uri: 'test://fixture' },
  };
  f.receive(data, {} as Window);
  f.receive(data, f.host, 'https://evil.example');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const params of [
    [],
    { uri: 'x'.repeat(131073) },
    cyclic,
    JSON.parse('{"__proto__":{}}'),
    {
      get uri() {
        throw new Error('Accessor must not run');
      },
    },
  ])
    f.receive({ ...data, params });
  expect(received).not.toHaveBeenCalled();
  f.receive(data);
  expect(received).toHaveBeenCalledTimes(1);
  handle.dispose();
  f.receive(data);
  expect(received).toHaveBeenCalledTimes(1);
  expect(handle.signal.aborted).toBe(true);
  f.bridge.dispose();
});

it('cancels extension pending work and refuses stale handles/responses after remount', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  const first = f.bridge.registerExtension(extensionDeclaration());
  const old = first.request('resources/read', { uri: 'test://old' });
  const oldRequest = f.sent.at(-1);
  first.dispose();
  await expect(old).rejects.toThrow(/cancelled|disposed/);
  await expect(first.request('resources/read', {})).rejects.toThrow('disposed');
  const second = f.bridge.registerExtension(extensionDeclaration());
  const next = second.request('resources/read', { uri: 'test://new' });
  const nextRequest = f.sent.at(-1);
  f.reply({ contents: ['stale'] }, oldRequest);
  f.reply({ contents: ['current'] }, nextRequest);
  await expect(next).resolves.toEqual({ contents: ['current'] });
  const pending = second.request('resources/read', {});
  f.receive({
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/resource-teardown',
    params: {},
  });
  await expect(pending).rejects.toThrow(/cancelled|disposed/);
  expect(second.signal.aborted).toBe(true);
});

it('rejects malformed extension params/results and preserves upstream failures', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  const handle = f.bridge.registerExtension(extensionDeclaration());
  for (const params of [
    { uri: 'x'.repeat(131073) },
    { fn: () => 1 },
    JSON.parse('{"constructor":{}}'),
    {
      get uri() {
        throw new Error('Accessor must not run');
      },
    },
  ])
    await expect(handle.request('resources/read', params)).rejects.toThrow();
  const badResult = handle.request('resources/read', {});
  f.reply([]);
  await expect(badResult).rejects.toThrow('object');
  const failure = handle.request('resources/read', {});
  f.receive({
    jsonrpc: '2.0',
    id: f.sent.at(-1)?.id,
    error: { code: -32000, message: 'Extension denied' },
  });
  await expect(failure).rejects.toThrow('Extension denied');
  f.bridge.dispose();
});

it('native text extensions preserve metadata but cannot bypass core capabilities/modalities', async () => {
  const declaration = {
    ...extensionDeclaration(),
    methods: ['ui/message', 'ui/update-model-context'],
    notifications: [],
  };
  const absent = fixture(extensionCapabilities);
  await absent.connect();
  const denied = absent.bridge.registerExtension(declaration);
  await expect(
    denied.request('ui/message', {
      role: 'user',
      content: [{ type: 'text', text: 'test' }],
    }),
  ).rejects.toThrow('unavailable');
  absent.bridge.dispose();
  const f = fixture({
    ...extensionCapabilities,
    message: { text: {} },
    updateModelContext: { text: {} },
  });
  await f.connect();
  const handle = f.bridge.registerExtension(declaration);
  const params = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: 'test',
        _meta: { 'example/title': 'Title' },
        annotations: { audience: ['assistant'] },
      },
    ],
    _meta: { 'example/message': { target: 'new' } },
  };
  const sent = handle.request('ui/message', params);
  expect(f.sent.at(-1)?.params).toEqual(params);
  f.reply({});
  await sent;
  await expect(
    handle.request('ui/message', { ...params, role: 'assistant' }),
  ).rejects.toThrow('shape');
  await expect(
    handle.request('ui/message', {
      role: 'user',
      content: [{ type: 'image', data: 'AAAA' }],
    }),
  ).rejects.toThrow('modality');
  await expect(
    handle.request('ui/update-model-context', { structuredContent: {} }),
  ).rejects.toThrow('structured');
  const rejected = handle.request('ui/update-model-context', {
    content: [{ type: 'text', text: 'test' }],
  });
  f.reply({ isError: true });
  await expect(rejected).rejects.toThrow('rejected');
  f.bridge.dispose();
});

it('does not deliver an in-flight notification to a replacement registration', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  const first = f.bridge.registerExtension(extensionDeclaration());
  const replacement = vi.fn();
  first.subscribe(() => {
    first.dispose();
    f.bridge.registerExtension(extensionDeclaration()).subscribe(replacement);
  });
  f.notify('notifications/resources/updated', { uri: 'test://first-lifetime' });
  expect(replacement).not.toHaveBeenCalled();
  f.notify('notifications/resources/updated', { uri: 'test://new-lifetime' });
  expect(replacement).toHaveBeenCalledTimes(1);
  f.bridge.dispose();
});

it('bounds extension declarations, registrations and listeners', async () => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  for (const change of [
    { capability: { path: [] } },
    { methods: Array.from({ length: 17 }, (_, n) => `example/method-${n}`) },
    { methods: ['resources/read', 'resources/read'] },
    { notifications: ['ui/notifications/tool-result'] },
    { methods: ['example/request'], notifications: ['example/request'] },
  ])
    expect(() =>
      f.bridge.registerExtension({ ...extensionDeclaration(), ...change }),
    ).toThrow();
  for (let n = 0; n < 16; n++)
    f.bridge.registerExtension({
      ...extensionDeclaration(),
      id: `example.owner-${n}`,
      methods: [`example/method-${n}`],
      notifications: [],
    });
  expect(() => f.bridge.registerExtension(extensionDeclaration())).toThrow(
    'limit',
  );
  f.bridge.dispose();
  const g = fixture(extensionCapabilities);
  await g.connect();
  const handle = g.bridge.registerExtension(extensionDeclaration());
  for (let n = 0; n < 32; n++) handle.subscribe(() => {});
  expect(() => handle.subscribe(() => {})).toThrow('limit');
  g.bridge.dispose();
});

it.each([
  'context',
  'notification',
])('rejects structured-cloned named array properties in %s', async (target) => {
  const f = fixture(extensionCapabilities);
  await f.connect();
  f.notify('ui/notifications/host-context-changed', {
    theme: 'dark',
    items: [1, 'safe'],
  });
  const previous = f.bridge.snapshot.rawHostContext;
  const listener = vi.fn();
  f.bridge.registerExtension(extensionDeclaration()).subscribe(listener);
  const bad = structuredClone(
    Object.assign([], { payload: 'x'.repeat(131073) }),
  );
  expect(Object.hasOwn(bad, 'payload')).toBe(true);
  if (target === 'context') {
    f.notify('ui/notifications/host-context-changed', {
      theme: 'light',
      items: bad,
    });
    expect(f.bridge.snapshot.rawHostContext).toEqual(previous);
  } else {
    f.notify('notifications/resources/updated', { items: bad });
    expect(listener).not.toHaveBeenCalled();
  }
  f.notify('notifications/resources/updated', {
    items: [1, 'safe', { nested: [true, null] }],
  });
  expect(listener).toHaveBeenCalledTimes(1);
  f.bridge.dispose();
});

it('validates own array data descriptors without invoking getters or iterators', () => {
  const getter = vi.fn(() => 'unsafe');
  const indexed = [0];
  Object.defineProperty(indexed, '0', { get: getter });
  expect(() => json(indexed)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const iterator = vi.fn(function* () {
    yield 'unsafe';
  });
  const custom = [1];
  Object.defineProperty(custom, Symbol.iterator, { value: iterator });
  expect(() => json(custom)).toThrow();
  expect(iterator).not.toHaveBeenCalled();
  expect(() => json(Object.assign([], { extra: 1 }))).toThrow();
  expect(() => json(new Array(2))).toThrow();
  expect(() => json([1, 'safe', { nested: [true, null] }])).not.toThrow();
});

it('returns cleanup even when the initial subscriber callback throws', async () => {
  const f = fixture();
  const observer = vi.fn(() => {
    throw new Error('component observer failed');
  });
  const unsubscribe = f.bridge.subscribe(observer);
  expect(unsubscribe).toBeTypeOf('function');
  unsubscribe();
  await f.connect();
  expect(observer).toHaveBeenCalledTimes(1);
  f.bridge.dispose();
});

it('memoizes connect before a finite observer reenters negotiation', async () => {
  const f = fixture();
  let reentered: Promise<void> | undefined;
  let once = false;
  f.bridge.subscribe((snapshot) => {
    if (snapshot.state === 'connecting' && !once) {
      once = true;
      reentered = f.bridge.connect();
    }
  });
  const connecting = f.bridge.connect();
  const requests = f.sent.filter(
    (message) => message.method === 'ui/initialize',
  );
  for (const request of requests) f.reply(f.initialized, request);
  await Promise.all([connecting, reentered]);
  expect(reentered).toBe(connecting);
  expect(requests).toHaveLength(1);
  f.bridge.dispose();
});

it('disposes from a connecting observer without late notifications or listeners', async () => {
  const f = fixture();
  f.bridge.subscribe((snapshot) => {
    if (snapshot.state === 'connecting') f.bridge.dispose();
  });
  const connecting = f.bridge.connect();
  await expect(connecting).rejects.toThrow(/cancelled|disposed/);
  for (const request of f.sent.filter(
    (message) => message.method === 'ui/initialize',
  ))
    f.reply(f.initialized, request);
  await Promise.resolve();
  expect(f.bridge.snapshot.state).toBe('disposed');
  expect(f.listeners.size).toBe(0);
  expect(
    f.sent.filter(
      (message) => message.method === 'ui/notifications/initialized',
    ),
  ).toHaveLength(0);
});
