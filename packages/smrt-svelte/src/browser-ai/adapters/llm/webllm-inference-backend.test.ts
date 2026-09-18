/**
 * The local (`webllm`) inference backend.
 *
 * Two invariants this suite exists to pin:
 *
 * 1. **An unusable local backend reports `unavailable`, not `idle`.** The path
 *    only auto-selects `ready`, so a device without WebGPU must not sit in a
 *    state a caller might promote — and `load()` on one must fail rather than
 *    start a download that can never work.
 * 2. **A turn the adapter cannot represent is refused, not degraded.** The
 *    adapter is a text-only conversation contract; silently rewriting a `tool`
 *    observation or dropping `options.tools` would let a model answer as
 *    though it had seen context (or tools) it never received.
 */

import type {
  InferencePathError,
  InferenceProgress,
} from '@happyvertical/smrt-web/ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InitState, OnProgress } from '../../core/types.js';
import type { LLMAdapter, LLMChatOptions, LLMMessage } from './types.js';

const getLLMMock = vi.hoisted(() => vi.fn());
vi.mock('./factory.js', () => ({ getLLM: getLLMMock }));

import { createWebLlmInferenceBackend } from './webllm-inference-backend.js';

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

interface AdapterDouble extends LLMAdapter {
  calls: {
    ensure: Array<string | undefined>;
    chat: Array<{ messages: LLMMessage[]; options?: LLMChatOptions }>;
    stream: Array<{ messages: LLMMessage[]; options?: LLMChatOptions }>;
    unload: number;
  };
  /** Drive the adapter's init state from a test. */
  setInitState(state: InitState): void;
  /** Reject the next `chat`/`stream` from the adapter. */
  fail(error: Error): void;
}

function makeAdapter(): AdapterDouble {
  let initState: InitState = 'uninitialized';
  let failure: Error | null = null;
  const calls: AdapterDouble['calls'] = {
    ensure: [],
    chat: [],
    stream: [],
    unload: 0,
  };

  return {
    type: 'webllm',
    get initState() {
      return initState;
    },
    currentModel: null,
    calls,
    setInitState(state) {
      initState = state;
    },
    fail(error) {
      failure = error;
    },
    async ensureInitialized(modelId?: string, onProgress?: OnProgress) {
      calls.ensure.push(modelId);
      initState = 'initializing';
      onProgress?.({
        state: 'downloading',
        bytesLoaded: 10,
        bytesTotal: 40,
        percent: 25,
      });
      initState = 'ready';
    },
    async chat(messages: LLMMessage[], options?: LLMChatOptions) {
      calls.chat.push({ messages, options });
      if (failure) throw failure;
      return {
        content: 'reply',
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        model: 'm',
        finishReason: 'stop' as const,
      };
    },
    async *stream(messages: LLMMessage[], options?: LLMChatOptions) {
      calls.stream.push({ messages, options });
      options?.onToken?.('a');
      yield 'a';
    },
    async unloadModel() {
      calls.unload += 1;
      initState = 'uninitialized';
    },
    async dispose() {},
  } as AdapterDouble;
}

