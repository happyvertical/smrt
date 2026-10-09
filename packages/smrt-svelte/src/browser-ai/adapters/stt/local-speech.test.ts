/**
 * On-device speech (`whisper-local`, `moonshine`) over
 * `@happyvertical/speech/local`: the model's consent/progress API on the
 * page's thread and through a worker, cancellation, and the adapter as a
 * push-to-talk dictation source and a per-utterance transcriber. The speech
 * engine, the Worker and the microphone are fakes; nothing downloads.
 */
import {
  Dictation,
  type DictationAudioCapture,
} from '@happyvertical/smrt-ui/forms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSttDictationSource } from './dictation-source.js';
import { LocalSpeechSTTAdapter } from './local-speech.js';
import {
  createLocalSpeechModel,
  createWhisperLocalModel,
  LOCAL_SPEECH_MODELS,
  resolveLocalSpeechModelId,
} from './local-speech-model.js';
import { configureTransformersEnv } from './transformers-env.js';

interface Progress {
  status: string;
  loaded?: number;
  total?: number;
  file?: string;
}

/**
 * A stand-in for `@happyvertical/speech/local`: both `LocalTranscriber`
 * (page thread) and `LocalTranscriberWorkerClient` (worker) front the same
 * fake engine, so one set of assertions covers both transports.
 */
function fakeSpeech(options: { text?: string; cached?: boolean } = {}) {
  const preload = vi.fn(
    async (_model?: string, _signal?: AbortSignal): Promise<void> => {},
  );
  const transcribe = vi.fn(
    async (_request: {
      audio: { data: Uint8Array; mimeType: string };
      model?: string;
      language?: string;
    }) => ({ text: options.text ?? ' hello ' }),
  );
  const isCached = vi.fn(async () => options.cached ?? true);
  const constructed: Array<Record<string, unknown>> = [];
  const clients: Array<{ endpoint: unknown; closed: boolean }> = [];
  let onProgress: ((p: Progress) => void) | undefined;
  const engine = {
    preload: async (model?: string, signal?: AbortSignal) => {
      onProgress?.({ status: 'progress_total', loaded: 10, total: 40 });
      await preload(model, signal);
      onProgress?.({ status: 'progress_total', loaded: 40, total: 40 });
    },
    transcribe,
    isCached,
  };
  class LocalTranscriber {
    constructor(opts: Record<string, unknown>) {
      constructed.push(opts);
      onProgress = opts.onProgress as (p: Progress) => void;
    }
    preload = engine.preload;
    transcribe = engine.transcribe;
    isCached = engine.isCached;
    dispose = vi.fn(async () => {});
  }
  class LocalTranscriberWorkerClient {
    record: { endpoint: unknown; closed: boolean };
    constructor(
      endpoint: unknown,
      opts: { onProgress?: (p: Progress) => void },
    ) {
      onProgress = opts.onProgress;
      this.record = { endpoint, closed: false };
      clients.push(this.record);
    }
    preload = engine.preload;
    transcribe = engine.transcribe;
    isCached = engine.isCached;
    close() {
      this.record.closed = true;
    }
  }
  return {
    module: { LocalTranscriber, LocalTranscriberWorkerClient },
    loadSpeech: async () => ({
      LocalTranscriber,
      LocalTranscriberWorkerClient,
    }),
    preload,
    transcribe,
    isCached,
    constructed,
    clients,
  };
}

function fakeWorker() {
  const made: Array<{ terminated: boolean }> = [];
  return {
    create: () => {
      const worker = {
        terminated: false,
        terminate() {
          this.terminated = true;
        },
      };
      made.push(worker);
      return worker as unknown as Worker;
    },
    made,
  };
}

describe('model names', () => {
  it('resolves short names to Hugging Face ids and keeps ids as they are', () => {
    expect(resolveLocalSpeechModelId('moonshine-tiny')).toBe(
      'onnx-community/moonshine-tiny-ONNX',
    );
    expect(resolveLocalSpeechModelId('moonshine-base')).toBe(
      'onnx-community/moonshine-base-ONNX',
    );
    expect(resolveLocalSpeechModelId('org/custom')).toBe('org/custom');
    expect(resolveLocalSpeechModelId()).toBe('onnx-community/whisper-tiny.en');
    expect(LOCAL_SPEECH_MODELS['moonshine-tiny']?.bytes).toBeLessThan(
      LOCAL_SPEECH_MODELS['moonshine-base']?.bytes ?? 0,
    );
  });

  it('knows which models are English only', () => {
    expect(
      createLocalSpeechModel({ model: 'moonshine-tiny' }).englishOnly,
    ).toBe(true);
    expect(
      createLocalSpeechModel({ model: 'onnx-community/whisper-tiny' })
        .englishOnly,
    ).toBe(false);
  });
});

