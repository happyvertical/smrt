import { randomUUID } from 'node:crypto';
import {
  MCP_APPS_PROTOCOL_VERSION,
  McpAppBridge,
} from '@happyvertical/smrt-mcp-apps';
import { describe, expect, it, vi } from 'vitest';
import {
  fileContent,
  fileRead,
  fileWriteResult,
  validateFileInput,
} from './file-contracts.js';
import { OpenAiFileSession, openOpenAiFile } from './files.js';
import { withOpenAiFileEntrypoint } from './files-server.js';

const input = {
  file: { name: 'synthetic.txt', resourceUri: 'host-resource://synthetic' },
};
function fixture(
  capabilities: Record<string, unknown> = {
    'openai/resource': {},
    'openai/files': {},
  },
) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const lifecycle = new AbortController();
  let listener:
    | ((method: string, params: Record<string, unknown>) => void)
    | undefined;
  let revoked = false;
  let content = 'synthetic';
  let revision = 1;
  let outcome: 'saved' | 'conflict' | 'too-large' | 'broken' = 'saved';
  let fail = false;
  let writable = true;
  let mime = 'text/plain';
  let etag = true;
  let foreign = false;
  let registered = false;
  const holds = new Map<string, Promise<void>>();
  const bridge = {
    signal: lifecycle.signal,
    snapshot: {
      state: 'ready',
      rawHostCapabilities: { experimental: capabilities },
    },
    subscribe: () => () => {},
    callTool: async (name: string, params: Record<string, unknown>) => {
      calls.push({ method: name, params });
      if (revoked) return { isError: true, content: [] };
      return {
        content: [{ type: 'text', text: 'Authorized synthetic workflow' }],
        structuredContent: { path: '/synthetic/file.txt' },
      };
    },
    registerExtension: () => {
      if (registered) throw new Error('Extension already registered');
      registered = true;
      return {
        signal: lifecycle.signal,
        request: async (method: string, params: Record<string, unknown>) => {
          calls.push({ method, params });
          const readContent = content;
          await holds.get(method);
          if (fail) throw new Error('Unknown upstream outcome');
          if (method === 'resources/read')
            return {
              contents: [
                {
                  uri: foreign
                    ? 'host-resource://foreign'
                    : input.file.resourceUri,
                  text: readContent,
                  mimeType: mime,
                  _meta: {
                    'openai/resource': {
                      writable,
                      ...(etag ? { etag: `v${revision}` } : {}),
                    },
                  },
                },
              ],
            };
          if (method === 'openai/resources/write') {
            if (outcome === 'too-large') return { outcome, maxBytes: 1 };
            if (outcome === 'broken') return { outcome: 'unknown' };
            if (params.ifMatch !== `v${revision}` || outcome === 'conflict')
              return { outcome: 'conflict', etag: `v${revision}` };
            content = String(params.text);
            revision++;
            return { outcome: 'saved', etag: `v${revision}` };
          }
          return {};
        },
        subscribe: (callback: typeof listener) => {
          listener = callback;
          return () => {
            listener = undefined;
          };
        },
        dispose: () => {
          registered = false;
          listener = undefined;
        },
      };
    },
  } as unknown as McpAppBridge;
  const session = () =>
    new OpenAiFileSession({
      bridge,
      input,
      authorityTool: 'file_authority',
      fallbackTool: 'file_workflow',
      maxBytes: 32,
      mimeTypes: ['text/plain'],
    });
  return {
    bridge,
    hold: (method: string) => {
      let release!: () => void;
      holds.set(
        method,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        holds.delete(method);
        release();
      };
    },
    calls,
    session,
    revoke: () => {
      revoked = true;
    },
    setContent: (value: string) => {
      content = value;
    },
    conflict: () => {
      revision++;
    },
    outcome: (value: typeof outcome) => {
      outcome = value;
    },
    fail: () => {
      fail = true;
    },
    readOnly: () => {
      writable = false;
    },
    noEtag: () => {
      etag = false;
    },
    badMime: () => {
      mime = 'application/executable';
    },
    foreign: () => {
      foreign = true;
    },
    notify: (uri = input.file.resourceUri) =>
      listener?.('notifications/resources/updated', {
        uri,
      }),
  };
}
describe('file contract boundaries', () => {
  it('validates opaque file references without mapping any URI to disk', () => {
    expect(validateFileInput(input)).toEqual(input);
    for (const resourceUri of [
      '/etc/passwd',
      'file:///etc/passwd',
      'https://example.test/a',
      'data:text/plain,hello',
      'host-resource://bad path',
    ])
      expect(() =>
        validateFileInput({ file: { ...input.file, resourceUri } }),
      ).toThrow();
    for (const name of [
      '../file.txt',
      'dir/file.txt',
      'dir\\file.txt',
      '..',
      '\0bad',
    ])
      expect(() =>
        validateFileInput({ file: { ...input.file, name } }),
      ).toThrow();
    expect(() => validateFileInput({ ...input, tenantId: 'forged' })).toThrow();
  });
  it('bounds decoded bytes and rejects malformed representations and result unions', () => {
    expect(fileContent({ text: 'é' }, 2)).toEqual({ text: 'é' });
    expect(() => fileContent({ text: 'é' }, 1)).toThrow();
    expect(fileContent({ blob: 'YQ==' }, 1)).toEqual({ blob: 'YQ==' });
    for (const value of [
      { blob: 'bad!' },
      { text: '', blob: '' },
      {},
      { text: 'ab' },
    ])
      expect(() => fileContent(value, 1)).toThrow();
    expect(() => fileWriteResult({ outcome: 'unknown' })).toThrow();
    expect(() =>
      fileWriteResult({ outcome: 'too-large', maxBytes: -1 }),
    ).toThrow();
    expect(() =>
      fileRead({ contents: [] }, input.file.resourceUri, 32, ['text/plain']),
    ).toThrow();
  });
  it('annotates only existing read workflows and retains domain authority', async () => {
    const definition = withOpenAiFileEntrypoint(
      {
        name: 'file_view',
        description: 'Synthetic',
        effect: 'read',
        idempotent: true,
        openWorld: false,
        ui: { resourceUri: 'ui://synthetic/file' },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        execute: ({ principal }) => {
          if (principal?.id !== 'owner') throw new Error('Domain denied');
          return { content: [] };
        },
      },
      ['.txt'],
    );
    expect(definition.metadata?.['openai/ui']).toEqual({
      entrypoints: [{ type: 'file', extensions: ['.txt'] }],
    });
    expect(() =>
      definition.execute({ arguments: input, principal: null } as never),
    ).toThrow('Domain');
    expect(() =>
      definition.execute({
        arguments: { file: { ...input.file, name: 'bad.exe' } },
        principal: { id: 'owner' },
      } as never),
    ).toThrow('extension');
  });
});
describe('scoped host file sessions', () => {
  it('authorizes each read/write, uses ETag and never retries completed or unknown writes', async () => {
    const f = fixture();
    const session = f.session();
    await expect(session.write({ text: 'new' })).rejects.toThrow('ETag');
    await session.read('text');
    expect(await session.write({ text: 'new' })).toEqual({
      outcome: 'saved',
      etag: 'v2',
    });
    await expect(session.write({ text: 'new' })).rejects.toThrow('ETag');
    await session.read();
    f.fail();
    await expect(session.write({ text: 'unknown' })).rejects.toThrow('Unknown');
    await expect(session.write({ text: 'unknown' })).rejects.toThrow('ETag');
    expect(
      f.calls.filter((call) => call.method === 'openai/resources/write'),
    ).toHaveLength(2);
    expect(
      f.calls.find((call) => call.method === 'openai/resources/write')?.params
        .ifMatch,
    ).toBe('v1');
    session.dispose();
  });
  it('covers stale/conflict and oversize results without repeating mutation', async () => {
    for (const outcome of ['conflict', 'too-large', 'broken'] as const) {
      const f = fixture();
      const session = f.session();
      await session.read();
      f.outcome(outcome);
      if (outcome === 'broken')
        await expect(session.write({ text: 'new' })).rejects.toThrow();
      else
        expect(await session.write({ text: 'new' })).toHaveProperty(
          'outcome',
          outcome,
        );
      expect(
        f.calls.filter((call) => call.method === 'openai/resources/write'),
      ).toHaveLength(1);
      await expect(session.write({ text: 'new' })).rejects.toThrow('ETag');
      session.dispose();
    }
  });
  it('denies revocation, MIME/URI mismatch, oversize and missing write grants', async () => {
    for (const change of ['revoke', 'badMime', 'foreign'] as const) {
      const f = fixture();
      const session = f.session();
      f[change]();
      await expect(session.read()).rejects.toThrow();
      session.dispose();
    }
    const big = fixture();
    big.setContent('x'.repeat(33));
    await expect(big.session().read()).rejects.toThrow('byte');
    for (const change of ['readOnly', 'noEtag'] as const) {
      const f = fixture();
      const session = f.session();
      f[change]();
      await session.read();
      await expect(session.write({ text: 'new' })).rejects.toThrow('ETag');
      session.dispose();
    }
    const f = fixture();
    const session = f.session();
    await session.read();
    f.revoke();
    await expect(session.write({ text: 'new' })).rejects.toThrow('authority');
    expect(
      f.calls.some((call) => call.method === 'openai/resources/write'),
    ).toBe(false);
  });
  it('rejects concurrent writes and cleans subscriptions on revoke/disposal', async () => {
    const f = fixture();
    const session = f.session();
    await session.read();
    const first = session.write({ text: 'new' });
    await expect(session.write({ text: 'race' })).rejects.toThrow('pending');
    await first;
    const reads: unknown[] = [];
    const errors: unknown[] = [];
    await session.subscribe(
      (file) => reads.push(file),
      (error) => errors.push(error),
    );
    await expect(
      session.subscribe(
        () => {},
        () => {},
      ),
    ).rejects.toThrow('Already');
    f.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toHaveLength(1);
    f.revoke();
    f.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(session.signal.aborted).toBe(true);
    f.notify();
    expect(reads).toHaveLength(1);
    await expect(session.read()).rejects.toThrow('disposed');
  });
  it('coalesces updates across a pending save and retains fresh authority and ETag', async () => {
    const f = fixture();
    const session = f.session();
    const reads: unknown[] = [];
    const errors: unknown[] = [];
    await session.read();
    await session.subscribe(
      (value) => reads.push(value),
      (error) => errors.push(error),
    );
    const releaseWrite = f.hold('openai/resources/write');
    const releaseRead = f.hold('resources/read');
    const write = session.write({ text: 'saved' });
    f.notify();
    f.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseWrite();
    await write;
    releaseRead();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toEqual([]);
    expect(session.signal.aborted).toBe(false);
    expect(reads).toHaveLength(1);
    await session.write({ text: 'again' });
    expect(
      f.calls.filter((call) => call.method === 'openai/resources/write').at(-1)
        ?.params.ifMatch,
    ).toBe('v2');
    f.revoke();
    f.notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(session.signal.aborted).toBe(true);
  });
  it('releases registration immediately while host unsubscribe remains pending', async () => {
    const f = fixture();
    const session = f.session();
    await session.subscribe(
      () => {},
      () => {},
    );
    const release = f.hold('resources/unsubscribe');
    session.dispose();
    const replacement = f.session();
    expect(session.signal.aborted).toBe(true);
    await replacement.read();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await replacement.read();
    replacement.dispose();
  });
  it('uses the ordinary authorized workflow when capability is absent or malformed', async () => {
    for (const caps of [
      {},
      { 'openai/resource': true },
      { 'unknown/resource': {} },
    ]) {
      const f = fixture(caps);
      const session = f.session();
      expect(session.native).toBe(false);
      expect(await session.read()).toHaveProperty('content');
      expect(f.calls.map((call) => call.method)).toEqual([
        'file_authority',
        'file_workflow',
      ]);
      session.dispose();
    }
  });
  it('opens only user-confirmed exact allowlisted provider paths, with ordinary fallback', async () => {
    const f = fixture();
    const options = {
      bridge: f.bridge,
      resolveTool: 'file_open',
      arguments: { id: 'owned' },
      allowedPaths: ['/synthetic/file.txt'],
      confirm: async () => true,
    };
    await openOpenAiFile({ ...options, confirm: async () => false });
    expect(f.calls).toHaveLength(0);
    await expect(
      openOpenAiFile({ ...options, allowedPaths: ['/other/file.txt'] }),
    ).rejects.toThrow('path');
    await openOpenAiFile(options);
    expect(f.calls.at(-1)?.method).toBe('openai/files/open');
    const fallback = fixture({});
    expect(
      await openOpenAiFile({ ...options, bridge: fallback.bridge }),
    ).toHaveProperty('content');
  });
});

