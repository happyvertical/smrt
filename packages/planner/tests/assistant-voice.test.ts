import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SPEECH_MODEL,
  type LocalSpeechModel,
  loadSpeechModel,
  loadVoiceConsent,
  planVoice,
  SPEECH_MODELS,
  VOICE_PREFS_KEY,
  VoiceSession,
} from '../src/lib/assistant/voice.svelte.ts';

function storage(initial?: string) {
  const data = new Map<string, string>();
  if (initial) data.set(VOICE_PREFS_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage;
}

function fakeModel(options: { cached?: boolean; fail?: Error } = {}) {
  const model = {
    estimateSize: () => 45_100_000,
    isCached: vi.fn(async () => options.cached ?? false),
    load: vi.fn(
      async (loadOptions?: {
        onProgress?: (p: {
          bytesLoaded: number;
          bytesTotal: number;
          percent: number;
        }) => void;
        signal?: AbortSignal;
      }) => {
        if (options.fail) throw options.fail;
        loadOptions?.onProgress?.({
          bytesLoaded: 10,
          bytesTotal: 40,
          percent: 25,
        });
        if (loadOptions?.signal) {
          await new Promise<void>((_resolve, reject) => {
            if (loadOptions.signal?.aborted) reject(new Error('cancelled'));
            loadOptions.signal?.addEventListener('abort', () =>
              reject(new Error('cancelled')),
            );
          });
        }
      },
    ),
    dispose: vi.fn(),
  };
  return model as unknown as LocalSpeechModel & typeof model;
}

const browserSource = () => () => Promise.reject(new Error('unused'));

describe('planVoice', () => {
  it('uses the browser where it works, whatever else is on the device', () => {
    expect(planVoice('works', true, true)).toBe('browser');
  });

  it('offers the download where speech is missing or unreliable', () => {
    expect(planVoice('missing', false, false)).toBe('offer');
    expect(planVoice('unreliable', false, false)).toBe('offer');
  });

  it('turns a downloaded model on without asking again, only with consent and a cache', () => {
    expect(planVoice('missing', true, true)).toBe('enable-cached');
    expect(planVoice('missing', true, false)).toBe('offer');
    expect(planVoice('missing', false, true)).toBe('offer');
  });
});

describe('loadVoiceConsent', () => {
  it('reads the saved choice and survives broken or missing storage', () => {
    expect(loadVoiceConsent(storage('{"local":true}'))).toBe(true);
    expect(loadVoiceConsent(storage('not json'))).toBe(false);
    expect(loadVoiceConsent(null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadVoiceConsent(throwing)).toBe(false);
  });
});

describe('speech models', () => {
  it('offers Moonshine base first, then Moonshine tiny and Whisper tiny, each with its size', () => {
    expect(SPEECH_MODELS.map((m) => m.id)).toEqual([
      'moonshine-base',
      'moonshine-tiny',
      'whisper-tiny.en',
    ]);
    expect(DEFAULT_SPEECH_MODEL).toBe('moonshine-base');
    expect(SPEECH_MODELS.map((m) => m.adapter)).toEqual([
      'moonshine',
      'moonshine',
      'whisper-local',
    ]);
    for (const model of SPEECH_MODELS) {
      expect(model.bytes).toBeGreaterThan(20_000_000);
    }
    // The fastest model is the smallest download, and is labelled so.
    expect(SPEECH_MODELS[1]?.bytes).toBeLessThan(SPEECH_MODELS[0]?.bytes ?? 0);
    expect(SPEECH_MODELS[1]?.note).toMatch(/fastest, less accurate/i);
  });

  it('defaults new visitors to Moonshine and keeps Whisper for earlier downloads', () => {
    expect(loadSpeechModel(storage())).toBe('moonshine-base');
    expect(loadSpeechModel(null)).toBe('moonshine-base');
    // Downloaded before the choice existed: that was Whisper tiny.
    expect(loadSpeechModel(storage('{"local":true}'))).toBe('whisper-tiny.en');
    expect(
      loadSpeechModel(storage('{"local":true,"model":"moonshine-tiny"}')),
    ).toBe('moonshine-tiny');
    expect(loadSpeechModel(storage('{"model":"nonsense"}'))).toBe(
      'moonshine-base',
    );
  });
});

describe('VoiceSession model choice', () => {
  it('builds the chosen model, and hands its adapter type to the local source', async () => {
    const created: string[] = [];
    const sources: string[] = [];
    const model = fakeModel();
    model.load.mockResolvedValue(undefined);
    const voice = new VoiceSession({
      storage: storage(),
      createModel: (id) => {
        created.push(id);
        return model;
      },
      probe: async () => 'missing',
      localSource: (_m, choice) => {
        sources.push(choice.adapter);
        return () => Promise.reject(new Error('unused'));
      },
    });
    await voice.init();
    expect(voice.model).toBe('moonshine-base');
    await voice.enable();
    expect(created).toEqual(['moonshine-base']);
    expect(sources).toEqual(['moonshine']);
  });

  it('switching model drops the loaded one, remembers the pick, and offers the new download', async () => {
    const store = storage();
    const first = fakeModel();
    first.load.mockResolvedValue(undefined);
    const second = fakeModel();
    const created: string[] = [];
    const voice = new VoiceSession({
      storage: store,
      createModel: (id) => {
        created.push(id);
        return created.length === 1 ? first : second;
      },
      probe: async () => 'missing',
      localSource: () => () => Promise.reject(new Error('unused')),
    });
    await voice.init();
    await voice.enable();
    expect(voice.status).toBe('ready');

    await voice.setModel('whisper-tiny.en');
    expect(first.dispose).toHaveBeenCalled();
    expect(created).toEqual(['moonshine-base', 'whisper-tiny.en']);
    expect(voice.model).toBe('whisper-tiny.en');
    // Consent was for downloading; the new one is not cached, so it is offered.
    expect(voice.status).toBe('offer');
    expect(voice.dictation).toBeNull();
    expect(loadSpeechModel(store)).toBe('whisper-tiny.en');

    // Same pick, or nonsense: nothing happens.
    await voice.setModel('whisper-tiny.en');
    await voice.setModel('bogus' as never);
    expect(created).toHaveLength(2);
  });

  it('reports "getting ready" once every byte is in, until it is on', async () => {
    const model = fakeModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.load.mockImplementation(async (o) => {
      o?.onProgress?.({
        state: 'downloading',
        bytesLoaded: 40,
        bytesTotal: 40,
        percent: 100,
      } as never);
      o?.onProgress?.({
        state: 'extracting',
        bytesLoaded: 40,
        bytesTotal: 40,
        percent: 100,
      } as never);
      await gate;
    });
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => model,
      probe: async () => 'missing',
      localSource: () => () => Promise.reject(new Error('unused')),
    });
    await voice.init();
    const enabling = voice.enable();
    await Promise.resolve();
    expect(voice.status).toBe('downloading');
    expect(voice.preparing).toBe(true);
    release();
    await enabling;
    expect(voice.status).toBe('ready');
    expect(voice.preparing).toBe(false);
  });
});

