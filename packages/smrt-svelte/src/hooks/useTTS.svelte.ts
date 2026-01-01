/**
 * Hook for Text-to-Speech functionality
 */

import type { TTSOptions, TTSVoice } from '@happyvertical/browser-ai';
import { onDestroy } from 'svelte';
import { getAppStateContext } from '../state/context.js';

/**
 * Options for useTTS hook
 */
export interface UseTTSOptions {
  /** Auto-initialize on mount */
  autoInit?: boolean;
  /** Default TTS options */
  defaultOptions?: TTSOptions;
}

/**
 * Return type for useTTS hook
 */
export interface UseTTSReturn {
  /** Speak text */
  speak: (text: string, options?: TTSOptions) => Promise<void>;
  /** Stop speaking */
  stop: () => void;
  /** Pause speaking */
  pause: () => void;
  /** Resume speaking */
  resume: () => void;
  /** Initialize the adapter (called automatically if autoInit) */
  initialize: () => Promise<void>;
  /** Get available voices */
  getVoices: () => TTSVoice[];
  /** Current state (reactive) */
  readonly isSpeaking: boolean;
  readonly isPaused: boolean;
  readonly isReady: boolean;
  readonly isInitializing: boolean;
  readonly error: Error | null;
  readonly downloadProgress: number;
}

/**
 * Hook for Text-to-Speech
 *
 * @example
 * ```svelte
 * <script>
 *   import { useTTS } from '@happyvertical/smrt-svelte';
 *
 *   const tts = useTTS();
 *   let text = 'Hello, world!';
 *
 *   async function handleSpeak() {
 *     if (tts.isSpeaking) {
 *       tts.stop();
 *     } else {
 *       await tts.speak(text);
 *     }
 *   }
 * </script>
 *
 * <input bind:value={text} />
 * <button onclick={handleSpeak}>
 *   {tts.isSpeaking ? 'Stop' : 'Speak'}
 * </button>
 * ```
 */
export function useTTS(options: UseTTSOptions = {}): UseTTSReturn {
  const app = getAppStateContext();

  // Auto-initialize if requested
  if (options.autoInit) {
    app.initializeTTS().catch(() => {
      // Error is stored in state
    });
  }

  const speak = async (text: string, ttsOptions?: TTSOptions) => {
    await app.speak(text, {
      ...options.defaultOptions,
      ...ttsOptions,
    });
  };

  const stop = () => {
    app.stopSpeaking();
  };

  const pause = () => {
    app.pauseSpeaking();
  };

  const resume = () => {
    app.resumeSpeaking();
  };

  const initialize = async () => {
    await app.initializeTTS();
  };

  const getVoices = () => {
    return app.getTTSVoices();
  };

  // Cleanup on destroy
  onDestroy(() => {
    if (app.state.ai.tts.isSpeaking) {
      app.stopSpeaking();
    }
  });

  return {
    speak,
    stop,
    pause,
    resume,
    initialize,
    getVoices,
    get isSpeaking() {
      return app.state.ai.tts.isSpeaking;
    },
    get isPaused() {
      return app.state.ai.tts.isPaused;
    },
    get isReady() {
      return app.state.ai.tts.initState === 'ready';
    },
    get isInitializing() {
      return app.state.ai.tts.initState === 'initializing';
    },
    get error() {
      return app.state.ai.tts.error;
    },
    get downloadProgress() {
      return app.state.ai.tts.downloadProgress?.percent ?? 0;
    },
  };
}
