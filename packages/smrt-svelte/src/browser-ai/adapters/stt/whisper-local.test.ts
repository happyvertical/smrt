/**
 * whisper-local: engine device choice and options, the worker transport and
 * its cancellation, the model's consent/progress API, and the adapter as a
 * push-to-talk dictation source. The transformers.js pipeline, the Worker
 * and the microphone are fakes; nothing downloads.
 */
import {
  Dictation,
  type DictationAudioCapture,
} from '@happyvertical/smrt-ui/forms';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSttDictationSource } from './dictation-source.js';
import { WhisperLocalSTTAdapter } from './whisper-local.js';
import {
  serveWhisperLocalEngine,
  WhisperLocalEngine,
  type WhisperLocalEngineConfig,
  type WhisperTransformersModule,
  type WhisperWorkerRequest,
  type WhisperWorkerResponse,
} from './whisper-local-engine.js';
import { createWhisperLocalModel } from './whisper-local-model.js';

const config: WhisperLocalEngineConfig = {
  modelId: 'onnx-community/whisper-tiny.en',
  device: 'auto',
  dtype: 'q8',
  allowLocalModels: false,
};

function fakeTransformers(
  options: { failWebgpu?: boolean; text?: string } = {},
) {
  const transcriber = vi.fn(async () => ({ text: options.text ?? ' hello ' }));
  const pipeline = vi.fn(
    async (_task: string, _model: string, opts?: Record<string, unknown>) => {
      if (opts?.device === 'webgpu' && options.failWebgpu) {
        throw new Error('no webgpu');
      }
      const cb = opts?.progress_callback as
        | ((e: Record<string, unknown>) => void)
        | undefined;
      cb?.({ status: 'progress_total', loaded: 10, total: 40, progress: 25 });
      cb?.({ status: 'progress_total', loaded: 40, total: 40, progress: 100 });
      return transcriber;
    },
  );
  const is_pipeline_cached = vi.fn(async () => true);
  const module: WhisperTransformersModule = {
    pipeline,
    env: { backends: { onnx: { wasm: {} } } },
    ModelRegistry: { is_pipeline_cached },
  };
  return { module, pipeline, transcriber, is_pipeline_cached };
}

function stubGpu(available: boolean) {
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: available ? { requestAdapter: async () => ({}) } : undefined,
  });
}

describe('WhisperLocalEngine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses WebGPU when an adapter exists, with the quantised model', async () => {
    stubGpu(true);
    const fake = fakeTransformers();
    const engine = new WhisperLocalEngine(async () => fake.module);
    const progress = vi.fn();
    await expect(engine.load(config, progress)).resolves.toBe('webgpu');
    expect(fake.pipeline).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      'onnx-community/whisper-tiny.en',
      expect.objectContaining({ device: 'webgpu', dtype: 'q8' }),
    );
    expect(progress).toHaveBeenLastCalledWith(40, 40, undefined);
  });

  it('falls back to single-thread WASM without WebGPU or when WebGPU fails', async () => {
    stubGpu(false);
    const wasmOnly = fakeTransformers();
    await expect(
      new WhisperLocalEngine(async () => wasmOnly.module).load(config),
    ).resolves.toBe('wasm');
    // No cross-origin isolation (static hosts): one WASM thread.
    expect(wasmOnly.module.env?.backends?.onnx?.wasm?.numThreads).toBe(1);
    expect(wasmOnly.module.env?.useBrowserCache).toBe(true);

    stubGpu(true);
    const broken = fakeTransformers({ failWebgpu: true });
    await expect(
      new WhisperLocalEngine(async () => broken.module).load(config),
    ).resolves.toBe('wasm');
    expect(broken.pipeline).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit webgpu request as a failure', async () => {
    stubGpu(true);
    const broken = fakeTransformers({ failWebgpu: true });
    await expect(
      new WhisperLocalEngine(async () => broken.module).load({
        ...config,
        device: 'webgpu',
      }),
    ).rejects.toThrow('no webgpu');
  });

  it('transcribes, omitting the language for English-only models', async () => {
    stubGpu(false);
    const fake = fakeTransformers();
    const engine = new WhisperLocalEngine(async () => fake.module);
    await engine.load(config);
    await expect(engine.transcribe(new Float32Array(4), 'en-CA')).resolves.toBe(
      'hello',
    );
    expect(fake.transcriber.mock.calls[0]?.[1]).not.toHaveProperty('language');

    const multi = fakeTransformers();
    const multiEngine = new WhisperLocalEngine(async () => multi.module);
    await multiEngine.load({
      ...config,
      modelId: 'onnx-community/whisper-tiny',
    });
    await multiEngine.transcribe(new Float32Array(4), 'fr-CA');
    expect(multi.transcriber.mock.calls[0]?.[1]).toMatchObject({
      language: 'fr',
    });
  });

  it('reports cache state through the model registry', async () => {
    const fake = fakeTransformers();
    const engine = new WhisperLocalEngine(async () => fake.module);
    await expect(engine.isCached(config)).resolves.toBe(true);
    expect(fake.is_pipeline_cached).toHaveBeenCalledWith(
      'automatic-speech-recognition',
      config.modelId,
      { dtype: 'q8' },
    );
  });
});

