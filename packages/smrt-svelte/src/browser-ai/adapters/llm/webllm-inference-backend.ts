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

/**
 * Forward only the options the adapter can honor.
 *
 * `ensuredModel` is the model this backend exists to serve. It WINS over a
 * per-call one, because one engine binds one model: passing a different id
 * would make the adapter unload the model `load()` ensured and download that
 * one behind the first message, answering from a model the caller never chose.
 * A per-call `model` therefore only reaches the adapter when this backend was
 * configured with none — the same constraint bitgpu documents.
 */
function toAdapterOptions(
  options: InferenceChatOptions | undefined,
  ensuredModel: string | undefined,
): LLMChatOptions {
  const model = ensuredModel ?? options?.model;
  return {
    ...(model ? { model } : {}),
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
  // Bumped by `unload()`. A load captures it before its first `await` and
  // re-checks it afterwards, so a load that overlaps an `unload()` releases
  // what it loaded instead of publishing `ready` for a backend the caller has
  // already released.
  let loadEpoch = 0;
  // The highest epoch whose initialization has COMPLETED. A superseded attempt
  // consults it (with `loadInFlight`) before releasing the adapter's model:
  // releasing when a newer attempt already owns that model would destroy it.
  let lastPublishedEpoch = -1;
  // The single in-flight load, stamped with the epoch that created it: concurrent
  // callers share one attempt (as bitgpu's memo does), and a caller never joins
  // an attempt from a superseded epoch.
  let loadPromise: { promise: Promise<void>; epoch: number } | null = null;
  // Set when a superseded attempt establishes a model it cannot release because
  // a newer attempt owns the adapter. That newer attempt's failure discharges
  // it — which is the ONLY case where the failure path may call `unloadModel()`
  // without erasing the adapter's own `error` state.
  let orphanedModel = false;
  // Durable copy of the last load failure. It is read from HERE rather than from
  // the adapter's mutable `initState`, because the release that follows a
  // failure resets that state — and `'idle'` would read as "never loaded".
  let loadError: Error | null = null;

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
    // Checked before the adapter so a failure survives the release that follows
    // it, and before `loadInFlight` so a retry in flight does not hide it.
    if (loadError) return 'error';
    if (loadInFlight) return 'loading';
    return toBackendStatus(adapter);
  }

  /**
   * True when the adapter already holds the model this backend ensures. A shared
   * adapter may be `ready` on a DIFFERENT one — the warm-cache case that
   * `options.adapter` exists for — and short-circuiting then would skip a load
   * the caller asked for and hand the turn to the wrong model.
   */
  function holdsRequestedModel(): boolean {
    if (!options.model) return true;
    return adapter?.currentModel === options.model;
  }

  async function ensureAdapter(): Promise<LLMAdapter> {
    if (adapter) return adapter;
    // Concurrent `load()`/`chat()` calls share one construction, so two
    // callers cannot each start an unshared adapter (and its download).
    loading ??= (async () => {
      const { appConfig, loadModule, model } = options;
      const created = await getLLM({
        ...(appConfig ? { appConfig } : {}),
        ...(loadModule ? { loadModule } : {}),
        // Pin the configured model as the adapter's DEFAULT, not merely the one
        // `load()` names. A turn that does not name one resolves the adapter's
        // default, so without this the adapter would unload the model `load()`
        // ensured and download its own default behind the first message.
        ...(model ? { defaultModel: model } : {}),
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

    load(onProgress) {
      if (currentStatus() === 'unavailable') {
        return Promise.reject(
          new InferencePathError(
            'WebLLM requires WebGPU, which this browser does not expose.',
            'no_usable_backend',
          ),
        );
      }
      // No-op when already ready — the contract `InferenceBackend.load`
      // documents, and the one bitgpu's `load` honors. Without it, a host that
      // follows the documented "call `load()` before a turn" pattern toggles
      // this backend through `loading`, the state auto-selection skips, so a
      // turn issued in that window silently routes to the server instead of the
      // model that is already resident.
      if (currentStatus() === 'ready' && holdsRequestedModel()) {
        return Promise.resolve();
      }
      // One attempt per epoch, shared by concurrent callers — the single-flight
      // bitgpu applies. Without it a second caller reaches the adapter's own
      // `'initializing'` poll, which settles only on `ready` or `error`, so a
      // release landing in between would leave that caller waiting.
      if (loadPromise && loadPromise.epoch === loadEpoch) {
        return loadPromise.promise;
      }

      // A new attempt supersedes the previous failure.
      loadError = null;
      // Marked before the first `await`: a caller that reads `status`
      // immediately after calling `load()` must not see `'idle'`, which is
      // exactly the state auto-selection is told to skip.
      loadInFlight = true;
      broadcast();
      // Captured before the first `await`; every step that publishes state
      // re-checks it, because `unload()` may run while this is in flight.
      const epoch = loadEpoch;
      const pending = (async () => {
        try {
          const target = await ensureAdapter();
          await target.ensureInitialized(options.model, (next) => {
            // A download that outlives an `unload()` must not resurrect progress
            // on a backend the caller has just released.
            if (epoch !== loadEpoch) return;
            progress = next;
            onProgress?.(next);
            broadcast();
          });
          if (epoch !== loadEpoch) {
            // `unload()` ran while this attempt was loading, so it must not
            // publish. It may only release the model it established when nothing
            // newer owns it — a later `load()` that is still in flight, or one
            // that has already completed, would otherwise have the model it
            // published destroyed underneath it.
            if (!loadInFlight && lastPublishedEpoch < epoch) {
              await target.unloadModel();
            } else if (loadInFlight) {
              // A newer attempt owns the adapter right now, so the model this
              // one established stays resident for now; that newer attempt's
              // failure discharges it. Anything else — a newer attempt that has
              // already PUBLISHED — owns the adapter's one model, so nothing is
              // orphaned and this attempt must not mark it so.
              orphanedModel = true;
            }
            return;
          }
          lastPublishedEpoch = epoch;
          // A published model is owned by this epoch, so nothing is orphaned
          // and no later failure may release it as if it were.
          orphanedModel = false;
          loadError = null;
          progress = undefined;
        } catch (error) {
          // Discharge a release a SUPERSEDED attempt deferred: it left a model
          // resident because this attempt owned the adapter, and this attempt
          // then failed, so nothing would ever release it. Scoped to exactly
          // that case — an unconditional `unloadModel()` here would wipe the
          // adapter's own `error` state and report `idle` for a load that
          // failed.
          // Only a CURRENT-epoch failure may discharge it. A superseded
          // attempt's failure says nothing about which attempt owns the adapter
          // now, and releasing on it would destroy the model the current epoch
          // published — with no error recorded and the next turn downloading
          // behind the message.
          if (orphanedModel && epoch === loadEpoch) {
            orphanedModel = false;
            // Best-effort: this path is already failing, and the cleanup must
            // not replace the caller's error with its own.
            await adapter?.unloadModel().catch(() => undefined);
          }
          if (epoch === loadEpoch) {
            // Mirror bitgpu: keep a snapshot of how far the load got, marked as
            // failed rather than left reading `downloading` on an `idle`
            // backend — and record the failure so it survives the release that
            // follows it.
            const err =
              error instanceof Error ? error : new Error(String(error));
            loadError = err;
            progress = {
              bytesLoaded: progress?.bytesLoaded ?? 0,
              bytesTotal: progress?.bytesTotal ?? 0,
              percent: progress?.percent ?? 0,
              state: 'error',
              error: err.message,
            };
          }
          throw error;
        } finally {
          // A superseded attempt must not clear the flag for the load that
          // replaced it.
          if (epoch === loadEpoch) loadInFlight = false;
          broadcast();
        }
      })();

      loadPromise = { promise: pending, epoch };
      const releaseLoad = () => {
        if (loadPromise?.promise === pending) loadPromise = null;
      };
      void pending.then(releaseLoad, releaseLoad);
      return pending;
    },

    async unload() {
      // Invalidate any load in flight: it re-checks the epoch before
      // publishing and releases what it loaded instead of reporting `ready`.
      // The flag is cleared here because that superseded load will no longer
      // clear it, and `'loading'` is the state auto-selection must skip.
      loadEpoch += 1;
      loadInFlight = false;
      loadPromise = null;
      // Ownership does not survive a release: an attempt from an older epoch
      // that finishes later must not read a newer attempt's completion as
      // "someone else owns this model", or it would skip releasing what it
      // re-established and silently undo the caller's `unload()`.
      lastPublishedEpoch = -1;
      orphanedModel = false;
      loadError = null;
      await adapter?.unloadModel();
      progress = undefined;
      broadcast();
    },

    async chat(messages, chatOptions) {
      assertTextOnlyTurn('The browser LLM adapter', messages, chatOptions);
      const target = await ensureAdapter();
      const response = await target.chat(
        toAdapterMessages(messages),
        toAdapterOptions(chatOptions, options.model),
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
        toAdapterOptions(chatOptions, options.model),
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
