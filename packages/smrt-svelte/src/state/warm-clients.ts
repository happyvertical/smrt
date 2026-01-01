/**
 * Module-level warm client cache for AI adapters
 *
 * This cache persists across Svelte component lifecycle, surviving
 * navigation between pages (SPA) and remounts of SmrtProvider.
 *
 * ## Key Benefits
 * - Avoids re-downloading WASM/models on every navigation
 * - Keeps WebGPU contexts warm (avoiding cold start delays)
 * - Enables pre-initialization during idle time
 *
 * ## How It Works
 * The cache is a simple Map at module scope. When SmrtProvider mounts,
 * it checks the cache before creating new adapters. Adapters stay cached
 * until explicitly cleared or the page is refreshed.
 *
 * ## Usage
 * ```typescript
 * import { getCachedSTT, getCacheStats, clearAllCaches } from '@happyvertical/smrt-svelte';
 *
 * // Check if whisper-cpp is already loaded
 * const cached = getCachedSTT('whisper-cpp');
 * if (cached?.initState === 'ready') {
 *   console.log('STT already initialized!');
 * }
 *
 * // Debug cache status
 * const stats = getCacheStats();
 * console.log('Cached adapters:', stats);
 *
 * // Clear cache to free memory
 * await clearAllCaches();
 * ```
 *
 * @module warm-clients
 */

import type {
  DownloadProgress,
  InitState,
  LLMAdapter,
  STTAdapter,
  TTSAdapter,
} from '@happyvertical/browser-ai';

/**
 * Adapter cache entry with metadata
 */
export interface CachedAdapter<T> {
  /** The adapter instance */
  adapter: T;
  /** When the adapter was cached */
  cachedAt: number;
  /** Initialization state */
  initState: InitState;
  /** Current download progress (if initializing) */
  downloadProgress: DownloadProgress | null;
  /** Error if initialization failed */
  error: Error | null;
  /** Adapter type identifier (for cache key matching) */
  type: string;
}

/**
 * STT adapter types that can be cached
 */
export type STTType = 'browser-speech' | 'whisper-cpp' | 'whisper-wasm';

/**
 * TTS adapter types that can be cached
 */
export type TTSType = 'browser-synthesis';

/**
 * LLM adapter types that can be cached
 */
export type LLMType = 'webllm' | 'transformers-llm';

/**
 * Module-level cache - survives component remounts
 */
const sttCache = new Map<STTType, CachedAdapter<STTAdapter>>();
const ttsCache = new Map<TTSType, CachedAdapter<TTSAdapter>>();
const llmCache = new Map<string, CachedAdapter<LLMAdapter>>(); // key = type:modelId

/**
 * Get a cached STT adapter
 */
export function getCachedSTT(
  type: STTType,
): CachedAdapter<STTAdapter> | undefined {
  return sttCache.get(type);
}

/**
 * Cache an STT adapter
 */
export function setCachedSTT(
  type: STTType,
  adapter: STTAdapter,
  initState: InitState = 'ready',
  error: Error | null = null,
): void {
  sttCache.set(type, {
    adapter,
    cachedAt: Date.now(),
    initState,
    downloadProgress: null,
    error,
    type,
  });
}

/**
 * Update STT cache entry state (for progress tracking)
 */
export function updateSTTCacheState(
  type: STTType,
  updates: Partial<
    Pick<CachedAdapter<STTAdapter>, 'initState' | 'downloadProgress' | 'error'>
  >,
): void {
  const entry = sttCache.get(type);
  if (entry) {
    Object.assign(entry, updates);
  }
}

/**
 * Remove an STT adapter from cache
 */
export function removeCachedSTT(type: STTType): void {
  const entry = sttCache.get(type);
  if (entry) {
    const disposeResult = entry.adapter.dispose?.();
    disposeResult?.catch?.((error: unknown) => {
      console.error('Error disposing STT adapter:', type, error);
    });
    sttCache.delete(type);
  }
}

/**
 * Get a cached TTS adapter
 */
export function getCachedTTS(
  type: TTSType,
): CachedAdapter<TTSAdapter> | undefined {
  return ttsCache.get(type);
}

/**
 * Cache a TTS adapter
 */
