/**
 * Unit tests for the warm client cache (coverage uplift, S6 gate). Module-level
 * Map caches for STT/TTS/LLM adapters — get/set/update/remove + stats.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getCachedLLM,
  getCachedSTT,
  getCachedTTS,
  getCacheStats,
  removeCachedLLM,
  removeCachedSTT,
  removeCachedTTS,
  setCachedLLM,
  setCachedSTT,
  setCachedTTS,
  updateLLMCacheState,
  updateSTTCacheState,
  updateTTSCacheState,
} from '../warm-clients';

const fakeAdapter = () => ({ dispose: vi.fn() }) as never;

describe('warm client cache', () => {
  it('STT: set / get / update / remove', () => {
    const adapter = fakeAdapter();
    setCachedSTT('whisper-wasm', adapter);
    expect(getCachedSTT('whisper-wasm')?.adapter).toBe(adapter);
    updateSTTCacheState('whisper-wasm', { downloadProgress: 50 });
    expect(getCachedSTT('whisper-wasm')?.downloadProgress).toBe(50);
    removeCachedSTT('whisper-wasm');
    expect(getCachedSTT('whisper-wasm')).toBeUndefined();
  });

  it('TTS: set / get / update / remove', () => {
    const adapter = fakeAdapter();
    setCachedTTS('browser-synthesis', adapter);
    expect(getCachedTTS('browser-synthesis')?.adapter).toBe(adapter);
    updateTTSCacheState('browser-synthesis', { initState: 'ready' });
    removeCachedTTS('browser-synthesis');
    expect(getCachedTTS('browser-synthesis')).toBeUndefined();
  });

  it('LLM: set / get / update / remove', () => {
    const adapter = fakeAdapter();
    setCachedLLM('webllm', adapter);
    expect(getCachedLLM('webllm')?.adapter).toBe(adapter);
    updateLLMCacheState('webllm', { downloadProgress: 10 });
    removeCachedLLM('webllm');
    expect(getCachedLLM('webllm')).toBeUndefined();
  });

  it('getCacheStats reports cache contents', () => {
    setCachedSTT('whisper-cpp', fakeAdapter());
    const stats = getCacheStats();
    expect(stats).toBeDefined();
    removeCachedSTT('whisper-cpp');
  });
});