describe('LocalSpeechModel on the page thread', () => {
  it('estimates size, reports download then getting-ready then complete, and transcribes', async () => {
    const speech = fakeSpeech({ text: ' it works ' });
    const loadModule = async () => ({});
    const model = createLocalSpeechModel({
      model: 'moonshine-tiny',
      loadSpeech: speech.loadSpeech,
      loadModule,
    });
    expect(model.estimateSize()).toBe(32_200_000);
    expect(await model.isCached()).toBe(true);
    const seen: Array<[string, number, number]> = [];
    await model.load({
      onProgress: (p) => seen.push([p.state, p.bytesLoaded, p.bytesTotal]),
    });
    expect(seen).toContainEqual(['downloading', 10, 40]);
    // All bytes in, model still compiling: "Getting ready".
    expect(seen).toContainEqual(['extracting', 40, 40]);
    expect(seen.at(-1)?.[0]).toBe('complete');
    expect(model.state).toBe('ready');
    expect(speech.constructed[0]).toMatchObject({
      model: 'onnx-community/moonshine-tiny-ONNX',
      device: 'auto',
      dtype: 'q8',
      transformers: loadModule,
    });
    expect(speech.preload).toHaveBeenCalledWith(
      'onnx-community/moonshine-tiny-ONNX',
      undefined,
    );

    const pcm = new Float32Array([0.25, -0.5]);
    await expect(model.transcribe(pcm, 'en-CA')).resolves.toBe('it works');
    const request = speech.transcribe.mock.calls[0]?.[0];
    expect(request?.language).toBe('en');
    expect(request?.model).toBe('onnx-community/moonshine-tiny-ONNX');
    expect(request?.audio.mimeType).toBe(
      'audio/pcm;rate=16000;channels=1;encoding=f32le',
    );
    expect(
      Array.from(new Float32Array(request?.audio.data.buffer ?? [])),
    ).toEqual([0.25, -0.5]);
    // Ready: a second load returns at once, without a second preload.
    await model.load();
    expect(speech.preload).toHaveBeenCalledTimes(1);
  });

  it('keeps the old createWhisperLocalModel name and default model', () => {
    const model = createWhisperLocalModel({});
    expect(model.modelId).toBe('onnx-community/whisper-tiny.en');
    expect(model.estimateSize()).toBeGreaterThan(40_000_000);
  });

  it('refuses to transcribe before it is loaded', async () => {
    const model = createLocalSpeechModel({
      loadSpeech: fakeSpeech().loadSpeech,
    });
    await expect(model.transcribe(new Float32Array(1))).rejects.toThrow(
      /not loaded/,
    );
  });

  it('says plainly when the speech package is not installed', async () => {
    const model = createLocalSpeechModel({
      loadSpeech: async () => {
        throw new Error('Cannot find package');
      },
    });
    await expect(model.load()).rejects.toThrow(/@happyvertical\/speech/);
    expect(model.state).toBe('error');
  });

  it('a cancelled load rejects with AbortError and leaves the model idle', async () => {
    const speech = fakeSpeech();
    speech.preload.mockImplementationOnce(
      (_m, signal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const model = createLocalSpeechModel({ loadSpeech: speech.loadSpeech });
    const controller = new AbortController();
    const loading = model.load({ signal: controller.signal });
    await vi.waitFor(() => expect(speech.preload).toHaveBeenCalled());
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.state).toBe('idle');
    await model.load();
    expect(model.state).toBe('ready');
  });
});

describe('LocalSpeechModel through a worker', () => {
  it('builds the SDK worker client on the supplied Worker and reports progress', async () => {
    const speech = fakeSpeech({ text: 'in a worker' });
    const worker = fakeWorker();
    const model = createLocalSpeechModel({
      createWorker: worker.create,
      loadSpeech: speech.loadSpeech,
    });
    expect(await model.isCached()).toBe(true);
    const seen: number[] = [];
    await model.load({ onProgress: (p) => seen.push(p.bytesLoaded) });
    expect(seen).toContain(10);
    expect(speech.clients).toHaveLength(1);
    await expect(model.transcribe(new Float32Array(8))).resolves.toBe(
      'in a worker',
    );
    expect(speech.constructed).toHaveLength(0);
  });

  it('cancelling a download ends the worker and a later load starts afresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const speech = fakeSpeech();
    speech.preload.mockImplementationOnce(() => gate);
    const worker = fakeWorker();
    const model = createLocalSpeechModel({
      createWorker: worker.create,
      loadSpeech: speech.loadSpeech,
    });
    const controller = new AbortController();
    const loading = model.load({ signal: controller.signal });
    await vi.waitFor(() => expect(speech.preload).toHaveBeenCalled());
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.made[0]?.terminated).toBe(true);
    expect(speech.clients[0]?.closed).toBe(true);
    expect(model.state).toBe('idle');
    release();
    await model.load();
    expect(model.state).toBe('ready');
    expect(worker.made).toHaveLength(2);
  });
});

