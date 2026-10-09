import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSynthesisTTSAdapter } from './browser-synthesis.js';

class NativeUtterance {
  voice: SpeechSynthesisVoice | null = null;
  lang = '';
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onboundary:
    | ((event: { charIndex: number; charLength?: number }) => void)
    | null = null;
  constructor(readonly text: string) {}
}

const voice = {
  voiceURI: 'native-en',
  name: 'Native English',
  lang: 'en-US',
  localService: true,
  default: true,
} as SpeechSynthesisVoice;

function nativeSynthesis(initialVoices: SpeechSynthesisVoice[] = [voice]) {
  let voices = initialVoices;
  const events = new EventTarget();
  const utterances: NativeUtterance[] = [];
  const synthesis = {
    getVoices: vi.fn(() => voices),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    speak: vi.fn((utterance: NativeUtterance) => utterances.push(utterance)),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    speaking: false,
    paused: false,
  };
  vi.stubGlobal('window', { speechSynthesis: synthesis });
  vi.stubGlobal('SpeechSynthesisUtterance', NativeUtterance);
  return {
    synthesis,
    utterances,
    loadVoices() {
      voices = [voice];
      events.dispatchEvent(new Event('voiceschanged'));
    },
  };
}

async function flushInitialization() {
  await vi.advanceTimersByTimeAsync(50);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BrowserSynthesisTTSAdapter cancellation', () => {
  it.each([
    'voiceschanged',
    'timeout',
  ])('does not play stopped pending speech after %s', async (completion) => {
    const native = nativeSynthesis([]);
    const adapter = new BrowserSynthesisTTSAdapter();
    const pending = adapter.speak('stopped');
    adapter.stop();
    if (completion === 'voiceschanged') native.loadVoices();
    else await vi.advanceTimersByTimeAsync(2000);
    await flushInitialization();
    expect(native.synthesis.speak).not.toHaveBeenCalled();
    await expect(pending).resolves.toBeUndefined();
    const next = adapter.speak('next');
    await flushInitialization();
    expect(native.utterances.map((u) => u.text)).toEqual(['next']);
    native.utterances[0].onend?.();
    await next;
  });

  it('plays only the latest replacement while voices load', async () => {
    const native = nativeSynthesis([]);
    const adapter = new BrowserSynthesisTTSAdapter();
    const first = adapter.speak('first');
    const second = adapter.speak('second');
    const third = adapter.speak('third');
    native.loadVoices();
    await flushInitialization();
    expect(native.utterances.map((u) => u.text)).toEqual(['third']);
    native.utterances[0].onend?.();
    await Promise.all([first, second, third]);
  });

  it.each([
    'voiceschanged',
    'timeout',
  ])('dispose prevents pending playback after %s and permits reinitialization', async (completion) => {
    const native = nativeSynthesis([]);
    const adapter = new BrowserSynthesisTTSAdapter();
    const pending = adapter.speak('disposed');
    await adapter.dispose();
    if (completion === 'voiceschanged') native.loadVoices();
    else await vi.advanceTimersByTimeAsync(2000);
    await flushInitialization();
    expect(native.synthesis.speak).not.toHaveBeenCalled();
    expect(adapter.initState).toBe('uninitialized');
    await expect(pending).resolves.toBeUndefined();
    const next = adapter.speak('fresh');
    await vi.advanceTimersByTimeAsync(2000);
    expect(native.utterances.map((u) => u.text)).toEqual(['fresh']);
    native.utterances[0].onend?.();
    await next;
  });

  it('disposes pending initialization and immediately starts a fresh request', async () => {
    const native = nativeSynthesis([]);
    const adapter = new BrowserSynthesisTTSAdapter();
    const old = adapter.speak('disposed');
    await adapter.dispose();
    const fresh = adapter.speak('fresh');
    native.loadVoices();
    await flushInitialization();
    expect(native.utterances.map((u) => u.text)).toEqual(['fresh']);
    expect(adapter.initState).toBe('ready');
    native.utterances[0].onend?.();
    await Promise.all([old, fresh]);
    expect(native.synthesis.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('stops speech during the ready initialization microtask', async () => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    await adapter.ensureInitialized();
    const pending = adapter.speak('stopped before native speak');
    adapter.stop();
    await pending;
    expect(native.synthesis.speak).not.toHaveBeenCalled();
  });

  it('disposes active playback without waiting for native completion', async () => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    const end = vi.fn();
    adapter.onEnd(end);
    const pending = adapter.speak('disposed');
    const settled = vi.fn();
    pending.then(settled);
    await flushInitialization();
    const staleEnd = native.utterances[0].onend;
    await adapter.dispose();
    await flushInitialization();
    expect(settled).toHaveBeenCalledOnce();
    staleEnd?.();
    adapter.stop();
    expect(end).not.toHaveBeenCalled();
    expect(adapter.initState).toBe('uninitialized');
  });

  it.each([
    'silent',
    'synchronous callbacks',
  ])('settles active cancellation with %s without successful end', async (cancelMode) => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    const end = vi.fn();
    const error = vi.fn();
    adapter.onEnd(end);
    adapter.onError(error);
    const pending = adapter.speak('cancel me');
    const settled = vi.fn();
    pending.then(settled);
    await flushInitialization();
    if (cancelMode === 'synchronous callbacks')
      native.synthesis.cancel.mockImplementation(() => {
        native.utterances[0].onerror?.({ error: 'canceled' });
        native.utterances[0].onend?.();
      });
    adapter.stop();
    await flushInitialization();
    expect(settled).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    const next = adapter.speak('replacement');
    await flushInitialization();
    native.utterances[1].onend?.();
    await next;
    expect(end).toHaveBeenCalledOnce();
  });

  it('ignores callbacks from replaced utterances without settling the newer speech', async () => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    const start = vi.fn();
    const end = vi.fn();
    const error = vi.fn();
    const boundary = vi.fn();
    adapter.onStart(start);
    adapter.onEnd(end);
    adapter.onError(error);
    adapter.onBoundary(boundary);
    const first = adapter.speak('old');
    await flushInitialization();
    const old = native.utterances[0];
    const stale = {
      start: old.onstart,
      end: old.onend,
      error: old.onerror,
      boundary: old.onboundary,
    };
    const next = adapter.speak('new');
    const settled = vi.fn();
    next.then(settled);
    await flushInitialization();
    stale.start?.();
    stale.end?.();
    stale.error?.({ error: 'canceled' });
    stale.boundary?.({ charIndex: 1 });
    await flushInitialization();
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(boundary).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    adapter.stop();
    await flushInitialization();
    expect(settled).toHaveBeenCalledOnce();
    await Promise.all([first, next]);
  });

  it('retains natural playback events, voice selection, parameters and pause/resume', async () => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    const start = vi.fn();
    const end = vi.fn();
    const boundary = vi.fn();
    adapter.onStart(start);
    adapter.onEnd(end);
    adapter.onBoundary(boundary);
    const pending = adapter.speak('ordinary', {
      voice: voice.voiceURI,
      rate: 1.5,
      pitch: 0.8,
      volume: 0.6,
    });
    await flushInitialization();
    const utterance = native.utterances[0];
    expect(utterance).toMatchObject({
      voice,
      lang: 'en-US',
      rate: 1.5,
      pitch: 0.8,
      volume: 0.6,
    });
    utterance.onstart?.();
    utterance.onboundary?.({ charIndex: 3 });
    adapter.pause();
    adapter.resume();
    expect(native.synthesis.pause).toHaveBeenCalledOnce();
    expect(native.synthesis.resume).toHaveBeenCalledOnce();
    utterance.onend?.();
    await pending;
    expect(start).toHaveBeenCalledOnce();
    expect(boundary).toHaveBeenCalledWith(3, 1);
    expect(end).toHaveBeenCalledOnce();
  });

  it('rejects and emits native errors once', async () => {
    const native = nativeSynthesis();
    const adapter = new BrowserSynthesisTTSAdapter();
    const error = vi.fn();
    const end = vi.fn();
    adapter.onError(error);
    adapter.onEnd(end);
    const pending = adapter.speak('failure');
    const rejected = expect(pending).rejects.toThrow(
      'Speech synthesis error: unknown-native-code',
    );
    await flushInitialization();
    native.utterances[0].onerror?.({ error: 'unknown-native-code' });
    await rejected;
    native.utterances[0].onend?.();
    expect(error).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });
});
