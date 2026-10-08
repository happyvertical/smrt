import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptionTTSAdapter } from '../captions/caption-state.svelte.js';
import {
  createCaptionChannel,
  createHeardCaptionCallbacks,
  createSpokenCaptionCallbacks,
  createSpokenCaptionSession,
} from '../captions/caption-state.svelte.js';

function fakeTts() {
  const starts = new Set<() => void>();
  const ends = new Set<() => void>();
  const errors = new Set<(error: Error) => void>();
  const boundaries = new Set<(start: number, length: number) => void>();
  const adapter: CaptionTTSAdapter = {
    speak: vi.fn(async () => {}),
    stop: vi.fn(),
    onStart(callback) {
      starts.add(callback);
      return () => starts.delete(callback);
    },
    onEnd(callback) {
      ends.add(callback);
      return () => ends.delete(callback);
    },
    onError(callback) {
      errors.add(callback);
      return () => errors.delete(callback);
    },
    onBoundary(callback) {
      boundaries.add(callback);
      return () => boundaries.delete(callback);
    },
  };
  return {
    adapter,
    capture: () => ({
      starts: [...starts],
      ends: [...ends],
      errors: [...errors],
      boundaries: [...boundaries],
    }),
    start: () =>
      starts.forEach((callback) => {
        callback();
      }),
    end: () =>
      ends.forEach((callback) => {
        callback();
      }),
    boundary: (start: number, length: number) =>
      boundaries.forEach((callback) => {
        callback(start, length);
      }),
    error: () =>
      errors.forEach((callback) => {
        callback(new Error('speech failed'));
      }),
  };
}