describe('configureTransformersEnv', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses Cache Storage and one WASM thread without cross-origin isolation', () => {
    const env = { backends: { onnx: { wasm: {} as { numThreads?: number } } } };
    configureTransformersEnv(false)(env as unknown as Record<string, unknown>);
    expect((env as Record<string, unknown>).useBrowserCache).toBe(true);
    expect((env as Record<string, unknown>).allowLocalModels).toBe(false);
    expect(env.backends.onnx.wasm.numThreads).toBe(1);

    vi.stubGlobal('crossOriginIsolated', true);
    const isolated = {
      backends: { onnx: { wasm: {} as { numThreads?: number } } },
    };
    configureTransformersEnv(true)(
      isolated as unknown as Record<string, unknown>,
    );
    expect(isolated.backends.onnx.wasm.numThreads).toBeUndefined();
  });
});

/** A recorder that returns a fixed clip and can end by itself. */
function fakeCapture() {
  const limits = new Set<(r: 'time' | 'size') => void>();
  const capture: DictationAudioCapture & {
    hitLimit(r: 'time' | 'size'): void;
    start: ReturnType<typeof vi.fn>;
  } = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({
      audio: new Blob([new Uint8Array(8)], { type: 'audio/webm' }),
      mimeType: 'audio/webm',
      durationMs: 1200,
      reachedTimeLimit: false,
    })),
    cancel: vi.fn(),
    onLimit: (cb) => (limits.add(cb), () => limits.delete(cb)),
    hitLimit: (r) => {
      for (const cb of limits) cb(r);
    },
  };
  return capture;
}

