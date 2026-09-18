/**
 * An `InferenceBackend` over `bitgpu` — a WebGPU runtime for 1-bit (binary-weight)
 * LLMs in the browser.
 *
 * ## Why this engine and not WebLLM
 *
 * `bitgpu` (MIT, zero runtime dependencies) is the engine behind the Bonsai
 * WebGPU demo PrismML's own docs list as their in-browser option, and it is the
 * one browser runtime in this package that can honor `signal`: its
 * `ChatSendOptions.signal` aborts a generation in flight, which the WebLLM
 * adapter has no seam for. It also reports load progress by phase and reuses the
 * KV cache across turns.
 *
 * ## What this backend does not expose (yet)
 *
 * `bitgpu` supports tool calling, JSON-schema-constrained decoding, thinking
 * budgets and vision. This backend deliberately exposes only the TEXT subset
 * that {@link assertTextOnlyTurn} enforces, so that switching backend per call
 * never changes what a turn means: the WebLLM and route backends refuse tool
 * turns, and a backend that silently accepted them would break that invariant.
 * Widening this is a deliberate follow-up, not an oversight.
 *
 * `model` in {@link InferenceChatOptions} is ignored: one engine is bound to one
 * model (`createEngine`), so a per-call model id has nothing to select.
 *
 * ## Loading
 *
 * Unlike the WebLLM backend, `chat`/`stream` do NOT lazily load. Weights for
 * these models run from hundreds of MB to multiple GB, so an implicit download
 * behind the first turn would be hostile; a caller must `load()` first (the path
 * only auto-selects a backend whose status is `ready`, so `auto` already
 * requires it). Calling a turn before loading fails with a clear message.
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
} from '@happyvertical/smrt-web/ai';
import { detectCapabilities } from '../../capabilities/detector.js';

// ---------------------------------------------------------------------------
// The slice of `bitgpu` this backend consumes, declared structurally.
//
// `bitgpu` is an OPTIONAL peer dependency, so its types must not enter this
// package's public surface. These locals describe only the shapes used here,
// the same convention `webllm.ts` follows for `@mlc-ai/web-llm`.
// ---------------------------------------------------------------------------

/** Mirrors `LoadProgress`. Exported so a host or test can type the callback. */
export interface BitGpuLoadProgress {
  phase: 'manifest' | 'weights' | 'pipelines';
  loaded?: number;
  total?: number;
}

/** Mirrors `ChatMessage`. */
interface BitGpuMessage {
  role: string;
  content: string;
}

/** Mirrors `ChatResult`. */
interface BitGpuChatResult {
  text: string;
  finishReason: 'stop' | 'length' | 'abort' | 'tool_calls';
}

/** Mirrors `ChatSendOptions` (only the fields this backend forwards). */
interface BitGpuSendOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

interface BitGpuEngine {
  dispose(): void;
}

interface BitGpuChat {
  send(
    messages: BitGpuMessage[],
    options?: BitGpuSendOptions,
  ): Promise<BitGpuChatResult>;
  /** Deltas, with the final result as the generator's return value. */
  stream(
    messages: BitGpuMessage[],
    options?: BitGpuSendOptions,
  ): AsyncGenerator<string, BitGpuChatResult>;
}

/** The `bitgpu` entry point (`createEngine`, errors). */
export interface BitGpuModule {
  createEngine(
    options:
      | string
      | {
          modelUrl?: string;
          manifestUrl?: string;
          dataUrl?: string;
          auxUrl?: string;
          maxSeqLen?: number;
          kvCache?: 'f32' | 'f16' | 'q8';
          onProgress?: (progress: BitGpuLoadProgress) => void;
        },
  ): Promise<BitGpuEngine>;
  WebGPUUnavailableError: new (message: string) => Error;
}

/** The `bitgpu/chat` entry point. */
export interface BitGpuChatModule {
  createChat(
    engine: BitGpuEngine,
    options: {
      modelUrl?: string;
      tokenizerJsonUrl?: string;
      tokenizerConfigUrl?: string;
    },
  ): Promise<BitGpuChat>;
}