describe('caption state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it('replaces interim heard text, retains bounded finals, and normalizes control text', () => {
    const captions = createCaptionChannel('heard', {
      maxLines: 2,
      now: () => 7,
    });
    const callbacks = createHeardCaptionCallbacks(captions);
    callbacks.onInterim?.('weather\nfor');
    expect(captions.interim).toBe('weather for');
    callbacks.onText('first');
    callbacks.onText('second');
    callbacks.onText('third\u0000 line');
    expect(captions.interim).toBe('');
    expect(captions.lines.map((line) => line.text)).toEqual([
      'second',
      'third line',
    ]);
    expect(captions.lines.every((line) => line.speaker === 'heard')).toBe(true);
  });

  it('expires bounded caption history and clears its timer when disposed', () => {
    vi.useFakeTimers();
    const captions = createCaptionChannel('heard', { ttlMs: 100 });
    captions.addFinal('will clear');
    vi.advanceTimersByTime(100);
    expect(captions.lines).toEqual([]);
    captions.addFinal('dispose me');
    captions.dispose();
    vi.advanceTimersByTime(100);
    expect(captions.lines).toEqual([]);
    vi.useRealTimers();
  });

  it('expires repeated final text at independent deadlines without postponing older lines', () => {
    vi.useFakeTimers();
    const captions = createCaptionChannel('heard', { ttlMs: 100 });
    captions.addFinal('Repeat');
    const firstId = captions.lines[0].id;
    vi.advanceTimersByTime(40);
    captions.addFinal('Repeat');
    const secondId = captions.lines[1].id;
    expect(secondId).not.toBe(firstId);
    captions.setInterim('A newer phrase');
    vi.advanceTimersByTime(60);
    expect(captions.lines.map((line) => line.id)).toEqual([secondId]);
    expect(captions.interim).toBe('A newer phrase');
    vi.advanceTimersByTime(40);
    expect(captions.lines).toEqual([]);
    expect(captions.interim).toBe('A newer phrase');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves later interim speech when the only completed caption expires', () => {
    vi.useFakeTimers();
    const captions = createCaptionChannel('heard', { ttlMs: 100 });
    captions.addFinal('Completed');
    vi.advanceTimersByTime(90);
    captions.setInterim('Still speaking');
    vi.advanceTimersByTime(10);
    expect(captions.lines).toEqual([]);
    expect(captions.interim).toBe('Still speaking');
  });

  it('cancels evicted and cleared deadlines and ignores callbacks delivered after cleanup', () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const captions = createCaptionChannel('spoken', {
      ttlMs: 100,
      maxLines: 2,
    });
    captions.addFinal('Evicted');
    const evictedCallback = timers.mock.calls.at(-1)?.[0] as () => void;
    vi.advanceTimersByTime(20);
    captions.addFinal('Second');
    vi.advanceTimersByTime(20);
    captions.addFinal('Third');
    const retiredCallback = timers.mock.calls.at(-1)?.[0] as () => void;
    expect(captions.lines.map((line) => line.text)).toEqual([
      'Second',
      'Third',
    ]);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
    evictedCallback();
    expect(captions.lines).toHaveLength(2);
    captions.clear();
    expect(vi.getTimerCount()).toBe(0);
    captions.addFinal('Fresh');
    const freshCallback = timers.mock.calls.at(-1)?.[0] as () => void;
    captions.setInterim('Current');
    retiredCallback();
    expect(captions.lines.map((line) => line.text)).toEqual(['Fresh']);
    expect(captions.interim).toBe('Current');
    captions.dispose();
    expect(vi.getTimerCount()).toBe(0);
    freshCallback();
    vi.runAllTimers();
    expect(captions.lines).toEqual([]);
    expect(captions.interim).toBe('');
  });

  it('shows only speech confirmed by TTS callbacks and ignores an end before playback starts', async () => {
    const tts = fakeTts();
    const captions = createCaptionChannel('spoken');
    const session = createSpokenCaptionSession(tts.adapter, captions);
    const speaking = session.speak('Read this aloud');
    tts.end();
    expect(captions.lines).toEqual([]);
    tts.start();
    tts.boundary(0, 4);
    expect(captions.interim).toBe('Read');
    tts.end();
    await speaking;
    expect(captions.lines.map((line) => line.text)).toEqual([
      'Read this aloud',
    ]);
    expect(captions.lines[0]?.speaker).toBe('spoken');
  });

  it('clears an interrupted utterance and ignores callbacks after disposal', async () => {
    const tts = fakeTts();
    const captions = createCaptionChannel('spoken');
    const session = createSpokenCaptionSession(tts.adapter, captions);
    const speaking = session.speak('A reply');
    tts.start();
    tts.boundary(0, 1);
    session.stop();
    tts.end();
    await speaking;
    expect(captions.lines).toEqual([]);
    expect(captions.interim).toBe('');
    session.dispose();
    tts.start();
    tts.end();
    expect(captions.lines).toEqual([]);
  });

  it('waits for cancelled playback and binds replacement callbacks to their utterance', async () => {
    const tts = fakeTts();
    let completeFirst!: () => void;
    let completeSecond!: () => void;
    vi.mocked(tts.adapter.speak)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            completeSecond = resolve;
          }),
      );
    const captions = createCaptionChannel('spoken');
    const session = createSpokenCaptionSession(tts.adapter, captions);
    const first = session.speak('Old speech');
    tts.start();
    const stale = tts.capture();
    const second = session.speak('New speech');
    expect(tts.adapter.speak).toHaveBeenCalledTimes(1);
    for (const callback of stale.boundaries) callback(0, 10);
    for (const callback of stale.ends) callback();
    expect(captions.lines).toEqual([]);
    completeFirst();
    await first;
    await Promise.resolve();
    tts.start();
    for (const callback of stale.starts) callback();
    for (const callback of stale.boundaries) callback(0, 10);
    for (const callback of stale.errors) callback(new Error('old failure'));
    for (const callback of stale.ends) callback();
    expect(captions.interim).toBe('');
    tts.boundary(0, 3);
    expect(captions.interim).toBe('New');
    tts.end();
    completeSecond();
    await second;
    expect(captions.lines.map((line) => line.text)).toEqual(['New speech']);
  });

  it('preserves playback indices, ignores malformed boundaries, and refuses speech after disposal', async () => {
    const tts = fakeTts();
    const captions = createCaptionChannel('spoken');
    const session = createSpokenCaptionSession(tts.adapter, captions);
    const speaking = session.speak('  A\n  reply');
    expect(tts.adapter.speak).toHaveBeenCalledWith('  A\n  reply', undefined);
    tts.start();
    tts.boundary(-1, 100);
    tts.boundary(Number.NaN, 10);
    expect(captions.interim).toBe('');
    tts.boundary(0, 3);
    expect(captions.interim).toBe('A');
    tts.error();
    await speaking;
    expect(captions.interim).toBe('');
    expect(captions.lines).toEqual([]);
    session.dispose();
    await session.speak('Never played');
    expect(tts.adapter.speak).toHaveBeenCalledTimes(1);
  });
  it('accepts host realtime playback signals and ignores superseded ids', () => {
    const captions = createCaptionChannel('spoken');
    const events = createSpokenCaptionCallbacks(captions);
    events.onEnd('not-started');
    expect(captions.lines).toEqual([]);
    events.onStart('one', 'Old speech');
    events.onStart('two', 'New speech');
    events.onBoundary('one', 0, 10);
    events.onEnd('one');
    events.onCancel('one');
    expect(captions.interim).toBe('');
    events.onBoundary('two', 0, 3);
    expect(captions.interim).toBe('New');
    events.onEnd('two');
    expect(captions.lines.map((line) => line.text)).toEqual(['New speech']);
    events.onStart('three', 'Cancelled');
    events.onCancel('three');
    events.onEnd('three');
    events.dispose();
    events.onStart('four', 'Disposed');
    events.onEnd('four');
    expect(captions.lines).toHaveLength(1);
  });
});
