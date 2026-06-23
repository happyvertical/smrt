/**
 * Regression tests for the browser-AI warm-cache lifecycle (T2 #1403):
 *
 * - R1 (listener leak): warm-cached adapters survive Provider remounts. Each
 *   manager that subscribes must capture + later remove its listeners on
 *   dispose(), and a shared adapter must never accumulate more than one live
 *   listener set across managers.
 * - R2 (state lies): dispose() must not leave a disposed adapter cached as
 *   'ready'; unloadLLM() must downgrade the warm-cache entry so the next init
 *   re-runs (reports progress) instead of cache-hitting a model-less adapter.
 * - R3 (scheduler thrash): setAIConfig() must no-op on a deep-equal config
 *   (inline `ai={{…}}` literal => new identity every render), and concurrent
 *   executePreload() passes must be guarded.
 * - R7 (nit): the empty-config early-return must reset loaded/failed too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Fakes -----------------------------------------------------------------

/**
 * A fake STT/TTS adapter whose event-subscription methods return real
 * unsubscribe handles backed by Sets — so a test can read the live listener
 * count and prove subscriptions are torn down (R1).
 */
function makeFakeSTT(type = 'whisper-cpp') {
  const sets = {
    result: new Set<(r: unknown) => void>(),
    start: new Set<() => void>(),
    end: new Set<() => void>(),
    error: new Set<(e: Error) => void>(),
  };
  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
  return {
    type,
    dispose: vi.fn(async () => {}),
    ensureInitialized: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    abort: vi.fn(),
    isListening: () => false,
    onResult: (cb: (r: unknown) => void) => sub(sets.result, cb),
    onStart: (cb: () => void) => sub(sets.start, cb),
    onEnd: (cb: () => void) => sub(sets.end, cb),
    onError: (cb: (e: Error) => void) => sub(sets.error, cb),
    /** total live listeners across all event sets */
    listenerCount: () =>
      sets.result.size + sets.start.size + sets.end.size + sets.error.size,
  };
}

function makeFakeTTS(type = 'browser-synthesis') {
  const sets = {
    start: new Set<() => void>(),
    end: new Set<() => void>(),
    error: new Set<(e: Error) => void>(),
  };
  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  };
  return {
    type,
    dispose: vi.fn(async () => {}),
    ensureInitialized: vi.fn(async () => {}),
    speak: vi.fn(async () => {}),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    getVoices: () => [],
    onStart: (cb: () => void) => sub(sets.start, cb),
    onEnd: (cb: () => void) => sub(sets.end, cb),
    onError: (cb: (e: Error) => void) => sub(sets.error, cb),
    listenerCount: () => sets.start.size + sets.end.size + sets.error.size,
  };
}

function makeFakeLLM(type: 'webllm' = 'webllm', model = 'tiny-model') {
  return {
    type,
    currentModel: model,
    dispose: vi.fn(async () => {}),
    ensureInitialized: vi.fn(async () => {}),
    unloadModel: vi.fn(async () => {}),
    message: vi.fn(async () => 'ok'),
  };
}

// --- Module mocks ----------------------------------------------------------
// The manager imports the AI factories + capability helpers from the browser-ai
// barrel. Mock only those; keep everything else (types) real via importOriginal.

const fakeSTT = makeFakeSTT();
const fakeTTS = makeFakeTTS();
const fakeLLM = makeFakeLLM();

vi.mock('../../browser-ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    detectCapabilities: () => ({}),
    canEnableSmrtMode: () => false,
    getSTT: vi.fn(async () => fakeSTT),
    getTTS: vi.fn(async () => fakeTTS),
    getLLM: vi.fn(async () => fakeLLM),
  };
});

import {
  createAppState,
  type SmrtAppStateManager,
} from '../app-state.svelte.js';
import { clearAllCaches, getCachedLLM, getCachedSTT } from '../warm-clients.js';

beforeEach(async () => {
  await clearAllCaches();
});

afterEach(async () => {
  await clearAllCaches();
  vi.clearAllMocks();
});