describe('VoiceSession', () => {
  it('passes the browser source through and never makes the model', async () => {
    const createModel = vi.fn();
    const source = () => Promise.reject(new Error('unused'));
    const voice = new VoiceSession({
      storage: storage(),
      createModel,
      probe: async () => 'works',
      browserSource: () => source,
    });
    await voice.init();
    expect(voice.status).toBe('browser');
    expect(voice.dictation).toBe(source);
    expect(createModel).not.toHaveBeenCalled();
  });

  it('offers the download with its size and downloads nothing until asked', async () => {
    const model = fakeModel();
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => model,
      probe: async () => 'unreliable',
      browserSource,
    });
    await voice.init();
    expect(voice.status).toBe('offer');
    expect(voice.size).toBe(45_100_000);
    expect(voice.cached).toBe(false);
    expect(voice.dictation).toBeNull();
    expect(model.load).not.toHaveBeenCalled();
  });

  it('downloads on request, remembers the choice, and hands over the local source', async () => {
    const model = fakeModel({ fail: undefined });
    model.load.mockImplementation(async (o) => {
      o?.onProgress?.({ bytesLoaded: 20, bytesTotal: 40, percent: 50 });
    });
    const store = storage();
    const local = () => Promise.reject(new Error('unused'));
    const voice = new VoiceSession({
      storage: store,
      createModel: () => model,
      probe: async () => 'missing',
      localSource: () => local,
    });
    await voice.init();
    await voice.enable();
    expect(voice.status).toBe('ready');
    expect(voice.progress).toBe(0.5);
    expect(voice.dictation).toBe(local);
    expect(loadVoiceConsent(store)).toBe(true);
  });

  it('turns a downloaded model on by itself on a later visit', async () => {
    const model = fakeModel({ cached: true });
    model.load.mockResolvedValue(undefined);
    const voice = new VoiceSession({
      storage: storage('{"local":true}'),
      createModel: () => model,
      probe: async () => 'missing',
      localSource: () => () => Promise.reject(new Error('unused')),
    });
    await voice.init();
    expect(voice.status).toBe('ready');
    expect(voice.cached).toBe(true);
  });

  it('shows the already-downloaded offer when cached without a saved choice', async () => {
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => fakeModel({ cached: true }),
      probe: async () => 'missing',
    });
    await voice.init();
    expect(voice.status).toBe('offer');
    expect(voice.cached).toBe(true);
  });

  it('cancel returns to the offer and saves no consent', async () => {
    const model = fakeModel();
    const store = storage();
    const voice = new VoiceSession({
      storage: store,
      createModel: () => model,
      probe: async () => 'missing',
    });
    await voice.init();
    const enabling = voice.enable();
    expect(voice.status).toBe('downloading');
    voice.cancel();
    await enabling;
    expect(voice.status).toBe('offer');
    expect(loadVoiceConsent(store)).toBe(false);
    expect(voice.dictation).toBeNull();
  });

  it('shows a failure and lets the visitor try again', async () => {
    const model = fakeModel({ fail: new Error('offline') });
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => model,
      probe: async () => 'missing',
    });
    await voice.init();
    await voice.enable();
    expect(voice.status).toBe('error');
    expect(voice.error).toBe('offline');
    model.load.mockResolvedValueOnce(undefined);
    await voice.enable();
    expect(voice.status).toBe('ready');
  });

  it('"not now" hides the offer for the visit', async () => {
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => fakeModel(),
      probe: async () => 'missing',
    });
    await voice.init();
    voice.dismiss();
    expect(voice.status).toBe('dismissed');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VoiceSession superseded work', () => {
  it('ignores a slow probe from before a restart', async () => {
    const probes = [
      deferred<'works' | 'missing'>(),
      deferred<'works' | 'missing'>(),
    ];
    let call = 0;
    const models: ReturnType<typeof fakeModel>[] = [];
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => {
        const m = fakeModel();
        models.push(m);
        return m;
      },
      probe: () => (probes[call++] as (typeof probes)[number]).promise,
      browserSource: () => () => Promise.reject(new Error('unused')),
    });
    const first = voice.init();
    // The browser works, so a preference change restarts the session.
    voice.browserWorks = true;
    const second = voice.setPreferLocal(true);
    probes[1]?.resolve('missing');
    await second;
    expect(voice.status).toBe('offer');
    expect(voice.dictation).toBeNull();
    // The first probe finally answers "works": it must not win.
    probes[0]?.resolve('works');
    await first;
    expect(voice.status).toBe('offer');
    expect(voice.dictation).toBeNull();
    expect(models).toHaveLength(1);
  });

  it('disposes a model whose cache check was superseded', async () => {
    const cacheChecks = [deferred<boolean>(), deferred<boolean>()];
    const models: ReturnType<typeof fakeModel>[] = [];
    const voice = new VoiceSession({
      storage: storage('{"local":true}'),
      createModel: () => {
        const m = fakeModel();
        const n = models.length;
        m.isCached = vi.fn(
          () => (cacheChecks[n] as (typeof cacheChecks)[number]).promise,
        );
        models.push(m);
        return m;
      },
      probe: async () => 'missing',
      localSource: () => () => Promise.reject(new Error('unused')),
    });
    const first = voice.init();
    await Promise.resolve();
    await Promise.resolve();
    const second = voice.setModel('moonshine-tiny');
    await Promise.resolve();
    await Promise.resolve();
    cacheChecks[1]?.resolve(false);
    await second;
    expect(voice.status).toBe('offer');
    cacheChecks[0]?.resolve(true);
    await first;
    // The old init must not enable its (cached) model over the newer session.
    expect(voice.status).toBe('offer');
    expect(voice.model).toBe('moonshine-tiny');
    expect(models[0]?.load).not.toHaveBeenCalled();
  });

  it('drops a superseded download and disposes nothing the new session owns', async () => {
    const loads: ReturnType<typeof deferred<void>>[] = [];
    const sources: string[] = [];
    const makeModel = () => {
      const m = fakeModel();
      const d = deferred<void>();
      loads.push(d);
      m.load = vi.fn(() => d.promise) as never;
      return m;
    };
    const models: ReturnType<typeof makeModel>[] = [];
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => {
        const m = makeModel();
        models.push(m);
        return m;
      },
      probe: async () => 'missing',
      localSource: (_m, choice) => {
        sources.push(choice.id);
        return () => Promise.reject(new Error('unused'));
      },
    });
    await voice.init();
    const enabling = voice.enable();
    expect(voice.status).toBe('downloading');
    // Switch model mid-download: the old download is superseded.
    const switching = voice.setModel('moonshine-tiny');
    await switching;
    expect(voice.status).toBe('offer');
    // The old download completes late; it must not turn voice on.
    loads[0]?.resolve();
    await enabling;
    expect(voice.status).toBe('offer');
    expect(voice.dictation).toBeNull();
    expect(sources).toEqual([]);
    expect(models[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(models[1]?.dispose).not.toHaveBeenCalled();
  });

  it('cancel then enable again: the cancelled run cannot reset the new one', async () => {
    const loads: ReturnType<typeof deferred<void>>[] = [];
    const model = fakeModel();
    model.load = vi.fn(() => {
      const d = deferred<void>();
      loads.push(d);
      return d.promise;
    }) as never;
    const voice = new VoiceSession({
      storage: storage(),
      createModel: () => model,
      probe: async () => 'missing',
      localSource: () => () => Promise.reject(new Error('unused')),
    });
    await voice.init();
    const first = voice.enable();
    voice.cancel();
    // The cancelled download rejects only after the visitor retried.
    voice.status = 'offer';
    const second = voice.enable();
    expect(voice.status).toBe('downloading');
    loads[0]?.reject(new Error('cancelled'));
    await first;
    expect(voice.status).toBe('downloading');
    loads[1]?.resolve();
    await second;
    expect(voice.status).toBe('ready');
    expect(model.dispose).not.toHaveBeenCalled();
  });
});
