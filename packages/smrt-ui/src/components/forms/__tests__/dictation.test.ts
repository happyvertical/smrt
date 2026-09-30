/**
 * Dictation state machine over a fake speech source (no real microphone:
 * speech recognition cannot run headless). Covers start → listening (with the
 * ready beep) → final text → stop, errors in plain kinds, and "stopped
 * before the microphone opened".
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyDictationError,
  Dictation,
  type DictationSpeechResult,
  type DictationSpeechSource,
} from '../dictation.svelte.js';
import { insertTextAtCursor } from '../insert-text.js';

function fakeSource(options: { startError?: Error; emitStart?: boolean } = {}) {
  const results = new Set<(r: DictationSpeechResult) => void>();
  const errors = new Set<(e: Error) => void>();
  const ends = new Set<() => void>();
  const starts = new Set<() => void>();
  const source: DictationSpeechSource & {
    emitResult(text: string, isFinal: boolean): void;
    emitError(error: Error): void;
    emitEnd(): void;
    emitStart(): void;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  } = {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
    }),
    stop: vi.fn(async () => {
      for (const cb of ends) cb();
    }),
    onResult: (cb) => (results.add(cb), () => results.delete(cb)),
    onError: (cb) => (errors.add(cb), () => errors.delete(cb)),
    onEnd: (cb) => (ends.add(cb), () => ends.delete(cb)),
    ...(options.emitStart
      ? {
          onStart: (cb: () => void) => (
            starts.add(cb), () => starts.delete(cb)
          ),
        }
      : {}),
    emitResult: (text, isFinal) => {
      for (const cb of results) cb({ text, isFinal });
    },
    emitError: (error) => {
      for (const cb of errors) cb(error);
    },
    emitEnd: () => {
      for (const cb of ends) cb();
    },
    emitStart: () => {
      for (const cb of starts) cb();
    },
  };
  return source;
}

describe('Dictation', () => {
  it('listens, beeps once ready, hands over final phrases, and stops', async () => {
    const source = fakeSource();
    const beep = vi.fn(async () => true);
    const onText = vi.fn();
    const dictation = new Dictation({
      source: () => source,
      onText,
      beep,
      language: 'en-CA',
    });
    expect(dictation.state).toBe('idle');
    const started = dictation.start();
    expect(dictation.state).toBe('starting');
    await started;
    expect(dictation.state).toBe('listening');
    expect(source.start).toHaveBeenCalledWith({
      language: 'en-CA',
      continuous: true,
      interimResults: true,
    });
    await vi.waitFor(() => expect(beep).toHaveBeenCalledTimes(1));

    source.emitResult('make it', false);
    expect(dictation.interim).toBe('make it');
    source.emitResult('make it brighter ', true);
    expect(onText).toHaveBeenCalledWith('make it brighter');
    expect(dictation.interim).toBe('');

    await dictation.stop();
    expect(source.stop).toHaveBeenCalled();
    expect(dictation.state).toBe('idle');
  });

  it('waits for the source to say it is listening before beeping', async () => {
    const source = fakeSource({ emitStart: true });
    const beep = vi.fn(async () => true);
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep,
    });
    await dictation.start();
    expect(dictation.state).toBe('starting');
    expect(beep).not.toHaveBeenCalled();
    source.emitStart();
    expect(dictation.state).toBe('listening');
    await vi.waitFor(() => expect(beep).toHaveBeenCalled());
  });

  it('closes the microphone if it opens after the person already stopped', async () => {
    const source = fakeSource({ emitStart: true });
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      stopTimeoutMs: 10,
    });
    await dictation.start();
    await dictation.stop();
    source.stop.mockClear();
    source.emitStart();
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(dictation.state).not.toBe('listening');
  });

  it('toggle starts and stops', async () => {
    const source = fakeSource();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
    });
    await dictation.toggle();
    expect(dictation.state).toBe('listening');
    await dictation.toggle();
    expect(dictation.state).toBe('idle');
  });

  it('reports unsupported without a source, or when the source cannot load', async () => {
    const none = new Dictation({ source: null, onText: () => {} });
    await none.start();
    expect(none.state).toBe('error');
    expect(none.errorKind).toBe('unsupported');

    const missing = Object.assign(
      new Error('Required capability not available: Web Speech API'),
      {
        name: 'CapabilityNotAvailableError',
        code: 'CAPABILITY_NOT_AVAILABLE',
      },
    );
    const broken = new Dictation({
      source: () => {
        throw missing;
      },
      onText: () => {},
    });
    await broken.start();
    expect(broken.errorKind).toBe('unsupported');
  });

  it('reports a blocked microphone as denied, from start or later', async () => {
    const denied = Object.assign(new Error('Permission denied: microphone'), {
      name: 'PermissionDeniedError',
      code: 'PERMISSION_DENIED',
    });
    const atStart = new Dictation({
      source: () => fakeSource({ startError: denied }),
      onText: () => {},
    });
    await atStart.start();
    expect(atStart.errorKind).toBe('denied');

    const source = fakeSource();
    const later = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
    });
    await later.start();
    source.emitError(denied);
    source.emitEnd();
    expect(later.state).toBe('error');
    expect(later.errorKind).toBe('denied');
    later.clearError();
    expect(later.state).toBe('idle');
  });

  it('keeps the beep for a later gesture when audio is not allowed yet', async () => {
    const source = fakeSource();
    const beep = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep,
    });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.beepPending).toBe(true));
    await dictation.unlock();
    expect(beep).toHaveBeenCalledTimes(2);
    expect(dictation.beepPending).toBe(false);
  });

  it('ignores results after dispose', async () => {
    const source = fakeSource();
    const onText = vi.fn();
    const dictation = new Dictation({
      source: () => source,
      onText,
      beep: false,
    });
    await dictation.start();
    dictation.dispose();
    source.emitResult('late words', true);
    expect(onText).not.toHaveBeenCalled();
  });
});

describe('classifyDictationError', () => {
  it('sorts errors into plain kinds', () => {
    expect(classifyDictationError(new Error('No speech detected'))).toBe(
      'no-speech',
    );
    expect(classifyDictationError({ name: 'NotAllowedError' })).toBe('denied');
    expect(
      classifyDictationError(new Error('Speech recognition error: network')),
    ).toBe('failed');
  });
});

describe('insertTextAtCursor', () => {
  it('inserts at the cursor with spacing and fires input', () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.value = 'Make it brighter';
    field.focus();
    field.setSelectionRange(7, 7);
    const onInput = vi.fn();
    field.addEventListener('input', onInput);
    insertTextAtCursor(field, 'a bit');
    expect(field.value).toBe('Make it a bit brighter');
    expect(field.selectionStart).toBe('Make it a bit'.length);
    expect(onInput).toHaveBeenCalledTimes(1);
    field.remove();
  });

  it('appends to a field the cursor has not been in', () => {
    const field = document.createElement('textarea');
    field.value = 'Crop it';
    field.setSelectionRange(0, 0);
    insertTextAtCursor(field, 'square');
    expect(field.value).toBe('Crop it square');
  });
});
