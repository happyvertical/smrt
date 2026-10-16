import { beforeEach, describe, expect, it } from 'vitest';
import { AiState } from '../src/lib/ai/state.svelte.ts';
import { serializeCookbook } from '../src/lib/cookbook/file.ts';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import {
  BYO_KEYS_KEY,
  BYO_PREFS_KEY,
  ByoModel,
  savedByoChat,
} from '../src/lib/inference/byo.svelte.ts';
import {
  createOpenAIChat,
  normalizeBaseUrl,
  testConnection,
} from '../src/lib/inference/openai.ts';
import { plannerController } from '../src/lib/planner/instance.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { completion, startStub } from './stub-server.ts';

const KEY = 'sk-test-SECRET-1234567890';

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  } as unknown as Storage & { data: Map<string, string> };
}

beforeEach(() => recipeState.clear());

describe('OpenAI-compatible client', () => {
  it('sends the key only as the Authorization header, to the configured origin', async () => {
    const stub = await startStub(() => ({
      body: completion(JSON.stringify({ reply: 'hi', add: [], remove: [] })),
    }));
    const other = await startStub(() => ({ body: {} }));
    try {
      const chat = createOpenAIChat({
        baseUrl: `${stub.origin}/v1/`,
        model: 'gpt-test',
        apiKey: KEY,
      });
      const text = await chat.message('hello', {
        history: [{ role: 'system', content: 'be brief' }],
        responseSchema: { type: 'object', properties: {} },
        maxTokens: 50,
      });
      expect(JSON.parse(text)).toMatchObject({ reply: 'hi' });
      const request = stub.requests[0];
      expect(request?.url).toBe('/v1/chat/completions');
      expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
      // Nowhere else: not the URL, not the body, no other header.
      expect(request?.url).not.toContain(KEY);
      expect(request?.body).not.toContain(KEY);
      for (const [name, value] of Object.entries(request?.headers ?? {})) {
        if (name !== 'authorization') expect(String(value)).not.toContain(KEY);
      }
      const sent = JSON.parse(request?.body ?? '{}');
      expect(sent.model).toBe('gpt-test');
      expect(sent.messages).toEqual([
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ]);
      expect(sent.response_format.type).toBe('json_schema');
      expect(sent.max_tokens).toBe(50);
      // A different origin got nothing.
      expect(other.requests).toHaveLength(0);
    } finally {
      await stub.close();
      await other.close();
    }
  });

  it('sends no Authorization header without a key (Ollama)', async () => {
    const stub = await startStub(() => ({ body: completion('{}') }));
    try {
      await createOpenAIChat({
        baseUrl: `${stub.origin}/v1`,
        model: 'm',
      }).message('x');
      expect(stub.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  it('steps down from json_schema to json_object to plain when refused, and remembers', async () => {
    const stub = await startStub(({ body }) => {
      const format = JSON.parse(body).response_format;
      return format
        ? { status: 400, body: { error: 'response_format unsupported' } }
        : { body: completion('{"reply":"plain"}') };
    });
    try {
      const seen: string[] = [];
      const chat = createOpenAIChat({
        baseUrl: `${stub.origin}/v1`,
        model: 'm',
        onJsonMode: (mode) => seen.push(mode),
      });
      await chat.message('a', { responseSchema: { type: 'object' } });
      const formats = stub.requests.map(
        (r) => JSON.parse(r.body).response_format?.type ?? 'none',
      );
      expect(formats).toEqual(['json_schema', 'json_object', 'none']);
      expect(seen).toEqual(['none']);
      await chat.message('b', { responseSchema: { type: 'object' } });
      expect(stub.requests).toHaveLength(4);
    } finally {
      await stub.close();
    }
  });

  it('rejects non-http addresses and credentials in the address', () => {
    expect(normalizeBaseUrl('ftp://x/v1')).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
    expect(normalizeBaseUrl('https://user:pw@x.example/v1')).toBeNull();
    expect(normalizeBaseUrl('https://x.example/v1?api_key=secret')).toBeNull();
    expect(normalizeBaseUrl('https://x.example/v1?TOKEN=secret')).toBeNull();
    expect(normalizeBaseUrl('https://x.example/v1?region=ca#ignored')).toBe(
      'https://x.example/v1',
    );
    expect(normalizeBaseUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1',
    );
    expect(() =>
      createOpenAIChat({ baseUrl: 'javascript:1', model: 'm' }),
    ).toThrow();
  });

  it('never puts the key in an error message', async () => {
    const stub = await startStub(() => ({ status: 401, body: { error: KEY } }));
    try {
      const result = await testConnection({
        baseUrl: `${stub.origin}/v1`,
        model: 'm',
        apiKey: KEY,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/refused the key/);
      expect(result.message).not.toContain(KEY);
    } finally {
      await stub.close();
    }
    // Unreachable: a CORS-style hint, still no key.
    const down = await testConnection({
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'm',
      apiKey: KEY,
    });
    expect(down.ok).toBe(false);
    expect(down.message).toMatch(/CORS/);
    expect(down.message).not.toContain(KEY);
  });

  it('Test connection reports a good endpoint and a missing model', async () => {
    const stub = await startStub(({ body }) =>
      JSON.parse(body).model === 'real'
        ? { body: completion('OK') }
        : { status: 404, body: {} },
    );
    try {
      const good = await testConnection({
        baseUrl: `${stub.origin}/v1`,
        model: 'real',
      });
      expect(good).toEqual({ ok: true, message: 'Connected to real.' });
      const bad = await testConnection({
        baseUrl: `${stub.origin}/v1`,
        model: 'nope',
      });
      expect(bad.ok).toBe(false);
      expect(bad.message).toMatch(/not found/);
    } finally {
      await stub.close();
    }
  });
});

describe('ByoModel (the AI page state)', () => {
  it('keeps the key in its own storage entry and out of the prefs', async () => {
    const store = storage();
    const stub = await startStub(() => ({ body: completion('OK') }));
    try {
      const byo = new ByoModel({ storage: store });
      expect(byo.presets.map((p) => p.id)).toEqual([
        'ollama',
        'openrouter',
        'openai',
        'custom',
      ]);
      byo.select('custom');
      byo.setBaseUrl(`${stub.origin}/v1`);
      byo.setModel('m1');
      expect(byo.complete).toBe(false); // custom needs a key
      byo.setKey(KEY);
      expect(byo.complete).toBe(true);
      expect((await byo.test()).ok).toBe(true);
      expect(byo.use()).toBe(true);

      expect(store.data.get(BYO_PREFS_KEY)).not.toContain(KEY);
      expect(store.data.get(BYO_KEYS_KEY)).toContain(KEY);
      for (const key of store.data.keys())
        expect(key.startsWith('smrt-planner:')).toBe(true);

      // A fresh session restores it and sends the key only to that origin.
      const again = new ByoModel({ storage: store });
      expect(again.active).toBe(true);
      expect(again.presetId).toBe('custom');
      await savedByoChat(store)?.message('hi');
      const last = stub.requests.at(-1);
      expect(last?.headers.authorization).toBe(`Bearer ${KEY}`);

      again.forgetKey();
      expect(again.active).toBe(false);
      expect(store.data.get(BYO_KEYS_KEY)).not.toContain(KEY);
    } finally {
      await stub.close();
    }
  });

  it('needs no key for Ollama and defaults to its local address', () => {
    const byo = new ByoModel({ storage: storage() });
    byo.select('ollama');
    expect(byo.baseUrl).toBe('http://localhost:11434/v1');
    expect(byo.complete).toBe(true);
    expect(byo.preset?.cors).toMatch(/OLLAMA_ORIGINS/);
  });

  it('keeps hosted credentials in tab memory while persisting endpoint/model preferences', () => {
    const store = storage();
    store.data.set(
      BYO_KEYS_KEY,
      JSON.stringify({ custom: { origin: 'https://old.example', key: KEY } }),
    );
    const byo = new ByoModel({
      storage: store,
      credentialPersistence: 'memory',
    });
    byo.select('custom');
    byo.setBaseUrl('https://models.example/v1');
    byo.setModel('private-model');
    byo.setKey(KEY);
    expect(byo.key).toBe(KEY);
    expect(store.data.get(BYO_PREFS_KEY)).toContain('private-model');
    expect(store.data.has(BYO_KEYS_KEY)).toBe(false);
    expect(JSON.stringify(plannerController.snapshot())).not.toContain(KEY);
    expect(serializeCookbook(cookbookStore.snapshot())).not.toContain(KEY);

    const reload = new ByoModel({
      storage: store,
      credentialPersistence: 'memory',
    });
    expect(reload.baseUrl).toBe('https://models.example/v1');
    expect(reload.model).toBe('private-model');
    expect(reload.key).toBe('');
    expect(reload.active).toBe(false);
  });

  it('never persists credentials embedded in entered or legacy endpoint URLs', () => {
    const store = storage();
    const byo = new ByoModel({
      storage: store,
      credentialPersistence: 'memory',
    });
    byo.select('custom');
    byo.setBaseUrl('https://user:password@models.example/v1');
    expect(store.data.get(BYO_PREFS_KEY)).not.toContain('user');
    expect(store.data.get(BYO_PREFS_KEY)).not.toContain('password');
    byo.setBaseUrl('https://models.example/v1?api_key=query-secret');
    expect(store.data.get(BYO_PREFS_KEY)).not.toContain('query-secret');

    store.data.set(
      BYO_PREFS_KEY,
      JSON.stringify({
        preset: 'custom',
        active: true,
        entries: {
          custom: {
            baseUrl: 'https://models.example/v1?token=legacy-secret',
            model: 'private-model',
          },
        },
      }),
    );
    const legacy = new ByoModel({
      storage: store,
      credentialPersistence: 'memory',
    });
    expect(legacy.baseUrl).toBe('');
    expect(legacy.active).toBe(false);
    expect(store.data.get(BYO_PREFS_KEY)).not.toContain('legacy-secret');
  });

  it('fails the test with a message, not an exception, when incomplete', async () => {
    const byo = new ByoModel({ storage: storage() });
    byo.select('openai');
    const result = await byo.test();
    expect(result).toEqual({ ok: false, message: 'Enter a key first.' });
    expect(byo.testStatus).toBe('failed');
  });
});

describe('AiState in byo mode', () => {
  it('switches only when selected and never falls back or downloads after provider failure', async () => {
    let downloads = 0;
    const state = new AiState({
      storage: storage(),
      session: {
        store: recipeState,
        recipes,
        webgpu: () => true,
        host: {
          createWorker: () =>
            ({ terminate: () => undefined }) as unknown as Worker,
          createEngine: async () => {
            downloads += 1;
            throw new Error('must not load');
          },
        },
      },
      voice: { createModel: () => ({}) as never },
      synth: null,
      mic: false,
    });
    state.configure({
      config: {
        mode: 'byo',
        alternatives: ['browser'],
        credentialPersistence: 'memory',
        byo: { presets: ['openai'] },
      },
    });
    expect(state.availableModes).toEqual(['byo', 'browser', 'manual']);
    expect(state.inference.mode).toBe('byo');
    expect((await state.byo?.test())?.ok).toBe(false);
    expect(state.inference.mode).toBe('byo');
    expect(downloads).toBe(0);

    state.selectInference('browser');
    expect(state.inference.mode).toBe('browser');
    expect(state.session.status).toBe('idle');
    expect(downloads).toBe(0);
    state.selectInference('manual');
    expect(state.inference.mode).toBe('manual');
    expect(downloads).toBe(0);
  });

  it('works without WebGPU and says "Your model" in Think', async () => {
    const stub = await startStub(() => ({
      body: completion(
        JSON.stringify({
          reply: 'Added sales.',
          add: ['commerce.sales'],
          remove: [],
        }),
      ),
    }));
    try {
      const store = storage();
      const state = new AiState({
        storage: store,
        session: { store: recipeState, recipes, webgpu: () => false },
        voice: { createModel: () => ({}) as never },
        synth: null,
        mic: false,
      });
      state.hydrate(true);
      state.configure({
        config: { mode: 'byo', byo: { presets: ['ollama'] } },
      });
      // Not connected yet.
      let think = state.capabilities.find((c) => c.id === 'think');
      expect(think?.state).toBe('available');
      expect(think?.where).toBe('Your model');

      const byo = state.byo;
      expect(byo).not.toBeNull();
      byo?.select('ollama');
      byo?.setBaseUrl(`${stub.origin}/v1`);
      byo?.setModel('llama3.2');
      byo?.use();

      expect(state.session.status).toBe('ready');
      think = state.capabilities.find((c) => c.id === 'think');
      expect(think).toMatchObject({
        state: 'ready',
        label: 'Think: Your model: llama3.2',
        where: 'Your model: llama3.2',
      });
      const result = await state.session.transport.sendMessage({
        threadId: 'planner',
        content: 'I sell things',
        clientRequestId: 'q1',
      } as never);
      expect(result.assistantMessage?.content).toMatch(/Added sales/);
      expect(recipeState.ids).toContain('commerce.sales');
      // The user's text and the planner prompt went to the stub, which is the only server.
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.body).toContain('I sell things');

      byo?.stop();
      expect(state.session.status).toBe('idle');
    } finally {
      await stub.close();
    }
  });

  it('host mode is ready at once and labelled Server; browser says In browser', () => {
    const make = () =>
      new AiState({
        storage: storage(),
        session: { store: recipeState, recipes, webgpu: () => true },
        voice: { createModel: () => ({}) as never },
        synth: null,
        mic: false,
      });
    const host = make();
    host.hydrate(true);
    host.configure({
      config: { mode: 'host', host: { endpoint: '/api/planner/chat' } },
    });
    expect(host.session.status).toBe('ready');
    expect(host.capabilities[0]).toMatchObject({
      state: 'ready',
      label: 'Think: Server',
      where: 'Server',
    });
    expect(host.privacyNote).toMatch(/server/);

    const local = make();
    local.hydrate(true);
    local.configure({
      config: { mode: 'browser' },
      notice:
        'The assistant settings could not be used (x), so inference is off. The planner still works manually.',
    });
    expect(local.capabilities[0]?.where).toBe('In browser');
    expect(local.notice).toMatch(/inference is off/);
  });

  it('does not decide the first-run form until the config has arrived', () => {
    const state = new AiState({
      storage: storage(),
      session: { store: recipeState, recipes, webgpu: () => true },
      voice: { createModel: () => ({}) as never },
      synth: null,
      mic: false,
    });
    state.awaitConfig();
    state.hydrate(false);
    expect(state.firstRun).toBe(false);
    state.configure({ config: { mode: 'byo' } });
    expect(state.firstRun).toBe(true);

    const hosted = new AiState({
      storage: storage(),
      session: { store: recipeState, recipes, webgpu: () => true },
      voice: { createModel: () => ({}) as never },
      synth: null,
      mic: false,
    });
    hosted.awaitConfig();
    hosted.hydrate(false);
    hosted.configure({ config: { mode: 'host', host: { endpoint: '/c' } } });
    expect(hosted.firstRun).toBe(false);
  });
});

describe('a key stays with the address it was entered for', () => {
  const entered = (store: ReturnType<typeof storage>, baseUrl: string) => {
    const byo = new ByoModel({ storage: store });
    byo.select('custom');
    byo.setBaseUrl(baseUrl);
    byo.setModel('m1');
    byo.setKey(KEY);
    byo.use();
    return byo;
  };

  it('is not used once the address changes, and is used again when it is restored', () => {
    const store = storage();
    const byo = entered(store, 'https://models.example/v1');
    expect(byo.complete).toBe(true);
    byo.setBaseUrl('https://elsewhere.example/v1');
    expect(byo.key).toBe('');
    expect(byo.keyForOtherAddress).toBe(true);
    expect(byo.complete).toBe(false);
    expect(byo.active).toBe(false);
    expect(byo.chat()).toBeNull();
    byo.setBaseUrl('https://models.example/v2');
    expect(byo.complete).toBe(true); // same origin, another path
    byo.setBaseUrl('https://models.example/v1');
    expect(byo.key).toBe(KEY);
  });

  it('is not handed to a config that reuses the preset id for another address', () => {
    const store = storage();
    entered(store, 'https://models.example/v1');
    const hijacked = new ByoModel({
      storage: store,
      presets: [
        {
          id: 'custom',
          label: 'Custom',
          baseUrl: 'https://attacker.example/v1',
          model: 'm1',
        },
      ],
    });
    // Its entry for `custom` holds the saved models.example address, so the
    // config's address is only a default; with no saved entry it must not get the key.
    const fresh = storage();
    fresh.data.set(BYO_KEYS_KEY, store.data.get(BYO_KEYS_KEY) as string);
    const other = new ByoModel({
      storage: fresh,
      presets: [
        {
          id: 'custom',
          label: 'Custom',
          baseUrl: 'https://attacker.example/v1',
          model: 'm1',
        },
      ],
    });
    expect(other.key).toBe('');
    expect(other.complete).toBe(false);
    expect(hijacked.key).toBe(KEY);
    expect(
      savedByoChat(fresh, [
        {
          id: 'custom',
          label: 'c',
          baseUrl: 'https://attacker.example/v1',
          model: 'm1',
        },
      ]),
    ).toBeNull();
  });

  it('drops a key saved without an origin (the old format)', () => {
    const store = storage();
    store.data.set(BYO_KEYS_KEY, JSON.stringify({ custom: KEY }));
    const byo = new ByoModel({ storage: store });
    byo.select('custom');
    byo.setBaseUrl('https://models.example/v1');
    expect(byo.key).toBe('');
  });

  it('only goes over https, or to this computer', async () => {
    expect(() =>
      createOpenAIChat({
        baseUrl: 'http://192.168.1.5:11434/v1',
        model: 'm',
        apiKey: KEY,
      }),
    ).toThrow(/https/);
    expect(
      await testConnection({
        baseUrl: 'http://models.example/v1',
        model: 'm',
        apiKey: KEY,
      }),
    ).toEqual({
      ok: false,
      message: expect.stringContaining('only sent over https'),
    });
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
      'http://ollama.localhost/v1',
      'https://api.example/v1',
    ]) {
      expect(
        () => createOpenAIChat({ baseUrl: url, model: 'm', apiKey: KEY }),
        url,
      ).not.toThrow();
    }
    // Keyless (Ollama on another machine) sends no key, so plain http is fine.
    expect(() =>
      createOpenAIChat({ baseUrl: 'http://192.168.1.5:11434/v1', model: 'm' }),
    ).not.toThrow();
    const byo = entered(storage(), 'http://models.example/v1');
    expect(byo.complete).toBe(false);
    expect((await byo.test()).message).toMatch(/https/);
  });
});