describe('LocalSpeechSTTAdapter', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = async () => ({
          getChannelData: () => new Float32Array([0.1, 0.2, 0.3]),
        });
        close = async () => {};
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function build(text = 'hello world') {
    const fake = fakeSpeech({ text });
    const capture = fakeCapture();
    const adapter = new LocalSpeechSTTAdapter({
      type: 'whisper-local',
      loadSpeech: fake.loadSpeech,
      loadModule: async () => ({}),
      capture: () => capture,
    });
    return { adapter, capture, fake };
  }

  it('records until stop, then emits one final result and ends', async () => {
    const { adapter, capture } = build();
    const events: string[] = [];
    adapter.onStart(() => events.push('start'));
    adapter.onResult((r) =>
      events.push(`result:${r.text}:${r.isFinal ? 'final' : 'interim'}`),
    );
    adapter.onEnd(() => events.push('end'));
    await adapter.start({ language: 'en-CA' });
    expect(adapter.isListening()).toBe(true);
    expect(capture.stop).not.toHaveBeenCalled();
    await adapter.stop();
    expect(events).toEqual(['start', 'result:hello world:final', 'end']);
    expect(adapter.isListening()).toBe(false);
    expect(adapter.initState).toBe('ready');
  });

  it('reports recorder failures and long-recording limits as errors', async () => {
    const { adapter, capture } = build();
    capture.start.mockRejectedValueOnce(new Error('blocked'));
    const onError = vi.fn();
    adapter.onError(onError);
    await expect(adapter.start()).rejects.toThrow('blocked');
    expect(onError).toHaveBeenCalled();

    await adapter.start();
    capture.hitLimit('size');
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(adapter.isListening()).toBe(false);
  });

  it('transcribes by itself when the time cap is reached', async () => {
    const { adapter, capture } = build('capped');
    const onResult = vi.fn();
    adapter.onResult(onResult);
    await adapter.start();
    capture.hitLimit('time');
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'capped' }),
      ),
    );
  });

  it('abort() throws the recording away without a result', async () => {
    const { adapter, capture } = build();
    const onResult = vi.fn();
    adapter.onResult(onResult);
    await adapter.start();
    adapter.abort();
    expect(capture.cancel).toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('a stop() while the model is still loading cancels the start', async () => {
    const fake = fakeSpeech();
    const capture = fakeCapture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = new LocalSpeechSTTAdapter({
      type: 'whisper-local',
      loadSpeech: async () => {
        await gate;
        return fake.loadSpeech();
      },
      loadModule: async () => ({}),
      capture: () => capture,
    });
    const starting = adapter.start();
    await adapter.stop();
    release();
    await starting;
    expect(capture.start).not.toHaveBeenCalled();
    expect(adapter.isListening()).toBe(false);
  });

  it('maps legacy modelSize, keeps the whisper-wasm type, shares a model handle', () => {
    const legacy = new LocalSpeechSTTAdapter({
      type: 'whisper-wasm',
      modelSize: 'base',
    });
    expect(legacy.type).toBe('whisper-wasm');
    expect(legacy.model.modelId).toBe('onnx-community/whisper-base.en');
    const shared = createLocalSpeechModel({});
    const a = new LocalSpeechSTTAdapter({ modelHandle: shared });
    expect(a.model).toBe(shared);
    expect(a.getCapabilities().requiresDownload).toBe(true);
    expect(a.getCapabilities().languages).toEqual(['en']);
  });

  it('works through createSttDictationSource and the Dictation state machine', async () => {
    const fake = fakeSpeech({ text: 'dictated text' });
    const capture = fakeCapture();
    const provide = createSttDictationSource({
      type: 'whisper-local',
      loadSpeech: fake.loadSpeech,
      loadModule: async () => ({}),
      // @ts-expect-error test seam, not part of the public options
      capture: () => capture,
    });
    const onText = vi.fn();
    const dictation = new Dictation({
      source: provide,
      onText,
      beep: false,
      requestMicrophone: false,
    });
    await dictation.start();
    expect(dictation.state).toBe('listening');
    await dictation.stop();
    await vi.waitFor(() =>
      expect(onText).toHaveBeenCalledWith('dictated text'),
    );
    expect(dictation.state).toBe('idle');
    dictation.dispose();
  });

  it('moonshine defaults to Moonshine tiny and is English only', () => {
    const adapter = new LocalSpeechSTTAdapter({ type: 'moonshine' });
    expect(adapter.type).toBe('moonshine');
    expect(adapter.model.modelId).toBe('onnx-community/moonshine-tiny-ONNX');
    expect(adapter.getCapabilities().languages).toEqual(['en']);
    expect(adapter.estimateSize()).toBe(32_200_000);
    const base = new LocalSpeechSTTAdapter({
      type: 'moonshine',
      model: 'moonshine-base',
    });
    expect(base.model.modelId).toBe('onnx-community/moonshine-base-ONNX');
  });

  it('transcribePcm loads the model and writes one utterance down', async () => {
    const { adapter, fake } = build('one utterance');
    await expect(
      adapter.transcribePcm(new Float32Array(160), { language: 'fr-CA' }),
    ).resolves.toBe('one utterance');
    expect(fake.preload).toHaveBeenCalledTimes(1);
    expect(fake.transcribe.mock.calls[0]?.[0].language).toBe('fr');
    // A second utterance reuses the loaded model.
    await adapter.transcribePcm(new Float32Array(160));
    expect(fake.preload).toHaveBeenCalledTimes(1);
    expect(fake.transcribe).toHaveBeenCalledTimes(2);
  });

  it('never downloads: start, transcribePcm and prepare reject while the model is not cached', async () => {
    const fake = fakeSpeech({ cached: false });
    const capture = fakeCapture();
    const adapter = new LocalSpeechSTTAdapter({
      type: 'whisper-local',
      loadSpeech: fake.loadSpeech,
      loadModule: async () => ({}),
      capture: () => capture,
    });
    await expect(adapter.start()).rejects.toMatchObject({
      name: 'ModelNotDownloadedError',
      dictationKind: 'model-missing',
    });
    await expect(adapter.prepare()).rejects.toMatchObject({
      code: 'MODEL_NOT_DOWNLOADED',
    });
    await expect(adapter.transcribePcm(new Float32Array(160))).rejects.toThrow(
      "isn't downloaded yet",
    );
    expect(fake.preload).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    // The host loads it explicitly; dictation then works.
    await adapter.load();
    expect(fake.preload).toHaveBeenCalledTimes(1);
    await adapter.start();
    expect(adapter.isListening()).toBe(true);
  });

  it('dictation reports model-missing instead of downloading, in push and hands-free modes', async () => {
    const fake = fakeSpeech({ cached: false });
    const provide = createSttDictationSource({
      type: 'whisper-local',
      loadSpeech: fake.loadSpeech,
      loadModule: async () => ({}),
      // @ts-expect-error test seam, not part of the public options
      capture: () => fakeCapture(),
    });
    const push = new Dictation({
      source: provide,
      onText: vi.fn(),
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await push.start();
    expect(push.state).toBe('error');
    expect(push.errorKind).toBe('model-missing');
    push.dispose();
    const factory = vi.fn();
    const handsFree = new Dictation({
      source: provide,
      onText: vi.fn(),
      mode: 'hands-free',
      handsFreeCapture: factory,
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await handsFree.start();
    expect(handsFree.errorKind).toBe('model-missing');
    expect(factory).not.toHaveBeenCalled();
    expect(fake.preload).not.toHaveBeenCalled();
    handsFree.dispose();
  });
});
