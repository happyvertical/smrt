/**
 * An `InferenceBackend` over a browser LLM adapter.
 *
 * This is the local half of the inference path: it exposes whatever the
 * adapter layer can actually do — text generation with load/progress — and
 * refuses, loudly, the shapes it cannot faithfully represent rather than
 * quietly degrading them.
 *
 * ## What the local backend cannot do, and says so
 *
 * `LLMAdapter` (`./types.js`) is a TEXT conversation contract:
 * `LLMMessage.role` is `'system' | 'user' | 'assistant'`, `content` is a
 * `string`, and `LLMChatOptions` carries no `tools`. So this backend runs
 * {@link assertTextOnlyTurn} — the SAME check the route backend runs — and
 * throws `InferencePathError` (`code: 'unsupported_message'`) for a
 * `tool`/`function` message, a message carrying `tool_calls`, non-string
 * content, or any tool definition/choice. Those turns belong on a backend that
 * supports them: a silent rewrite would let a model answer as though it had
 * seen context (or tools) it never received, and the two backends must agree
 * on which turns they accept or a per-call switch changes the answer.
 *
 * `signal` and `timeout` are NOT honored: the adapter has no cancellation
 * seam, so a local generation runs to completion once started. That wastes GPU
 * time but cannot produce a wrong answer, so it degrades rather than throws.
 *
 * ## Adapter ownership
 *
 * Pass `adapter` to share the app-managed one (the warm-client cache and
 * `SmrtAppStateManager.initializeLLM` own a single adapter per
 * `type:model` — `src/state/warm-clients.ts`). Omitting it constructs an
 * unshared adapter via `getLLM()`, which will NOT deduplicate against that
 * cache; this module cannot reach the cache itself, because `state/` depends
 * on `browser-ai/` and not the other way round.
 *
 * @module
 */

import {
  assertTextOnlyTurn,
  type InferenceBackend,
  type InferenceBackendStatus,
  type InferenceChatOptions,
  InferencePathError,
  type InferenceProgress,
  type InferenceResponse,
  type InferenceTextMessage,
} from '@happyvertical/smrt-web/ai';
import { detectCapabilities } from '../../capabilities/detector.js';
import { getLLM } from './factory.js';
import type {
  LLMAdapter,
  LLMChatOptions,
  LLMMessage,
  WebLLMOptions,
} from './types.js';

export interface WebLlmInferenceBackendOptions {
  /**
   * The adapter to drive. Supply the app-state-managed adapter so loading
   * shares the warm-client cache; omit to construct an unshared one.
   */
  adapter?: LLMAdapter;
  /** Backend id. Defaults to `'local'`. */
  id?: string;
  /** Model to ensure on `load()`. Adapter default when omitted. */
  model?: string;
  /** Passed through to `getLLM()` when no `adapter` is supplied. */
  appConfig?: Record<string, unknown>;
  /**
   * Supplies the `@mlc-ai/web-llm` module namespace, passed through to the
   * adapter. A browser can only resolve a STATIC specifier, so a host that has
   * the dependency should pass `() => import('@mlc-ai/web-llm')`.
   */
  loadModule?: () => Promise<unknown>;
}

/** Map an adapter's init state onto the path's backend status. */
function toBackendStatus(adapter: LLMAdapter | null): InferenceBackendStatus {
  if (!adapter) return 'idle';
  switch (adapter.initState) {
    case 'ready':
      return 'ready';
    case 'initializing':
      return 'loading';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/**
 * Project an already-validated turn into the adapter's message shape.
 *
 * The caller runs {@link assertTextOnlyTurn} first, which is what narrows
 * `messages` to a text turn — this function must not be the place the check
 * lives, or the two backends' rules drift apart.
 */
function toAdapterMessages(messages: InferenceTextMessage[]): LLMMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}

/** Forward only the options the adapter can honor. */
function toAdapterOptions(options?: InferenceChatOptions): LLMChatOptions {
  return {
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.maxTokens !== undefined
      ? { maxTokens: options.maxTokens }
      : {}),
    ...(options?.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options?.topP !== undefined ? { topP: options.topP } : {}),
    ...(options?.stop
      ? { stop: Array.isArray(options.stop) ? options.stop : [options.stop] }
      : {}),
    ...(options?.onProgress ? { onToken: options.onProgress } : {}),
  };
}

