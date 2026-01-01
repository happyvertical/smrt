/**
 * Tests for warm client cache
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllCaches,
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
} from '../state/warm-clients.js';

// Mock adapters for testing
const createMockSTTAdapter = () => ({
  type: 'whisper-cpp' as const,
  dispose: () => Promise.resolve(),
  ensureInitialized: () => Promise.resolve(),
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  onResult: () => {},
  onStart: () => {},
  onEnd: () => {},
  onError: () => {},
});

const createMockTTSAdapter = () => ({
  type: 'browser-synthesis' as const,
  dispose: () => Promise.resolve(),
  ensureInitialized: () => Promise.resolve(),
  speak: () => Promise.resolve(),
  stop: () => {},
  pause: () => {},
  resume: () => {},
  getVoices: () => [],
  onStart: () => {},
  onEnd: () => {},
  onError: () => {},
});

const createMockLLMAdapter = () => ({
  type: 'webllm' as const,
  currentModel: 'test-model',
  dispose: () => Promise.resolve(),
  ensureInitialized: () => Promise.resolve(),
  message: () => Promise.resolve('response'),
  unloadModel: () => Promise.resolve(),
});

describe('warm-clients', () => {
  afterEach(async () => {
    await clearAllCaches();
  });

  describe('STT cache', () => {
    it('caches STT adapter', () => {
      const adapter = createMockSTTAdapter();
      setCachedSTT('whisper-cpp', adapter as any);

      const cached = getCachedSTT('whisper-cpp');
      expect(cached).toBeDefined();
      expect(cached?.adapter).toBe(adapter);
      expect(cached?.initState).toBe('ready');
      expect(cached?.type).toBe('whisper-cpp');
    });

    it('returns undefined for uncached adapter', () => {
      const cached = getCachedSTT('browser-speech');
      expect(cached).toBeUndefined();
    });

    it('updates cache state', () => {
      const adapter = createMockSTTAdapter();
      setCachedSTT('whisper-cpp', adapter as any);

      updateSTTCacheState('whisper-cpp', {
        initState: 'initializing',
        downloadProgress: {
          state: 'downloading',
          percent: 50,
          bytesLoaded: 50,
          bytesTotal: 100,
        },
      });

      const cached = getCachedSTT('whisper-cpp');
      expect(cached?.initState).toBe('initializing');
      expect(cached?.downloadProgress?.percent).toBe(50);
    });

    it('removes cached adapter', () => {
      const adapter = createMockSTTAdapter();
      setCachedSTT('whisper-cpp', adapter as any);

      removeCachedSTT('whisper-cpp');

      const cached = getCachedSTT('whisper-cpp');
      expect(cached).toBeUndefined();
    });
  });

  describe('TTS cache', () => {
    it('caches TTS adapter', () => {
      const adapter = createMockTTSAdapter();
      setCachedTTS('browser-synthesis', adapter as any);

      const cached = getCachedTTS('browser-synthesis');
      expect(cached).toBeDefined();
      expect(cached?.adapter).toBe(adapter);
      expect(cached?.initState).toBe('ready');
    });

    it('updates cache state', () => {
      const adapter = createMockTTSAdapter();
      setCachedTTS('browser-synthesis', adapter as any);

      updateTTSCacheState('browser-synthesis', {
        initState: 'error',
        error: new Error('test error'),
      });

      const cached = getCachedTTS('browser-synthesis');
      expect(cached?.initState).toBe('error');
      expect(cached?.error?.message).toBe('test error');
    });
  });

  describe('LLM cache', () => {
    it('caches LLM adapter with model ID', () => {
      const adapter = createMockLLMAdapter();
      setCachedLLM('webllm', adapter as any, 'test-model');

      const cached = getCachedLLM('webllm', 'test-model');
      expect(cached).toBeDefined();
      expect(cached?.adapter).toBe(adapter);
      expect(cached?.initState).toBe('ready');
    });

    it('caches LLM adapter without model ID', () => {
      const adapter = createMockLLMAdapter();
      setCachedLLM('webllm', adapter as any);

      const cached = getCachedLLM('webllm');
      expect(cached).toBeDefined();
      expect(cached?.adapter).toBe(adapter);
    });

    it('distinguishes between models', () => {
      const adapter1 = createMockLLMAdapter();
      const adapter2 = {
        ...createMockLLMAdapter(),
        currentModel: 'other-model',
      };

      setCachedLLM('webllm', adapter1 as any, 'model-1');
      setCachedLLM('webllm', adapter2 as any, 'model-2');

      expect(getCachedLLM('webllm', 'model-1')?.adapter).toBe(adapter1);
      expect(getCachedLLM('webllm', 'model-2')?.adapter).toBe(adapter2);
    });

    it('updates cache state', () => {
      const adapter = createMockLLMAdapter();
      setCachedLLM('webllm', adapter as any, 'test-model');

      updateLLMCacheState('webllm', 'test-model', {
        initState: 'initializing',
        downloadProgress: {
          state: 'downloading',
          percent: 75,
          bytesLoaded: 75,
          bytesTotal: 100,
        },
      });

      const cached = getCachedLLM('webllm', 'test-model');
      expect(cached?.initState).toBe('initializing');
      expect(cached?.downloadProgress?.percent).toBe(75);
    });

    it('removes cached adapter', () => {
      const adapter = createMockLLMAdapter();
      setCachedLLM('webllm', adapter as any, 'test-model');

      removeCachedLLM('webllm', 'test-model');

      const cached = getCachedLLM('webllm', 'test-model');
      expect(cached).toBeUndefined();
    });
  });

  describe('getCacheStats', () => {
    it('returns empty stats initially', async () => {
      const stats = getCacheStats();
      expect(stats.stt.count).toBe(0);
      expect(stats.tts.count).toBe(0);
      expect(stats.llm.count).toBe(0);
    });

    it('returns correct counts after caching', () => {
      setCachedSTT('whisper-cpp', createMockSTTAdapter() as any);
      setCachedSTT('browser-speech', createMockSTTAdapter() as any);
      setCachedTTS('browser-synthesis', createMockTTSAdapter() as any);
      setCachedLLM('webllm', createMockLLMAdapter() as any, 'model-1');

      const stats = getCacheStats();
      expect(stats.stt.count).toBe(2);
      expect(stats.stt.types).toContain('whisper-cpp');
      expect(stats.stt.types).toContain('browser-speech');
      expect(stats.tts.count).toBe(1);
      expect(stats.llm.count).toBe(1);
      expect(stats.llm.keys).toContain('webllm:model-1');
    });
  });

  describe('clearAllCaches', () => {
    it('clears all cached adapters', async () => {
      setCachedSTT('whisper-cpp', createMockSTTAdapter() as any);
      setCachedTTS('browser-synthesis', createMockTTSAdapter() as any);
      setCachedLLM('webllm', createMockLLMAdapter() as any);

      await clearAllCaches();

      const stats = getCacheStats();
      expect(stats.stt.count).toBe(0);
      expect(stats.tts.count).toBe(0);
      expect(stats.llm.count).toBe(0);
    });
  });
});
