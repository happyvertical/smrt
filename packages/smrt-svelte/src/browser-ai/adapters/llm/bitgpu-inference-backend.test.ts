/**
 * The `bitgpu` inference backend.
 *
 * Beyond the sibling WebLLM suite's invariants, these three are what make this
 * backend worth having:
 *
 * 1. **`signal` is forwarded.** bitgpu is the only backend in this package that
 *    can abort a live generation, so losing the option would make the one
 *    cancellation-capable path behave like the ones that cannot cancel.
 * 2. **A turn before `load()` fails with a named reason.** These weights run from
 *    hundreds of MB to multiple GB; an implicit download behind the first turn is
 *    the failure this refuses to have.
 * 3. **Progress maps onto the mirrored shape**, so `DownloadProgress` renders it
 *    without acquiring a second vocabulary.
 */

import type {
  InferencePathError,
  InferenceProgress,
} from '@happyvertical/smrt-web/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BitGpuChatModule,
  type BitGpuLoadProgress,
  type BitGpuModule,
  createBitGpuInferenceBackend,
} from './bitgpu-inference-backend.js';

const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
);

/** jsdom has no `navigator.gpu`; detectCapabilities keys off `'gpu' in navigator`. */
function withWebGpu(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...globalThis.navigator, gpu: {} },
    configurable: true,
  });
}

type FinishReason = 'stop' | 'length' | 'abort' | 'tool_calls';

interface Doubles {
  engineCalls: number;
  chatCalls: number;
  sends: Array<{ messages: unknown; options?: unknown }>;
  streams: Array<{ messages: unknown; options?: unknown }>;
  disposed: number;
  /** Deliver a load-progress report as the engine would. */
  emitProgress(report: BitGpuLoadProgress): void;
  /** Make the next `createEngine` reject. */
  failEngine(error: Error | null): void;
  /** Deltas the next `stream` yields. */
  streamDeltas: string[];
  /** `finishReason` the next `send`/`stream` resolves with. */
  finishReason: FinishReason;
  /**
   * Resolves once `createEngine` has run — i.e. once the engine's `onProgress`
   * is actually wired. Tests await this instead of guessing how many microtasks
   * the load needs, which is what made an earlier version of these tests flaky.
   */
  whenEngineReady: Promise<void>;
}

function makeModules(): {
  options: {
    loadBitGpu: () => Promise<BitGpuModule>;
    loadChat: () => Promise<BitGpuChatModule>;
  };
  d: Doubles;
} {
  let onProgress: ((report: BitGpuLoadProgress) => void) | undefined;
  let engineFailure: Error | null = null;
  let markEngineReady: () => void = () => {};
  const whenEngineReady = new Promise<void>((resolve) => {
    markEngineReady = resolve;
  });

  const d: Doubles = {
    engineCalls: 0,
    chatCalls: 0,
    sends: [],
    streams: [],
    disposed: 0,
    emitProgress: (report) => onProgress?.(report),
    failEngine: (error) => {
      engineFailure = error;
    },
    streamDeltas: ['Hel', 'lo'],
    finishReason: 'stop',
    whenEngineReady,
  };

  const engine = {
    dispose(): void {
      d.disposed += 1;
    },
  };

  // Typed as the interfaces the backend declares, so the compiler checks the
  // double rather than a cast asserting it.
  const bitgpu: BitGpuModule = {
    async createEngine(options) {
      d.engineCalls += 1;
      if (engineFailure) throw engineFailure;
      onProgress = typeof options === 'string' ? undefined : options.onProgress;
      markEngineReady();
      return engine;
    },
    WebGPUUnavailableError: class extends Error {},
  };

  const chatModule: BitGpuChatModule = {
    async createChat() {
      d.chatCalls += 1;
      return {
        async send(messages, options) {
          d.sends.push({ messages, options });
          return { text: 'reply', finishReason: d.finishReason };
        },
        async *stream(messages, options) {
          d.streams.push({ messages, options });
          for (const delta of d.streamDeltas) yield delta;
          return {
            text: d.streamDeltas.join(''),
            finishReason: d.finishReason,
          };
        },
      };
    },
  };

  return {
    options: {
      loadBitGpu: async () => bitgpu,
      loadChat: async () => chatModule,
    },
    d,
  };
}