/**
 * A local backend over a browser LLM adapter.
 *
 * `status` reports `'unavailable'` without WebGPU, so an `auto` path skips it
 * instead of attempting a multi-gigabyte download on a device that cannot run
 * the result. `load()` must be called (by a control, or by the caller) before
 * the backend reports `'ready'`.
 */
export function createWebLlmInferenceBackend(
  options: WebLlmInferenceBackendOptions = {},
): InferenceBackend {
  let adapter: LLMAdapter | null = options.adapter ?? null;
  let progress: InferenceProgress | undefined;
  const listeners = new Set<() => void>();
  let loading: Promise<LLMAdapter> | null = null;
  // The adapter flips `initState` to `'initializing'` only after its own
  // awaits, so relying on that alone would report `'idle'` while a load is
  // genuinely in flight — and `'idle'` is the state auto-selection must skip.
  let loadInFlight = false;

  function broadcast(): void {
    for (const listener of [...listeners]) listener();
  }

  function currentStatus(): InferenceBackendStatus {
    // WebLLM is the only adapter this backend constructs by default, and it
    // cannot run at all without WebGPU. Report `unavailable` up front rather
    // than `idle`, so nothing tries to load a model that can never work.
    const effectiveType = adapter?.type ?? 'webllm';
    if (effectiveType === 'webllm' && !detectCapabilities().llm.webgpu) {
      return 'unavailable';
    }
    if (loadInFlight) return 'loading';
    return toBackendStatus(adapter);
  }

  async function ensureAdapter(): Promise<LLMAdapter> {
    if (adapter) return adapter;
    // Concurrent `load()`/`chat()` calls share one construction, so two
    // callers cannot each start an unshared adapter (and its download).
    loading ??= (async () => {
      const { appConfig, loadModule } = options;
      const created = await getLLM({
        ...(appConfig ? { appConfig } : {}),
        ...(loadModule ? { loadModule } : {}),
      } as WebLLMOptions);
      adapter = created;
      return created;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  return {
    id: options.id ?? 'local',
    kind: 'local',

    get status() {
      return currentStatus();
    },

    get progress() {
      return progress;
    },

    async load(onProgress) {
      if (currentStatus() === 'unavailable') {
        throw new InferencePathError(
          'WebLLM requires WebGPU, which this browser does not expose.',
          'no_usable_backend',
        );
      }
      // Marked before the first `await`: a caller that reads `status`
      // immediately after calling `load()` must not see `'idle'`, which is
      // exactly the state auto-selection is told to skip.
      loadInFlight = true;
      broadcast();
      try {
        const target = await ensureAdapter();
        await target.ensureInitialized(options.model, (next) => {
          progress = next;
          onProgress?.(next);
          broadcast();
        });
        progress = undefined;
      } finally {
        loadInFlight = false;
        broadcast();
      }
    },

    async unload() {
      await adapter?.unloadModel();
      progress = undefined;
      broadcast();
    },

    async chat(messages, chatOptions) {
      assertTextOnlyTurn('The browser LLM adapter', messages, chatOptions);
      const target = await ensureAdapter();
      const response = await target.chat(
        toAdapterMessages(messages),
        toAdapterOptions(chatOptions),
      );
      return {
        content: response.content,
        ...(response.usage ? { usage: response.usage } : {}),
        ...(response.model ? { model: response.model } : {}),
        // The adapter also reports `'error'`, which `AIResponse` has no member
        // for — a failed call is carried by a thrown error on that contract,
        // so a completed response simply has no finish reason here.
        ...(response.finishReason === 'stop' ||
        response.finishReason === 'length'
          ? { finishReason: response.finishReason }
          : {}),
      } satisfies InferenceResponse;
    },

    async *stream(messages, chatOptions) {
      assertTextOnlyTurn('The browser LLM adapter', messages, chatOptions);
      const target = await ensureAdapter();
      yield* target.stream(
        toAdapterMessages(messages),
        toAdapterOptions(chatOptions),
      );
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