describe('R1: warm-adapter listener lifecycle', () => {
  it("removes a manager's listeners on dispose()", async () => {
    const m = createAppState();
    await m.initializeSTT({ type: 'whisper-cpp' });
    expect(fakeSTT.listenerCount()).toBeGreaterThan(0);

    await m.dispose();
    expect(fakeSTT.listenerCount()).toBe(0);
  });

  it('does not accumulate listeners across remounts of the same cached adapter', async () => {
    // Manager 1 subscribes then disposes.
    const m1 = createAppState();
    await m1.initializeSTT({ type: 'whisper-cpp' });
    const afterFirst = fakeSTT.listenerCount();
    await m1.dispose();

    // Manager 2 cache-hits the SAME warm adapter, subscribes, disposes.
    const m2 = createAppState();
    await m2.initializeSTT({ type: 'whisper-cpp' });
    // Exactly one manager's worth of listeners while live — not doubled.
    expect(fakeSTT.listenerCount()).toBe(afterFirst);
    await m2.dispose();

    expect(fakeSTT.listenerCount()).toBe(0);
  });

  it('keeps at most one live listener set when two managers coexist', async () => {
    const m1 = createAppState();
    await m1.initializeSTT({ type: 'whisper-cpp' });
    const single = fakeSTT.listenerCount();

    // A second live manager taking over the shared adapter must evict the
    // first's listeners rather than stack a second set.
    const m2 = createAppState();
    await m2.initializeSTT({ type: 'whisper-cpp' });
    expect(fakeSTT.listenerCount()).toBe(single);

    await m1.dispose();
    await m2.dispose();
    expect(fakeSTT.listenerCount()).toBe(0);
  });

  it('removes TTS listeners on dispose()', async () => {
    const m = createAppState();
    await m.initializeTTS({ type: 'browser-synthesis' });
    expect(fakeTTS.listenerCount()).toBeGreaterThan(0);
    await m.dispose();
    expect(fakeTTS.listenerCount()).toBe(0);
  });

  it('subscribing the same adapter twice on one manager is idempotent', async () => {
    const m = createAppState();
    await m.initializeSTT({ type: 'whisper-cpp' });
    const once = fakeSTT.listenerCount();
    // Second init cache-hits and re-enters subscribeToSTTEvents.
    await m.initializeSTT({ type: 'whisper-cpp' });
    expect(fakeSTT.listenerCount()).toBe(once);
    await m.dispose();
  });
});

describe('R2: dispose()/unloadLLM() do not leave the cache lying', () => {
  it('dispose() leaves the warm STT adapter intact (not disposed) and cached ready', async () => {
    const m = createAppState();
    await m.initializeSTT({ type: 'whisper-cpp' });
    await m.dispose();

    // Cached adapter survives navigation and was NOT disposed — so a later
    // init won't restore a dead engine reported as 'ready'.
    const cached = getCachedSTT('whisper-cpp');
    expect(cached?.initState).toBe('ready');
    expect(cached?.adapter).toBe(fakeSTT);
    expect(fakeSTT.dispose).not.toHaveBeenCalled();
  });

  it('unloadLLM() downgrades the warm-cache entry to uninitialized', async () => {
    const m = createAppState();
    await m.initializeLLM('tiny-model', { type: 'webllm' });
    expect(getCachedLLM('webllm', 'tiny-model')?.initState).toBe('ready');

    await m.unloadLLM();

    // Next initializeLLM must re-run (report progress) rather than cache-hit a
    // model-less adapter reported as 'ready'.
    expect(getCachedLLM('webllm', 'tiny-model')?.initState).toBe(
      'uninitialized',
    );
    await m.dispose();
  });
});

describe('R3: setAIConfig scheduler thrash + preload re-entrancy', () => {
  it('no-ops on a deep-equal config of a different identity', async () => {
    const m: SmrtAppStateManager = createAppState();
    const spy = vi.spyOn(
      m as unknown as { schedulePreload: () => void },
      'schedulePreload',
    );

    m.setAIConfig({ preload: 'none', stt: { type: 'whisper-cpp' } });
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Same shape, brand-new object literal (what an inline `ai={{…}}` produces).
    m.setAIConfig({ preload: 'none', stt: { type: 'whisper-cpp' } });
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // no re-schedule
  });

  it('re-schedules when the config actually changes', async () => {
    const m: SmrtAppStateManager = createAppState();
    const spy = vi.spyOn(
      m as unknown as { schedulePreload: () => void },
      'schedulePreload',
    );

    m.setAIConfig({ preload: 'none', stt: { type: 'whisper-cpp' } });
    const before = spy.mock.calls.length;
    m.setAIConfig({ preload: 'none', stt: { type: 'whisper-wasm' } });
    expect(spy.mock.calls.length).toBe(before + 1);
  });

  it('guards executePreload against concurrent passes', async () => {
    const m = createAppState();
    m.setAIConfig({
      preload: 'none',
      stt: { type: 'whisper-cpp' },
    });

    const exec = (
      m as unknown as { executePreload: () => Promise<void> }
    ).executePreload.bind(m);

    // Two overlapping passes: the second must early-return (guarded), so the
    // STT factory is invoked once, not twice.
    const { getSTT } = (await import(
      '../../browser-ai/index.js'
    )) as unknown as {
      getSTT: ReturnType<typeof vi.fn>;
    };
    getSTT.mockClear();
    await Promise.all([exec(), exec()]);
    expect(getSTT).toHaveBeenCalledTimes(1);
    await m.dispose();
  });
});

describe('R7: empty-config preload early-return resets loaded/failed', () => {
  it('clears stale loaded/failed entries', async () => {
    const m = createAppState();
    // Seed stale entries through a normal pass, then re-run with empty config.
    m.setAIConfig({ preload: 'none', stt: { type: 'whisper-cpp' } });
    await (
      m as unknown as { executePreload: () => Promise<void> }
    ).executePreload();
    expect(m.aiLoading.loaded.length).toBeGreaterThan(0);

    // Now an empty config — the early-return path must reset loaded/failed.
    m.setAIConfig({ preload: 'none' });
    await (
      m as unknown as { executePreload: () => Promise<void> }
    ).executePreload();

    expect(m.aiLoading.phase).toBe('idle');
    expect(m.aiLoading.loaded).toEqual([]);
    expect(m.aiLoading.failed).toEqual([]);
    await m.dispose();
  });
});
