import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILE,
  configFromProp,
  DEFAULT_INFERENCE,
  loadInferenceConfig,
  parseInferenceConfig,
} from '../src/lib/inference/config.ts';
import {
  BUILT_IN_PRESETS,
  resolvePresets,
} from '../src/lib/inference/presets.ts';
import { startStub } from './stub-server.ts';

const file = (inference: unknown) => JSON.stringify({ inference });

describe('planner.config.json', () => {
  it('accepts the three modes', () => {
    expect(parseInferenceConfig(file({ mode: 'browser' })).config).toEqual({
      mode: 'browser',
    });
    expect(
      parseInferenceConfig(
        file({ mode: 'host', host: { endpoint: '/api/planner/chat' } }),
      ),
    ).toEqual({
      config: { mode: 'host', host: { endpoint: '/api/planner/chat' } },
    });
    expect(
      parseInferenceConfig(
        file({
          mode: 'host',
          host: { endpoint: 'https://kitchen.example/chat' },
        }),
      ).config.host?.endpoint,
    ).toBe('https://kitchen.example/chat');
    expect(parseInferenceConfig(file({ mode: 'byo' })).notice).toBeUndefined();
  });

  it('defaults to browser with no notice when nothing is said', () => {
    expect(parseInferenceConfig('{}')).toEqual({ config: DEFAULT_INFERENCE });
    expect(parseInferenceConfig(file({}))).toEqual({
      config: DEFAULT_INFERENCE,
    });
  });

  it.each([
    ['not json', 'nope {'],
    ['an array', '[]'],
    ['unknown mode', file({ mode: 'cloud' })],
    ['host without endpoint', file({ mode: 'host' })],
    [
      'host with a javascript: url',
      file({ mode: 'host', host: { endpoint: 'javascript:alert(1)' } }),
    ],
    [
      'host with a protocol-relative url',
      file({ mode: 'host', host: { endpoint: '//evil.example/x' } }),
    ],
    ['empty presets', file({ mode: 'byo', byo: { presets: [] } })],
    [
      'malformed preset',
      file({ mode: 'byo', byo: { presets: [{ id: 'x' }] } }),
    ],
    ['inference not an object', file('browser')],
  ])('falls back to browser with a visible notice: %s', (_name, text) => {
    const result = parseInferenceConfig(text);
    expect(result.config).toEqual({ mode: 'browser' });
    expect(result.notice).toMatch(/runs in your browser instead/);
  });

  it('takes presets by id or by definition', () => {
    const { config } = parseInferenceConfig(
      file({
        mode: 'byo',
        byo: {
          presets: [
            'ollama',
            {
              id: 'lab',
              label: 'Lab server',
              baseUrl: 'https://llm.lab.example/v1',
              model: 'qwen',
              keyless: true,
            },
          ],
        },
      }),
    );
    const presets = resolvePresets(config.byo?.presets);
    expect(presets.map((p) => p.id)).toEqual(['ollama', 'lab']);
    expect(resolvePresets().map((p) => p.id)).toEqual(
      BUILT_IN_PRESETS.map((p) => p.id),
    );
    expect(resolvePresets(['nonsense'])).toHaveLength(BUILT_IN_PRESETS.length);
  });

  it('lets a mounted Planner prop use the same shape, validated the same way', () => {
    expect(
      configFromProp({ mode: 'host', host: { endpoint: '/x' } }).config.mode,
    ).toBe('host');
    const bad = configFromProp({ mode: 'host' });
    expect(bad.config.mode).toBe('browser');
    expect(bad.notice).toBeTruthy();
  });
});

describe('loading the file', () => {
  it('reads planner.config.json under the base path', async () => {
    const stub = await startStub(({ url }) =>
      url === `/planner/${CONFIG_FILE}`
        ? {
            body: { inference: { mode: 'host', host: { endpoint: '/chat' } } },
          }
        : { status: 404, body: {} },
    );
    try {
      const result = await loadInferenceConfig(`${stub.origin}/planner/`);
      expect(result.config.mode).toBe('host');
      expect(stub.requests[0]?.url).toBe(`/planner/${CONFIG_FILE}`);
    } finally {
      await stub.close();
    }
  });

  it('uses the defaults, silently, when the file is missing or unreachable', async () => {
    const stub = await startStub(() => ({ status: 404, body: {} }));
    try {
      expect(await loadInferenceConfig(stub.origin)).toEqual({
        config: DEFAULT_INFERENCE,
      });
    } finally {
      await stub.close();
    }
    expect(
      await loadInferenceConfig('', (async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch),
    ).toEqual({ config: DEFAULT_INFERENCE });
  });

  it('treats a SPA fallback page as a missing file', async () => {
    const stub = await startStub(() => ({
      raw: true,
      body: '<!doctype html><title>app</title>',
    }));
    try {
      expect((await loadInferenceConfig(stub.origin)).notice).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('warns when the file is there but broken', async () => {
    const stub = await startStub(() => ({ raw: true, body: '{ broken' }));
    try {
      const result = await loadInferenceConfig(stub.origin);
      expect(result.config.mode).toBe('browser');
      expect(result.notice).toMatch(/valid JSON/);
    } finally {
      await stub.close();
    }
    const failing = await startStub(() => ({ status: 500, body: {} }));
    try {
      expect((await loadInferenceConfig(failing.origin)).notice).toMatch(/500/);
    } finally {
      await failing.close();
    }
  });
});
