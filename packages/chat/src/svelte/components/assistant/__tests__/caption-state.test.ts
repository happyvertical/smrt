import { describe, expect, it, vi } from 'vitest';
import type { CaptionTTSAdapter } from '../captions/caption-state.svelte.js';
import {
  createCaptionChannel,
  createHeardCaptionCallbacks,
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
});