describe('round 4 file boundary regressions', () => {
  it('rejects Windows drive paths and preserves valid opaque URI bytes', () => {
    for (const resourceUri of [
      'C:/Users/alice/file.txt',
      'z:/file.txt',
      'C:relative.txt',
      'C:\\Users\\alice\\file.txt',
    ]) {
      expect(() =>
        validateFileInput({ file: { ...input.file, resourceUri } }),
      ).toThrow('opaque');
    }
    const resourceUri = 'host-resource://opaque/%2F/%25?token=A%2Bb';
    expect(
      validateFileInput({ file: { ...input.file, resourceUri } }).file
        .resourceUri,
    ).toBe(resourceUri);
  });
  for (const invalid of ['cancelled', 'mismatched'] as const) {
    it(`releases actual bridge listener after synchronous ${invalid} snapshot`, async () => {
      const listeners = new Set<(event: MessageEvent) => void>();
      const sent: Record<string, unknown>[] = [];
      const host = {
        postMessage: (message: Record<string, unknown>) => sent.push(message),
      } as unknown as Window;
      const local = {
        crypto: { randomUUID },
        addEventListener: (
          _: string,
          listener: (event: MessageEvent) => void,
        ) => listeners.add(listener),
        removeEventListener: (
          _: string,
          listener: (event: MessageEvent) => void,
        ) => listeners.delete(listener),
      } as unknown as Window;
      const bridge = new McpAppBridge({
        hostWindow: host,
        hostOrigin: 'https://host.example',
        window: local,
        appInfo: { name: 'files-regression', version: '1' },
      });
      const receive = (data: unknown) => {
        for (const listener of listeners)
          listener({
            data,
            source: host,
            origin: 'https://host.example',
          } as MessageEvent);
      };
      const connecting = bridge.connect();
      receive({
        jsonrpc: '2.0',
        id: sent.at(-1)?.id,
        result: {
          protocolVersion: MCP_APPS_PROTOCOL_VERSION,
          hostInfo: { name: 'synthetic', version: '1' },
          hostCapabilities: { experimental: { 'openai/resource': {} } },
          hostContext: {},
        },
      });
      await connecting;
      receive({
        jsonrpc: '2.0',
        method:
          invalid === 'cancelled'
            ? 'ui/notifications/tool-cancelled'
            : 'ui/notifications/tool-input',
        params:
          invalid === 'cancelled'
            ? {}
            : {
                arguments: {
                  file: { ...input.file, resourceUri: 'host-resource://other' },
                },
              },
      });
      const callbacks: ReturnType<typeof vi.fn>[] = [];
      const subscribe = bridge.subscribe.bind(bridge);
      vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => {
        const observed = vi.fn(listener);
        callbacks.push(observed);
        return subscribe(observed);
      });
      const session = new OpenAiFileSession({
        bridge,
        input,
        authorityTool: 'file_authority',
        fallbackTool: 'file_workflow',
        maxBytes: 32,
        mimeTypes: ['text/plain'],
      });
      expect(session.signal.aborted).toBe(true);
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      receive({
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: 'dark' },
      });
      expect(callbacks[0]).toHaveBeenCalledTimes(1);
      bridge.dispose();
      expect(listeners.size).toBe(0);
    });
  }
  it('supersedes a delayed read on matching updates and publishes only the retry', async () => {
    const f = fixture();
    const session = f.session();
    const reads: unknown[] = [];
    const errors: unknown[] = [];
    await session.subscribe(
      (file) => reads.push(file.content),
      (error) => errors.push(error),
    );
    const release = f.hold('resources/read');
    f.notify();
    await vi.waitFor(() =>
      expect(f.calls.filter((c) => c.method === 'resources/read')).toHaveLength(
        1,
      ),
    );
    f.setContent('newest');
    f.notify();
    f.notify();
    release();
    await vi.waitFor(() => expect(reads).toEqual([{ text: 'newest' }]));
    expect(f.calls.filter((c) => c.method === 'resources/read')).toHaveLength(
      2,
    );
    expect(errors).toEqual([]);
    expect(session.signal.aborted).toBe(false);
    session.dispose();
  });
  it('does not supersede a delayed read for another URI', async () => {
    const f = fixture();
    const session = f.session();
    const reads: unknown[] = [];
    await session.subscribe(
      (file) => reads.push(file.content),
      () => {},
    );
    const release = f.hold('resources/read');
    f.notify();
    await vi.waitFor(() =>
      expect(f.calls.filter((c) => c.method === 'resources/read')).toHaveLength(
        1,
      ),
    );
    f.notify('host-resource://other');
    release();
    await vi.waitFor(() => expect(reads).toEqual([{ text: 'synthetic' }]));
    expect(f.calls.filter((c) => c.method === 'resources/read')).toHaveLength(
      1,
    );
    session.dispose();
  });
});
