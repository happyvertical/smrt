/**
 * Hook for Speech-to-Text functionality
 */

import { onDestroy } from 'svelte';
import type { GetSTTOptions, STTOptions } from '../browser-ai/index.js';
import { getAppStateContext } from '../state/context.js';

/**
 * Options for useSTT hook
 */
export interface UseSTTOptions {
  /** Auto-initialize on mount */
  autoInit?: boolean;
  /** Default STT options */
  defaultOptions?: STTOptions;
}

/**
 * Return type for useSTT hook
 */
export interface UseSTTReturn {
  /** Start listening */
  start: (options?: STTOptions) => Promise<void>;
  /** Stop listening */
  stop: () => Promise<void>;
  /** Initialize the adapter (called automatically if autoInit) */
  initialize: (options?: GetSTTOptions) => Promise<void>;
  /** Current state (reactive) */
  readonly isListening: boolean;
  readonly isReady: boolean;
  readonly isInitializing: boolean;
  /** Final transcribed text (updates on speech completion) */
  readonly lastResult: string;
  /** Interim transcribed text (updates live during speech) */
  readonly interimResult: string;
  /** Current result - interim while listening, last result otherwise */
  readonly currentResult: string;
  readonly error: Error | null;
  readonly downloadProgress: number;
  /** Current adapter type (e.g., 'browser', 'whisper-wasm', 'whisper-cpp') */
  readonly adapterType: string | null;
}

/**
 * Hook for Speech-to-Text
 *
 * @example
 * ```svelte
 * <script>
 *   import { useSTT } from '@happyvertical/smrt-svelte';
 *
 *   const stt = useSTT();
 *
 *   async function handleClick() {
 *     if (stt.isListening) {
 *       await stt.stop();
 *     } else {
 *       await stt.start();
 *     }
 *   }
 * </script>
 *
 * <button onclick={handleClick}>
 *   {stt.isListening ? 'Stop' : 'Start'} Listening
 * </button>
 *
 * {#if stt.lastResult}
 *   <p>You said: {stt.lastResult}</p>
 * {/if}
 * ```
 */
export function useSTT(options: UseSTTOptions = {}): UseSTTReturn {
  const app = getAppStateContext();

  // The STT manager is a Provider-level singleton shared by every useSTT()
  // consumer. Track whether *this* hook started the current listening session
  // so unmounting one <VoiceInput> doesn't abort another's recording (R4).
  let startedByThisHook = false;

  // Auto-initialize if requested
  if (options.autoInit) {
    app.initializeSTT().catch(() => {
      // Error is stored in state
    });
  }

  const start = async (sttOptions?: STTOptions) => {
    startedByThisHook = true;
    try {
      await app.startListening({
        ...options.defaultOptions,
        ...sttOptions,
      });
    } catch (err) {
      startedByThisHook = false;
      throw err;
    }
  };

  const stop = async () => {
    startedByThisHook = false;
    await app.stopListening();
  };

  const initialize = async (initOptions?: GetSTTOptions) => {
    await app.initializeSTT(initOptions);
  };

  // Cleanup on destroy: only stop the shared singleton if this hook owns the
  // in-progress session (R4) — never stop a recording another hook started.
  onDestroy(() => {
    if (startedByThisHook && app.state.ai.stt.isListening) {
      app.stopListening().catch(() => {});
    }
    startedByThisHook = false;
  });

  return {
    start,
    stop,
    initialize,
    get isListening() {
      return app.state.ai.stt.isListening;
    },
    get isReady() {
      return app.state.ai.stt.initState === 'ready';
    },
    get isInitializing() {
      return app.state.ai.stt.initState === 'initializing';
    },
    get lastResult() {
      return app.state.ai.stt.lastResult;
    },
    get interimResult() {
      return app.state.ai.stt.interimResult;
    },
    get currentResult() {
      // Return interim while listening, otherwise last result
      const { isListening, interimResult, lastResult } = app.state.ai.stt;
      if (isListening && interimResult) {
        return interimResult;
      }
      return lastResult;
    },
    get error() {
      return app.state.ai.stt.error;
    },
    get downloadProgress() {
      return app.state.ai.stt.downloadProgress?.percent ?? 0;
    },
    get adapterType() {
      return app.state.ai.stt.adapter?.type ?? null;
    },
  };
}
