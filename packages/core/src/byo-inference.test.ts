import { createServer, get, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getAI } from '@happyvertical/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverLocalInferenceModels,
  resolveInferencePreset,
} from './byo-inference';

vi.mock('node:http', async (importOriginal) => {
  const http = await importOriginal<typeof import('node:http')>();
  return { ...http, get: vi.fn(http.get) };
});

afterEach(() => {
  vi.mocked(get).mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('resolveInferencePreset', () => {
  it.each([
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['lemonade', 'http://127.0.0.1:13305/v1'],
    ['llama.cpp', 'http://127.0.0.1:9931/v1'],
    ['lm-studio', 'http://127.0.0.1:1234/v1'],
  ])('resolves %s to OpenAI SDK options', (id, baseUrl) => {
    expect(
      resolveInferencePreset(id, { model: ' chosen-model ', apiKey: ' test ' }),
    ).toEqual({
      type: 'openai',
      baseUrl,
      defaultModel: 'chosen-model',
      apiKey: 'test',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('requires an explicit model and OpenRouter key', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
    expect(resolveInferencePreset('openrouter', { model: 'model' })).toBeNull();
    expect(
      resolveInferencePreset('openrouter', { model: 'model', apiKey: ' ' }),
    ).toBeNull();
    expect(resolveInferencePreset('lemonade', { model: ' ' })).toBeNull();
    expect(
      resolveInferencePreset('constructor', { model: 'model' }),
    ).toBeNull();
    expect(resolveInferencePreset('unknown', { model: 'model' })).toBeNull();
  });

  it('uses an explicit synthetic credential for keyless local SDK options', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
    const options = resolveInferencePreset('lemonade', { model: 'model' });
    expect(options).not.toBeNull();
    if (!options) throw new Error('Expected local provider options');
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ choices: [{ message: { content: 'test response' } }] }),
    );
    vi.stubGlobal('fetch', fetch);
    const client = await getAI(options);
    await client.message('test prompt', { role: 'user' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:13305/v1/chat/completions');
    expect(new Headers(request?.headers).get('authorization')).toBe(
      'Bearer smrt-local',
    );
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: 'model' });
  });
});

async function withLocalServer(
  handler: RequestListener,
  test: () => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const http = await vi.importActual<typeof import('node:http')>('node:http');
  const { port } = server.address() as AddressInfo;
  vi.mocked(get).mockImplementation((url, options, callback) =>
    http.get(
      new URL((url as string).replace(/:\d+\//, `:${port}/`)),
      options as import('node:http').RequestOptions,
      callback,
    ),
  );
  try {
    await test();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('discoverLocalInferenceModels', () => {
  it('uses direct, unauthenticated loopback GETs and returns only local model IDs', async () => {
    vi.stubEnv('OLLAMA_HOST', 'https://example.invalid');
    vi.stubEnv('LEMONADE_API_KEY', 'synthetic-ambient-key');
    const requests: Array<[string | undefined, string | undefined]> = [];
    await withLocalServer(
      (req, res) => {
        requests.push([req.method, req.headers.authorization]);
        res.end(
          JSON.stringify(
            req.url === '/api/tags'
              ? {
                  models: [
                    { name: 'ollama-model' },
                    { name: 'ollama-model' },
                    {
                      name: 'local-empty-metadata',
                      remote_host: '',
                      remote_model: '',
                    },
                    {
                      name: 'remote-model-alias',
                      remote_model: 'upstream-model',
                    },
                    {
                      name: 'remote-host-alias',
                      remote_host: 'https://example.invalid',
                    },
                    {
                      name: 'malformed-remote',
                      remote_host: { invalid: true },
                    },
                    {},
                    null,
                  ],
                }
              : {
                  data: [
                    {
                      id: 'lemonade-model',
                      downloaded: true,
                      unknown: 'ignored',
                    },
                    { id: 'older-model' },
                    { id: 'not-installed', downloaded: false },
                    { id: 'offloaded-model', recipe: 'cloud' },
                    { id: 12 },
                  ],
                },
          ),
        );
      },
      async () => {
        expect(await discoverLocalInferenceModels()).toEqual([
          {
            service: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            available: true,
            models: ['ollama-model', 'local-empty-metadata'],
          },
          {
            service: 'lemonade',
            baseUrl: 'http://127.0.0.1:13305/v1',
            available: true,
            models: ['lemonade-model', 'older-model'],
          },
        ]);
        expect(
          vi
            .mocked(get)
            .mock.calls.map(([url, options]) => [
              url,
              (options as import('node:http').RequestOptions).agent,
            ]),
        ).toEqual([
          ['http://127.0.0.1:11434/api/tags', false],
          ['http://127.0.0.1:13305/v1/models', false],
        ]);
        expect(requests).toEqual([
          ['GET', undefined],
          ['GET', undefined],
        ]);
      },
    );
  });

  it.each([
    'redirect',
    '401',
    '503',
    'bad JSON',
    'bad shape',
    'socket closed',
    'stall',
    'oversized',
  ])('reports %s as unavailable while preserving the other result', async (failure) => {
    const paths: Array<string | undefined> = [];
    await withLocalServer(
      (req, res) => {
        paths.push(req.url);
        if (req.url === '/v1/models') {
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        switch (failure) {
          case 'redirect':
            res.writeHead(302, { location: '/redirected' }).end();
            return;
          case '401':
          case '503':
            res.writeHead(Number(failure)).end('private failure text');
            return;
          case 'socket closed':
            req.socket.destroy();
            return;
          case 'stall':
            res.write('{"models":[');
            return;
          case 'bad JSON':
            res.end('private failure text');
            return;
          case 'bad shape':
            res.end('{"models":"private failure text"}');
            return;
          case 'oversized':
            res.end(
              JSON.stringify({ models: [], padding: ' '.repeat(1024 * 1024) }),
            );
        }
      },
      async () => {
        expect(await discoverLocalInferenceModels()).toEqual([
          {
            service: 'ollama',
            baseUrl: 'http://127.0.0.1:11434',
            available: false,
          },
          {
            service: 'lemonade',
            baseUrl: 'http://127.0.0.1:13305/v1',
            available: true,
            models: [],
          },
        ]);
        expect(paths.sort()).toEqual(['/api/tags', '/v1/models']);
      },
    );
  });
});