export interface BitGpuInferenceBackendOptions {
  /** Backend id. Defaults to `'bitgpu'`. */
  id?: string;
  /** Model directory holding `manifest.json` plus its data/aux files. */
  modelUrl?: string;
  /** Explicit URLs, when they are not colocated. */
  manifestUrl?: string;
  dataUrl?: string;
  auxUrl?: string;
  /** Tokenizer files; default to `modelUrl` when omitted. */
  tokenizerJsonUrl?: string;
  tokenizerConfigUrl?: string;
  /** KV window. Larger costs more GPU memory. */
  maxSeqLen?: number;
  /** KV cache precision. `q8` trades a little quality for context length. */
  kvCache?: 'f32' | 'f16' | 'q8';
  /**
   * Supplies the `bitgpu` entry point (`createEngine`).
   *
   * Required, not optional: `bitgpu` is an OPTIONAL peer dependency, so a static
   * import here would fail the build for every consumer that has not installed
   * it — and a bare specifier is not resolvable by a browser at runtime either.
   * The host supplies a static import from its own code, where the bundler can
   * see it: `() => import('bitgpu')`.
   */
  loadBitGpu: () => Promise<BitGpuModule>;
  /** Supplies the `bitgpu/chat` entry point. See {@link BitGpuInferenceBackendOptions.loadBitGpu}. */
  loadChat: () => Promise<BitGpuChatModule>;
}

const BACKEND_LABEL = 'The bitgpu backend';

/** `bitgpu`'s load phases mapped onto the mirrored progress states. */
const PROGRESS_STATE: Record<
  BitGpuLoadProgress['phase'],
  InferenceProgress['state']
> = {
  // Fetching the manifest and the weights is one continuous download from the
  // caller's point of view.
  manifest: 'downloading',
  weights: 'downloading',
  // Building the WGSL pipelines is the closest analogue to unpacking.
  pipelines: 'extracting',
};

/**
 * Map a bitgpu load report onto {@link InferenceProgress}.
 *
 * `loaded`/`total` are bytes when the engine reports them; when it reports only
 * a phase, the percent stays 0 and `currentFile` names the phase instead.
 */
function toProgress(report: BitGpuLoadProgress): InferenceProgress {
  const total = report.total ?? 0;
  const loaded = report.loaded ?? 0;
  return {
    state: PROGRESS_STATE[report.phase] ?? 'downloading',
    bytesLoaded: loaded,
    bytesTotal: total,
    percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
    currentFile: report.phase,
  };
}