function progressOf(backend: { progress?: InferenceProgress }) {
  return backend.progress;
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

describe('createWebLlmInferenceBackend', () => {
  beforeEach(() => {
    // Default jsdom navigator: no `gpu`, so the backend is unavailable.
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...globalThis.navigator },
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    }
    vi.unstubAllGlobals();
  });

  it('reports unavailable without WebGPU, so auto-selection skips it', () => {
    const backend = createWebLlmInferenceBackend({ adapter: makeAdapter() });
    expect(backend.status).toBe('unavailable');
    expect(backend.kind).toBe('local');
  });

  it('defaults its id to "local" and accepts an override', () => {
    expect(createWebLlmInferenceBackend().id).toBe('local');
    expect(createWebLlmInferenceBackend({ id: 'on-device' }).id).toBe(
      'on-device',
    );
  });

  it('reports idle before a load, ready after, once WebGPU exists', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    expect(backend.status).toBe('idle');
    await backend.load();
    expect(backend.status).toBe('ready');
  });

  it('refuses to load without WebGPU rather than starting a doomed download', async () => {
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    await expectPathError(() => backend.load(), 'no_usable_backend');
    expect(adapter.calls.ensure).toEqual([]);
  });

  it('exposes adapter progress during a load and clears it after', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    let during: InferenceProgress | undefined;
    const load = backend.load(() => {
      during = progressOf(backend);
    });
    await load;

    expect(during).toMatchObject({ percent: 25, bytesLoaded: 10 });
    expect(progressOf(backend)).toBeUndefined();
  });

  it('forwards the requested model to the adapter', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({
      adapter,
      model: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    });

    await backend.load();
    expect(adapter.calls.ensure).toEqual(['SmolLM2-360M-Instruct-q4f16_1-MLC']);
  });

  it('reports loading while a load is in flight', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    // The gate is built before `load()` so the resolver exists synchronously —
    // `ensureAdapter()` is async, so the adapter's own promise is created a
    // tick later and a deferred resolver assigned inside it would not exist
    // yet.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    adapter.ensureInitialized = async () => {
      await gate;
      adapter.setInitState('ready');
    };
    const backend = createWebLlmInferenceBackend({ adapter });

    const load = backend.load();
    // The adapter has not flipped `initState` yet; status must still say so.
    expect(backend.status).toBe('loading');
    release();
    await load;
    expect(backend.status).toBe('ready');
  });

  it('reports error status when the adapter failed', () => {
    withWebGpu();
    const adapter = makeAdapter();
    adapter.setInitState('error');
    expect(createWebLlmInferenceBackend({ adapter }).status).toBe('error');
  });

  it('refuses tool definitions on both chat and stream', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });
    const messages = [{ role: 'user', content: 'hi' }] as const;
    const tools = [
      { type: 'function', function: { name: 'product_list' } },
    ] as const;

    await expectPathError(
      () => backend.chat([...messages], { tools: [...tools] }),
      'unsupported_message',
    );
    await expectPathError(async () => {
      for await (const _chunk of backend.stream([...messages], {
        tools: [...tools],
      })) {
        /* drain */
      }
    }, 'unsupported_message');
    // Neither refusal may reach the adapter.
    expect(adapter.calls.chat).toEqual([]);
    expect(adapter.calls.stream).toEqual([]);
  });

  it('refuses a tool-role message rather than rewriting it', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    await expectPathError(
      () =>
        backend.chat([
          { role: 'user', content: 'hi' },
          { role: 'tool', content: '{"rows":[]}' },
        ]),
      'unsupported_message',
    );
    expect(adapter.calls.chat).toEqual([]);
  });

  it('refuses a message carrying tool_calls rather than dropping the record', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    // The old mapper inspected only `role` and `content`, so this shape was
    // accepted and its tool calls silently discarded — the model would then
    // answer as though the call had never happened.
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
                function: { name: 'product_list', arguments: '{}' },
              },
            ],
          },
        ]),
      'unsupported_message',
    );
    expect(adapter.calls.chat).toEqual([]);
  });

  it('refuses a toolChoice even with no tools listed', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    await expectPathError(
      () =>
        backend.chat([{ role: 'user', content: 'hi' }], {
          toolChoice: 'none',
        }),
      'unsupported_message',
    );
    await expectPathError(async () => {
      for await (const _chunk of backend.stream(
        [{ role: 'user', content: 'hi' }],
        { toolChoice: 'auto' },
      )) {
        /* drain */
      }
    }, 'unsupported_message');
    expect(adapter.calls.chat).toEqual([]);
    expect(adapter.calls.stream).toEqual([]);
  });

  it('refuses multimodal content rather than dropping it', async () => {
    withWebGpu();
    const backend = createWebLlmInferenceBackend({ adapter: makeAdapter() });

    await expectPathError(
      () =>
        backend.chat([
          {
            role: 'user',
            content: [{ type: 'text', text: 'look' }],
          },
        ]),
      'unsupported_message',
    );
  });

  it('passes text messages through unchanged and maps the response', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    const response = await backend.chat([{ role: 'user', content: 'hi' }]);
    expect(adapter.calls.chat[0].messages).toEqual([
      { role: 'user', content: 'hi' },
    ]);
    expect(response).toEqual({
      content: 'reply',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      model: 'm',
      finishReason: 'stop',
    });
  });

  it('omits a finish reason the mirrored response has no member for', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    adapter.chat = async () => ({
      content: 'partial',
      finishReason: 'error' as const,
    });
    const backend = createWebLlmInferenceBackend({ adapter });

    // `AIResponse.finishReason` has no `'error'` member; a completed response
    // simply carries none rather than inventing a value.
    await expect(
      backend.chat([{ role: 'user', content: 'hi' }]),
    ).resolves.toEqual({ content: 'partial' });
  });

  it('routes onProgress to the adapter token sink and forwards options', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });
    const onProgress = vi.fn();

    const chunks: string[] = [];
    for await (const chunk of backend.stream(
      [{ role: 'user', content: 'hi' }],
      {
        temperature: 0.4,
        maxTokens: 12,
        topP: 0.9,
        stop: 'END',
        onProgress,
      },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['a']);
    expect(onProgress).toHaveBeenCalledWith('a');
    expect(adapter.calls.stream[0].options).toMatchObject({
      temperature: 0.4,
      maxTokens: 12,
      topP: 0.9,
      // The adapter takes `string[]`; a scalar caller value is normalized.
      stop: ['END'],
      onToken: onProgress,
    });
  });

  it('clears progress and returns to idle on unload', async () => {
    withWebGpu();
    const adapter = makeAdapter();
    const backend = createWebLlmInferenceBackend({ adapter });

    await backend.load();
    await backend.unload();
    expect(adapter.calls.unload).toBe(1);
    expect(progressOf(backend)).toBeUndefined();
    expect(backend.status).toBe('idle');
  });

  it('notifies subscribers on a load transition', async () => {
    withWebGpu();
    const backend = createWebLlmInferenceBackend({ adapter: makeAdapter() });
    const listener = vi.fn();
    const unsubscribe = backend.subscribe(listener);

    await backend.load();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('unsubscribing stops notifications', async () => {
    withWebGpu();
    const backend = createWebLlmInferenceBackend({ adapter: makeAdapter() });
    const listener = vi.fn();
    backend.subscribe(listener)();

    await backend.load();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createWebLlmInferenceBackend adapter construction', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { ...globalThis.navigator, gpu: {} },
      configurable: true,
    });
    getLLMMock.mockReset();
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    }
  });

  it('forwards a supplied module loader to the adapter factory', async () => {
    const adapter = makeAdapter();
    getLLMMock.mockResolvedValue(adapter);
    const loadModule = () => Promise.resolve({ CreateMLCEngine: vi.fn() });

    // A browser cannot resolve a bare specifier, so this passthrough is the
    // only way a host that owns `@mlc-ai/web-llm` can make the local backend
    // work at all.
    await createWebLlmInferenceBackend({ loadModule }).chat([
      { role: 'user', content: 'hi' },
    ]);

    expect(getLLMMock).toHaveBeenCalledWith({ loadModule });
  });

  it('constructs the adapter once for concurrent callers', async () => {
    const adapter = makeAdapter();
    getLLMMock.mockResolvedValue(adapter);
    const backend = createWebLlmInferenceBackend({});

    await Promise.all([
      backend.chat([{ role: 'user', content: 'a' }]),
      backend.chat([{ role: 'user', content: 'b' }]),
      backend.load(),
    ]);

    // Two callers must not each build an unshared adapter — and, with it, start
    // a second multi-hundred-megabyte download.
    expect(getLLMMock).toHaveBeenCalledTimes(1);
  });
});
