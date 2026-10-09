/**
 * createHandsFreeCapture: the adapter from `@happyvertical/speech/browser`'s
 * `createVadCapture` to smrt-ui's hands-free microphone interface. The speech
 * package is replaced by a fake detector.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: never) => void;

const vad = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Listener>(),
    created: [] as Array<Record<string, unknown>>,
    stop: undefined as undefined | (() => Promise<void>),
    cancel: undefined as undefined | (() => void),
    present: true,
  };
  return state;
});

vi.mock('@happyvertical/speech/browser', () => ({
  get createVadCapture() {
    if (!vad.present) return undefined;
    return async (options: Record<string, unknown>) => {
      vad.created.push(options);
      return {
        on: (type: string, listener: Listener) => {
          vad.listeners.set(type, listener);
          return () => vad.listeners.delete(type);
        },
        stop: vad.stop ?? (async () => {}),
        cancel: vad.cancel ?? (() => {}),
      };
    };
  },
}));

import { DictationError } from '../audio-capture.js';
import { createHandsFreeCapture } from '../hands-free-vad.js';

const emit = (type: string, event?: unknown) =>
  (vad.listeners.get(type) as ((e: unknown) => void) | undefined)?.(event);

beforeEach(() => {
  vad.listeners.clear();
  vad.created.length = 0;
  vad.present = true;
  vad.stop = undefined;
  vad.cancel = undefined;
});

describe('createHandsFreeCapture', () => {
  it('opens the detector with the tuning and maps its events', async () => {
    const onUtterance = vi.fn();
    const onSpeaking = vi.fn();
    const onLevel = vi.fn();
    const capture = createHandsFreeCapture({
      vad: { silenceMs: 600, sensitivity: 0.7 },
      onUtterance,
      onSpeaking,
      onLevel,
    });
    await capture.start();
    expect(vad.created[0]).toEqual({ silenceMs: 600, sensitivity: 0.7 });

    emit('speechstart');
    emit('level', { level: 0.4 });
    const samples = new Float32Array([0.1]);
    emit('speechend', {
      samples,
      sampleRate: 16_000,
      durationMs: 900,
      reason: 'silence',
    });
    expect(onSpeaking.mock.calls).toEqual([[true], [false]]);
    expect(onLevel).toHaveBeenCalledWith(0.4);
    expect(onUtterance).toHaveBeenCalledWith({
      pcm: samples,
      sampleRate: 16_000,
      durationMs: 900,
      reason: 'silence',
    });
  });

  it('stop() lets the detector deliver the last phrase and release the microphone', async () => {
    const stop = vi.fn(async () => {});
    vad.stop = stop;
    const capture = createHandsFreeCapture({ onUtterance: () => {} });
    await capture.start();
    capture.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('cancel() releases the microphone without a last phrase', async () => {
    const cancel = vi.fn();
    vad.cancel = cancel;
    const capture = createHandsFreeCapture({ onUtterance: () => {} });
    await capture.start();
    capture.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stopping while the microphone is still opening releases it once open', async () => {
    const cancel = vi.fn();
    vad.cancel = cancel;
    const capture = createHandsFreeCapture({ onUtterance: () => {} });
    const starting = capture.start();
    capture.stop();
    await starting;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports a speech package too old for hands-free as unsupported', async () => {
    vad.present = false;
    const capture = createHandsFreeCapture({ onUtterance: () => {} });
    await expect(capture.start()).rejects.toBeInstanceOf(DictationError);
    await expect(capture.start()).rejects.toMatchObject({
      dictationKind: 'unsupported',
    });
  });
});