/** A Worker whose other end is the real engine server, in this thread. */
function fakeWorkerFactory(
  loadTransformers: () => Promise<WhisperTransformersModule>,
) {
  const made: FakeWorker[] = [];
  class FakeWorker {
    terminated = false;
    private listeners = { message: new Set<(e: MessageEvent) => void>() };
    private serverListeners = new Set<
      (e: { data: WhisperWorkerRequest }) => void
    >();
    constructor() {
      serveWhisperLocalEngine(
        {
          addEventListener: (_t, l) => this.serverListeners.add(l),
          postMessage: (m: WhisperWorkerResponse) => {
            if (this.terminated) return;
            queueMicrotask(() => {
              for (const l of this.listeners.message) {
                l({ data: m } as MessageEvent);
              }
            });
          },
        },
        loadTransformers,
      );
      made.push(this);
    }
    addEventListener(type: string, l: (e: MessageEvent) => void) {
      if (type === 'message') this.listeners.message.add(l);
    }
    postMessage(data: WhisperWorkerRequest) {
      if (this.terminated) return;
      for (const l of this.serverListeners) l({ data });
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { create: () => new FakeWorker() as unknown as Worker, made };
}

describe('WhisperLocalModel', () => {
  beforeEach(() => stubGpu(false));
  afterEach(() => vi.unstubAllGlobals());

  it('estimates size, reports byte progress, then is ready and transcribes (worker)', async () => {
    const fake = fakeTransformers({ text: 'it works' });
    const worker = fakeWorkerFactory(async () => fake.module);
    const model = createWhisperLocalModel({ createWorker: worker.create });
    expect(model.estimateSize()).toBeGreaterThan(40_000_000);
    expect(await model.isCached()).toBe(true);
    const seen: Array<[number, number]> = [];
    await model.load({
      onProgress: (p) => seen.push([p.bytesLoaded, p.bytesTotal]),
    });
    expect(seen).toContainEqual([10, 40]);
    expect(model.state).toBe('ready');
    expect(model.device).toBe('wasm');
    await expect(model.transcribe(new Float32Array(8))).resolves.toBe(
      'it works',
    );
    // Ready: a second load returns at once, without a second pipeline.
    await model.load();
    expect(fake.pipeline).toHaveBeenCalledTimes(1);
  });

  it('cancelling a download ends the worker and a later load starts afresh', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fake = fakeTransformers();
    fake.pipeline.mockImplementationOnce(async () => {
      await gate;
      return fake.transcriber;
    });
    const worker = fakeWorkerFactory(async () => fake.module);
    const model = createWhisperLocalModel({ createWorker: worker.create });
    const controller = new AbortController();
    const loading = model.load({ signal: controller.signal });
    await vi.waitFor(() => expect(fake.pipeline).toHaveBeenCalled());
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.made[0]?.terminated).toBe(true);
    expect(model.state).toBe('idle');
    release();
    await model.load();
    expect(model.state).toBe('ready');
    expect(worker.made).toHaveLength(2);
  });

  it('runs on the page thread with a supplied module loader', async () => {
    const fake = fakeTransformers({ text: 'in page' });
    const model = createWhisperLocalModel({
      loadModule: async () => fake.module,
    });
    await model.load();
    await expect(model.transcribe(new Float32Array(2))).resolves.toBe(
      'in page',
    );
  });

  it('refuses to transcribe before it is loaded', async () => {
    const model = createWhisperLocalModel({ loadModule: async () => ({}) });
    await expect(model.transcribe(new Float32Array(1))).rejects.toThrow(
      /not loaded/,
    );
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

describe('WhisperLocalSTTAdapter', () => {
  beforeEach(() => {
    stubGpu(false);
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
    const fake = fakeTransformers({ text });
    const capture = fakeCapture();
    const adapter = new WhisperLocalSTTAdapter({
      type: 'whisper-local',
      loadModule: async () => fake.module,
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

  it('maps legacy modelSize, keeps the whisper-wasm type, shares a model handle', () => {
    const legacy = new WhisperLocalSTTAdapter({
      type: 'whisper-wasm',
      modelSize: 'base',
    });
    expect(legacy.type).toBe('whisper-wasm');
    expect(legacy.model.modelId).toBe('onnx-community/whisper-base.en');
    const shared = createWhisperLocalModel({});
    const a = new WhisperLocalSTTAdapter({ modelHandle: shared });
    expect(a.model).toBe(shared);
    expect(a.getCapabilities().requiresDownload).toBe(true);
    expect(a.getCapabilities().languages).toEqual(['en']);
  });

  it('works through createSttDictationSource and the Dictation state machine', async () => {
    const fake = fakeTransformers({ text: 'dictated text' });
    const capture = fakeCapture();
    const provide = createSttDictationSource({
      type: 'whisper-local',
      loadModule: async () => fake.module,
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
});