export function setCachedTTS(
  type: TTSType,
  adapter: TTSAdapter,
  initState: InitState = 'ready',
  error: Error | null = null,
): void {
  ttsCache.set(type, {
    adapter,
    cachedAt: Date.now(),
    initState,
    downloadProgress: null,
    error,
    type,
  });
}

/**
 * Update TTS cache entry state
 */
export function updateTTSCacheState(
  type: TTSType,
  updates: Partial<
    Pick<CachedAdapter<TTSAdapter>, 'initState' | 'downloadProgress' | 'error'>
  >,
): void {
  const entry = ttsCache.get(type);
  if (entry) {
    Object.assign(entry, updates);
  }
}

/**
 * Remove a TTS adapter from cache
 */
export function removeCachedTTS(type: TTSType): void {
  const entry = ttsCache.get(type);
  if (entry) {
    const disposeResult = entry.adapter.dispose?.();
    disposeResult?.catch?.((error: unknown) => {
      console.error('Error disposing TTS adapter:', type, error);
    });
    ttsCache.delete(type);
  }
}

/**
 * Get a cached LLM adapter
 */
export function getCachedLLM(
  type: LLMType,
  modelId?: string,
): CachedAdapter<LLMAdapter> | undefined {
  const key = modelId ? `${type}:${modelId}` : type;
  return llmCache.get(key);
}

/**
 * Cache an LLM adapter
 */
export function setCachedLLM(
  type: LLMType,
  adapter: LLMAdapter,
  modelId?: string,
  initState: InitState = 'ready',
  error: Error | null = null,
): void {
  const key = modelId ? `${type}:${modelId}` : type;
  llmCache.set(key, {
    adapter,
    cachedAt: Date.now(),
    initState,
    downloadProgress: null,
    error,
    type,
  });
}

/**
 * Update LLM cache entry state
 */
export function updateLLMCacheState(
  type: LLMType,
  modelId: string | undefined,
  updates: Partial<
    Pick<CachedAdapter<LLMAdapter>, 'initState' | 'downloadProgress' | 'error'>
  >,
): void {
  const key = modelId ? `${type}:${modelId}` : type;
  const entry = llmCache.get(key);
  if (entry) {
    Object.assign(entry, updates);
  }
}

/**
 * Remove an LLM adapter from cache
 */
export function removeCachedLLM(type: LLMType, modelId?: string): void {
  const key = modelId ? `${type}:${modelId}` : type;
  const entry = llmCache.get(key);
  if (entry) {
    const disposeResult = entry.adapter.dispose?.();
    disposeResult?.catch?.((error: unknown) => {
      console.error('Error disposing LLM adapter:', key, error);
    });
    llmCache.delete(key);
  }
}

/**
 * Clear all cached adapters
 */
export async function clearAllCaches(): Promise<void> {
  const errors: unknown[] = [];

  // Dispose all STT adapters
  for (const [type, entry] of sttCache.entries()) {
    try {
      await entry.adapter.dispose?.();
    } catch (error) {
      console.error('Error disposing STT adapter:', type, error);
      errors.push(error);
    }
  }
  sttCache.clear();

  // Dispose all TTS adapters
  for (const [type, entry] of ttsCache.entries()) {
    try {
      await entry.adapter.dispose?.();
    } catch (error) {
      console.error('Error disposing TTS adapter:', type, error);
      errors.push(error);
    }
  }
  ttsCache.clear();

  // Dispose all LLM adapters
  for (const [key, entry] of llmCache.entries()) {
    try {
      await entry.adapter.dispose?.();
    } catch (error) {
      console.error('Error disposing LLM adapter:', key, error);
      errors.push(error);
    }
  }
  llmCache.clear();

  // Throw the first error after all caches are cleared
  if (errors.length > 0) {
    throw errors[0];
  }
}

/**
 * Get cache statistics for debugging
 */
export function getCacheStats(): {
  stt: { count: number; types: STTType[] };
  tts: { count: number; types: TTSType[] };
  llm: { count: number; keys: string[] };
} {
  return {
    stt: {
      count: sttCache.size,
      types: Array.from(sttCache.keys()),
    },
    tts: {
      count: ttsCache.size,
      types: Array.from(ttsCache.keys()),
    },
    llm: {
      count: llmCache.size,
      keys: Array.from(llmCache.keys()),
    },
  };
}
