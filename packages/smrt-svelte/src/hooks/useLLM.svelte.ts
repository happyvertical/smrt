/**
 * Hook for LLM (Large Language Model) functionality
 */

import { onDestroy } from 'svelte';
import { getAppStateContext } from '../state/context.js';

/**
 * Options for useLLM hook
 */
export interface UseLLMOptions {
  /** Auto-initialize on mount */
  autoInit?: boolean;
  /** Model ID to load */
  model?: string;
  /** Default system prompt */
  systemPrompt?: string;
}

/**
 * Return type for useLLM hook
 */
export interface UseLLMReturn {
  /** Send a message and get response */
  chat: (
    text: string,
    options?: { systemPrompt?: string; onToken?: (token: string) => void },
  ) => Promise<string>;
  /** Initialize the adapter */
  initialize: (modelId?: string) => Promise<void>;
  /** Unload model to free memory */
  unload: () => Promise<void>;
  /** Current state (reactive) */
  readonly isReady: boolean;
  readonly isInitializing: boolean;
  readonly isGenerating: boolean;
  readonly currentModel: string | null;
  readonly error: Error | null;
  readonly downloadProgress: number;
}

/**
 * Hook for LLM chat
 *
 * @example
 * ```svelte
 * <script>
 *   import { useLLM } from '@happyvertical/smrt-svelte';
 *
 *   const llm = useLLM({ systemPrompt: 'You are a helpful assistant.' });
 *
 *   let input = $state('');
 *   let response = $state('');
 *
 *   async function handleSubmit() {
 *     response = '';
 *     response = await llm.chat(input, {
 *       onToken: (token) => { response += token; }
 *     });
 *   }
 * </script>
 *
 * {#if llm.isInitializing}
 *   <p>Loading model... {llm.downloadProgress}%</p>
 * {:else}
 *   <form onsubmit={handleSubmit}>
 *     <input bind:value={input} />
 *     <button disabled={llm.isGenerating}>Send</button>
 *   </form>
 *   <p>{response}</p>
 * {/if}
 * ```
 */
export function useLLM(options: UseLLMOptions = {}): UseLLMReturn {
  const app = getAppStateContext();

  // Auto-initialize if requested
  if (options.autoInit) {
    app.initializeLLM(options.model).catch(() => {
      // Error is stored in state
    });
  }

  const chat = async (
    text: string,
    chatOptions?: { systemPrompt?: string; onToken?: (token: string) => void },
  ) => {
    return app.chat(text, {
      systemPrompt: chatOptions?.systemPrompt ?? options.systemPrompt,
      onToken: chatOptions?.onToken,
    });
  };

  const initialize = async (modelId?: string) => {
    await app.initializeLLM(modelId ?? options.model);
  };

  const unload = async () => {
    await app.unloadLLM();
  };

  // Cleanup on destroy - don't unload by default as model download is expensive
  onDestroy(() => {
    // Could add option to auto-unload here
  });

  return {
    chat,
    initialize,
    unload,
    get isReady() {
      return app.state.ai.llm.initState === 'ready';
    },
    get isInitializing() {
      return app.state.ai.llm.initState === 'initializing';
    },
    get isGenerating() {
      return app.state.ai.llm.isGenerating;
    },
    get currentModel() {
      return app.state.ai.llm.currentModel;
    },
    get error() {
      return app.state.ai.llm.error;
    },
    get downloadProgress() {
      return app.state.ai.llm.downloadProgress?.percent ?? 0;
    },
  };
}