async function expectPathError(
  run: () => Promise<unknown>,
  code: InferencePathError['code'],
): Promise<void> {
  const error = await run().then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toMatchObject({ name: 'InferencePathError', code });
}

const USER = [{ role: 'user', content: 'hi' }] as const;

describe('createBitGpuInferenceBackend', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...globalThis.navigator },
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    }
  });

  it('reports unavailable without WebGPU', () => {
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    expect(backend.status).toBe('unavailable');
    expect(backend.kind).toBe('local');
  });

  it('refuses to load without WebGPU rather than starting a doomed download', async () => {
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    await expectPathError(() => backend.load(), 'no_usable_backend');
    expect(d.engineCalls).toBe(0);
  });

  it('reports idle before load and ready after', async () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    expect(backend.status).toBe('idle');
    await backend.load();
    expect(backend.status).toBe('ready');
  });

  it('reports loading before the first await resolves', () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    // `idle` is the state auto-selection is told to skip, so the window between
    // clicking Load and the engine resolving must not report it.
    void backend.load();
    expect(backend.status).toBe('loading');
  });

  it('maps a bytes report onto the mirrored progress shape', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    const seen: InferenceProgress[] = [];
    const load = backend.load((p) => seen.push(p));
    await d.whenEngineReady;
    d.emitProgress({ phase: 'weights', loaded: 50, total: 200 });

    expect(backend.progress).toMatchObject({
      state: 'downloading',
      bytesLoaded: 50,
      bytesTotal: 200,
      percent: 25,
      currentFile: 'weights',
    });
    await load;

    expect(seen[0]).toMatchObject({ percent: 25 });
    // Cleared once the model is usable.
    expect(backend.progress).toBeUndefined();
  });

  it('reports the pipeline phase as unpacking, without inventing a percent', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    const load = backend.load();
    await d.whenEngineReady;
    d.emitProgress({ phase: 'pipelines' });

    expect(backend.progress).toMatchObject({ state: 'extracting', percent: 0 });
    await load;
  });

  it('reports error status and the failure when a load rejects', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    d.failEngine(new Error('out of GPU memory'));
    const backend = createBitGpuInferenceBackend(options);

    await expect(backend.load()).rejects.toThrow('out of GPU memory');
    expect(backend.status).toBe('error');
    expect(backend.progress).toMatchObject({
      state: 'error',
      error: 'out of GPU memory',
    });
  });

  it('re-enters on a retry after a failed load', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    d.failEngine(new Error('transient'));
    const backend = createBitGpuInferenceBackend(options);

    await expect(backend.load()).rejects.toThrow('transient');

    d.failEngine(null);
    await backend.load();

    // The second attempt must start a new engine, not replay the rejection.
    expect(d.engineCalls).toBe(2);
    expect(backend.status).toBe('ready');
  });

  it('shares one load between concurrent callers', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    await Promise.all([backend.load(), backend.load(), backend.load()]);
    expect(d.engineCalls).toBe(1);
  });

  it('is a no-op when the engine is already ready', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    await backend.load();
    expect(d.engineCalls).toBe(1);

    // `load` is documented as a no-op when already ready. A second call that
    // re-entered would fetch the weights again and orphan the live engine,
    // since nothing disposes the reference it replaces.
    await backend.load();

    expect(d.engineCalls).toBe(1);
    expect(d.chatCalls).toBe(1);
    expect(d.disposed).toBe(0);
    expect(backend.status).toBe('ready');
  });

  it('retries after a loader that throws synchronously', async () => {
    withWebGpu();
    const { options } = makeModules();
    let failing = true;
    const backend = createBitGpuInferenceBackend({
      ...options,
      loadBitGpu: () => {
        // Synchronous, not a rejected promise: legal for the declared
        // `() => Promise<BitGpuModule>` and what an absent module shim does.
        if (failing) throw new Error('bitgpu is not installed');
        return options.loadBitGpu();
      },
    });

    await expect(backend.load()).rejects.toThrow('bitgpu is not installed');
    expect(backend.status).toBe('error');

    failing = false;
    await backend.load();

    // A synchronous throw settles the load body before it is stored, so a
    // cached rejection here would replay on every later attempt.
    expect(backend.status).toBe('ready');
  });

  it('discards a load that overlaps an unload', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    const pending = backend.load();
    await backend.unload();
    await pending;

    // Publishing the engine here would report `ready` with a live GPU device
    // nothing disposes, and a later `load()` would no-op on it.
    expect(backend.status).toBe('idle');
    expect(d.disposed).toBe(1);
  });

  it('stays idle when a load rejects after an unload', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    d.failEngine(new Error('out of GPU memory'));
    const backend = createBitGpuInferenceBackend(options);

    const pending = backend.load();
    await backend.unload();
    await expect(pending).rejects.toThrow('out of GPU memory');

    // The caller cancelled the work, so the backend must not report an error
    // for it — and `unload()` already cleared any prior failure.
    expect(backend.status).toBe('idle');
    expect(backend.progress).toBeUndefined();
  });

  it('refuses a turn before load, naming what is missing', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);

    await expectPathError(() => backend.chat([...USER]), 'no_usable_backend');
    expect(d.sends).toEqual([]);
  });

  it('forwards messages and options, and maps the result', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    const response = await backend.chat([...USER], {
      maxTokens: 64,
      temperature: 0.4,
      topP: 0.9,
      stop: 'END',
    });

    expect(d.sends[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(d.sends[0].options).toMatchObject({
      maxTokens: 64,
      temperature: 0.4,
      topP: 0.9,
      // bitgpu takes an array of stop sequences; a scalar is normalized.
      stopSequences: ['END'],
    });
    expect(response).toEqual({ content: 'reply', finishReason: 'stop' });
  });

  it('omits an abort finish reason the mirrored response has no member for', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    d.finishReason = 'abort';
    // `AIResponse.finishReason` has no `'abort'` member — a completed response
    // simply carries none rather than inventing one.
    await expect(backend.chat([...USER])).resolves.toEqual({
      content: 'reply',
    });
  });

  it('forwards the caller signal — the one thing WebLLM cannot do', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    const controller = new AbortController();
    for await (const _chunk of backend.stream([...USER], {
      signal: controller.signal,
    })) {
      /* drain */
    }

    expect(d.streams[0].options).toMatchObject({ signal: controller.signal });
  });

  it('streams deltas in order and reports each to onProgress', async () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    const onProgress = vi.fn();
    const chunks: string[] = [];
    for await (const chunk of backend.stream([...USER], { onProgress })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(onProgress.mock.calls).toEqual([['Hel'], ['lo']]);
  });

  it('refuses tool definitions and tool turns, like every other backend', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    // bitgpu supports tools, but exposing them here would mean a per-call switch
    // changes what a turn means: the other backends refuse these.
    await expectPathError(
      () =>
        backend.chat([...USER], {
          tools: [{ type: 'function', function: { name: 'product_list' } }],
        }),
      'unsupported_message',
    );
    await expectPathError(
      () =>
        backend.chat([
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'x', arguments: '{}' },
              },
            ],
          },
        ]),
      'unsupported_message',
    );
    expect(d.sends).toEqual([]);
  });

  it('disposes the engine and returns to idle on unload', async () => {
    withWebGpu();
    const { options, d } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();

    await backend.unload();

    expect(d.disposed).toBe(1);
    expect(backend.status).toBe('idle');
    expect(backend.progress).toBeUndefined();
  });

  it('refuses a turn after unload', async () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    await backend.load();
    await backend.unload();

    await expectPathError(() => backend.chat([...USER]), 'no_usable_backend');
  });

  it('notifies subscribers on each status change', async () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    const listener = vi.fn();
    const unsubscribe = backend.subscribe(listener);

    await backend.load();
    await backend.unload();

    // Three status changes: idle→loading, loading→ready, ready→idle.
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it('stops notifying after unsubscribe', async () => {
    withWebGpu();
    const { options } = makeModules();
    const backend = createBitGpuInferenceBackend(options);
    const listener = vi.fn();
    backend.subscribe(listener)();

    await backend.load();
    expect(listener).not.toHaveBeenCalled();
  });
});