/** Forward only the options the engine can honor. */
function toSendOptions(options?: InferenceChatOptions): BitGpuSendOptions {
  const stop = options?.stop;
  return {
    ...(options?.maxTokens !== undefined
      ? { maxTokens: options.maxTokens }
      : {}),
    ...(options?.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
    ...(options?.topP !== undefined ? { topP: options.topP } : {}),
    ...(stop ? { stopSequences: Array.isArray(stop) ? stop : [stop] } : {}),
    // The one option WebLLM cannot honor: bitgpu aborts a live generation.
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

/**
 * A local backend over `bitgpu`.
 *
 * `status` reports `'unavailable'` without WebGPU, so an `auto` path skips it
 * rather than starting a multi-gigabyte download on a device that cannot run the
 * result. `load()` must be called before a turn; see the module header.
 */
export function createBitGpuInferenceBackend(
  options: BitGpuInferenceBackendOptions,
): InferenceBackend {
  let engine: BitGpuEngine | null = null;
  let chat: BitGpuChat | null = null;
  let progress: InferenceProgress | undefined;
  let loadError: Error | null = null;
  let loadInFlight = false;
  let loading: Promise<void> | null = null;
  // Bumped by `unload()`. A load captures it before its first `await` and
  // re-checks it afterwards, so a load that overlaps an `unload()` discards the
  // engine it built instead of publishing it and reporting `ready`.
  let loadEpoch = 0;
  const listeners = new Set<() => void>();

  function broadcast(): void {
    for (const listener of [...listeners]) listener();
  }

  function currentStatus(): InferenceBackendStatus {
    if (!detectCapabilities().llm.webgpu) return 'unavailable';
    if (loadError) return 'error';
    if (loadInFlight) return 'loading';
    if (engine && chat) return 'ready';
    return 'idle';
  }

  /** The loaded chat, or a failure naming what the caller forgot to do. */
  function requireChat(): BitGpuChat {
    if (!chat) {
      throw new InferencePathError(
        `${BACKEND_LABEL} has no loaded model. Call load() first — weights are too large to fetch behind the first turn.`,
        'no_usable_backend',
      );
    }
    return chat;
  }

  return {
    id: options.id ?? 'bitgpu',
    kind: 'local',

    get status() {
      return currentStatus();
    },

    get progress() {
      return progress;
    },

    load(onProgress) {
      // Marked before the first await: reading `status` immediately after
      // calling `load()` must not report `idle`, the state auto-selection skips.
      if (currentStatus() === 'unavailable') {
        return Promise.reject(
          new InferencePathError(
            'bitgpu requires WebGPU, which this browser does not expose.',
            'no_usable_backend',
          ),
        );
      }
      // No-op when already ready — the documented contract for `load`. Without
      // this, a second call fetches the weights again (hundreds of MB) and
      // overwrites `engine` without disposing it, leaving two live WebGPU
      // engines, while `status` flickers through `loading` and an `auto` path
      // stops selecting this backend.
      if (engine && chat) return Promise.resolve();
      if (loading) return loading;

      loadInFlight = true;
      loadError = null;
      broadcast();

      // Captured before the first `await` below; every step that could publish
      // state re-checks it, because `unload()` may run while this is in flight.
      const epoch = loadEpoch;
      const pending = (async () => {
        try {
          const [bitgpu, chatModule] = await Promise.all([
            options.loadBitGpu(),
            options.loadChat(),
          ]);
          const created = await bitgpu.createEngine({
            ...(options.modelUrl ? { modelUrl: options.modelUrl } : {}),
            ...(options.manifestUrl
              ? { manifestUrl: options.manifestUrl }
              : {}),
            ...(options.dataUrl ? { dataUrl: options.dataUrl } : {}),
            ...(options.auxUrl ? { auxUrl: options.auxUrl } : {}),
            ...(options.maxSeqLen !== undefined
              ? { maxSeqLen: options.maxSeqLen }
              : {}),
            ...(options.kvCache ? { kvCache: options.kvCache } : {}),
            onProgress: (report) => {
              // A download that outlives an `unload()` must not resurrect
              // progress on a backend the caller has just released.
              if (epoch !== loadEpoch) return;
              progress = toProgress(report);
              onProgress?.(progress);
              broadcast();
            },
          });
          // The tokenizer resolves from `modelUrl` unless told otherwise; both
          // sides of the split are surfaced so a host can host them apart.
          const createdChat = await chatModule.createChat(created, {
            ...(options.modelUrl ? { modelUrl: options.modelUrl } : {}),
            ...(options.tokenizerJsonUrl
              ? { tokenizerJsonUrl: options.tokenizerJsonUrl }
              : {}),
            ...(options.tokenizerConfigUrl
              ? { tokenizerConfigUrl: options.tokenizerConfigUrl }
              : {}),
          });
          if (epoch !== loadEpoch) {
            // `unload()` ran while these were being created. Publishing them
            // would report `ready` with a live GPU device nothing disposes, and
            // a later `load()` would no-op on it.
            created.dispose();
            return;
          }
          engine = created;
          chat = createdChat;
          progress = undefined;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          // A failure that overlaps an `unload()` leaves the backend idle
          // rather than reporting an error for work the caller cancelled.
          if (epoch === loadEpoch) {
            loadError = err;
            // Keep whatever the load had reported so a caller can see how far
            // it got, and mark it failed.
            progress = {
              bytesLoaded: progress?.bytesLoaded ?? 0,
              bytesTotal: progress?.bytesTotal ?? 0,
              percent: progress?.percent ?? 0,
              state: 'error',
              error: err.message,
            };
          }
          throw err;
        } finally {
          loadInFlight = false;
          broadcast();
        }
      })();

      loading = pending;
      // Cleared here, never inside the body above: the body runs synchronously
      // up to its first `await`, so a host loader that throws synchronously (a
      // legal `() => Promise<T>` callback) settles it BEFORE the assignment
      // just above. Clearing inside would then be overwritten by that already
      // settled promise, and every later `load()` would replay its rejection —
      // the documented retry path dead for the life of the backend.
      const releaseLoading = () => {
        loading = null;
      };
      void pending.then(releaseLoading, releaseLoading);

      return pending;
    },

    async unload() {
      // Invalidate any load in flight: it re-checks the epoch after every
      // `await` and disposes what it built rather than publishing it.
      loadEpoch += 1;
      // `dispose()` tears down the GPU device; the chat layer holds KV state
      // bound to it, so both references go together.
      engine?.dispose();
      engine = null;
      chat = null;
      progress = undefined;
      loadError = null;
      broadcast();
    },

    async chat(messages, chatOptions) {
      assertTextOnlyTurn(BACKEND_LABEL, messages, chatOptions);
      const result = await requireChat().send(
        messages.map(({ role, content }) => ({ role, content })),
        toSendOptions(chatOptions),
      );
      return {
        content: result.text,
        // bitgpu also reports `'abort'`, which `AIResponse.finishReason` has no
        // member for: an aborted turn carries no finish reason here rather than
        // inventing one.
        ...(result.finishReason === 'stop' ||
        result.finishReason === 'length' ||
        result.finishReason === 'tool_calls'
          ? { finishReason: result.finishReason }
          : {}),
      } satisfies InferenceResponse;
    },

    async *stream(messages, chatOptions) {
      assertTextOnlyTurn(BACKEND_LABEL, messages, chatOptions);
      const iterator = requireChat().stream(
        messages.map(({ role, content }) => ({ role, content })),
        toSendOptions(chatOptions),
      );
      for await (const delta of iterator) {
        chatOptions?.onProgress?.(delta);
        yield delta;
      }
    },

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
