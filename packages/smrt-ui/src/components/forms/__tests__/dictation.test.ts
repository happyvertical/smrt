/**
 * Dictation state machine over a fake speech source (no real microphone:
 * speech recognition cannot run headless). Covers start → listening (with the
 * ready beep) → final text → stop, errors in plain kinds, and "stopped
 * before the microphone opened".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDictationError,
  Dictation,
  type DictationSpeechResult,
  type DictationSpeechSource,
  dictationErrorCode,
} from '../dictation.svelte.js';
import { insertTextAtCursor } from '../insert-text.js';
import { createLongPress } from '../long-press.js';

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

  it("waits a slow source's own stopTimeoutMs for the text after stop", async () => {
    vi.useFakeTimers();
    try {
      const source = fakeSource();
      // A model running in the browser writes the message down after stop.
      source.stop = vi.fn(async () => {});
      Object.defineProperty(source, 'stopTimeoutMs', { value: 60_000 });
      const onText = vi.fn();
      const dictation = new Dictation({
        source: () => source,
        onText,
        beep: false,
        stopTimeoutMs: 10,
        requestMicrophone: false,
      });
      await dictation.start();
      await dictation.stop();
      expect(dictation.state).toBe('stopping');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dictation.state).toBe('stopping');
      source.emitResult('hello there', true);
      source.emitEnd();
      expect(onText).toHaveBeenCalledWith('hello there');
      expect(dictation.state).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
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
    ).toBe('unsupported');
  });

  it('reads the Web Speech code first', () => {
    const coded = (code: string, message = 'x') =>
      Object.assign(new Error(message), { speechError: code });
    expect(classifyDictationError(coded('network'))).toBe('unsupported');
    // Brave: the browser has no speech service, not a blocked microphone.
    expect(
      classifyDictationError(
        Object.assign(coded('service-not-allowed', 'Permission denied'), {
          code: 'PERMISSION_DENIED',
        }),
      ),
    ).toBe('unsupported');
    expect(classifyDictationError(coded('not-allowed'))).toBe('denied');
    expect(classifyDictationError(coded('no-speech'))).toBe('no-speech');
    expect(classifyDictationError(coded('audio-capture'))).toBe('microphone');
    expect(classifyDictationError(coded('aborted'))).toBe('interrupted');
    // A raw SpeechRecognitionErrorEvent.
    expect(classifyDictationError({ error: 'network' })).toBe('unsupported');
    expect(dictationErrorCode(coded('network'))).toBe('network');
  });
});

describe('Dictation errors are never silent', () => {
  const codes: Array<[string, string]> = [
    ['network', 'unsupported'],
    ['service-not-allowed', 'unsupported'],
    ['not-allowed', 'denied'],
    ['no-speech', 'no-speech'],
    ['audio-capture', 'microphone'],
    ['aborted', 'interrupted'],
  ];

  it.each(
    codes,
  )('%s after the beep becomes %s, with the code, and is logged', async (code, kind) => {
    const source = fakeSource({ emitStart: true });
    const log = vi.fn();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      log,
    });
    await dictation.start();
    source.emitStart();
    expect(dictation.state).toBe('listening');
    // What Chrome and Brave do: the error, then the end.
    source.emitError(
      Object.assign(new Error(`Speech recognition error: ${code}`), {
        speechError: code,
      }),
    );
    source.emitEnd();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe(kind);
    expect(dictation.errorCode).toBe(code);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({ kind, code, stage: 'error' });
  });

  it('logs to the console by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = fakeSource();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
    });
    await dictation.start();
    source.emitError(
      Object.assign(new Error('Network error'), { speechError: 'network' }),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[network]'));
    warn.mockRestore();
  });

  it('an end right after the beep, with nothing heard and no stop, is a failure', async () => {
    const source = fakeSource({ emitStart: true });
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      log: () => {},
    });
    await dictation.start();
    source.emitStart();
    source.emitEnd();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('interrupted');
  });

  it('an end before it ever listened is a failure', async () => {
    const source = fakeSource({ emitStart: true });
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      log: () => {},
    });
    await dictation.start();
    expect(dictation.state).toBe('starting');
    source.emitEnd();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('interrupted');
  });

  it('a pause after talking, or a late end, just stops', async () => {
    vi.useFakeTimers();
    try {
      const source = fakeSource({ emitStart: true });
      const dictation = new Dictation({
        source: () => source,
        onText: () => {},
        beep: false,
        log: () => {},
      });
      await dictation.start();
      source.emitStart();
      source.emitResult('make it square', true);
      source.emitEnd();
      expect(dictation.state).toBe('idle');

      await dictation.start();
      source.emitStart();
      vi.advanceTimersByTime(1500);
      source.emitEnd();
      expect(dictation.state).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('being cut off after the person stopped is just the stop', async () => {
    const source = fakeSource({ emitStart: true });
    source.stop.mockImplementation(async () => {});
    const log = vi.fn();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      log,
    });
    await dictation.start();
    source.emitStart();
    await dictation.stop();
    source.emitError(
      Object.assign(new Error('aborted'), { speechError: 'aborted' }),
    );
    source.emitEnd();
    expect(dictation.state).toBe('idle');
    expect(log).not.toHaveBeenCalled();
  });
});

describe('Dictation asks for the microphone first', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'mediaDevices', original);
    else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  function stubMedia(getUserMedia: (c: unknown) => Promise<unknown>) {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(getUserMedia) },
    });
    return navigator.mediaDevices as unknown as {
      getUserMedia: ReturnType<typeof vi.fn>;
    };
  }

  it('waits for the grant, closes the probe stream, then starts; only once', async () => {
    const track = { stop: vi.fn() };
    let grant!: () => void;
    const media = stubMedia(
      () =>
        new Promise((resolve) => {
          grant = () => resolve({ getTracks: () => [track] });
        }),
    );
    const source = fakeSource();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
    });
    const started = dictation.start();
    await vi.waitFor(() => expect(media.getUserMedia).toHaveBeenCalled());
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(dictation.state).toBe('starting');
    expect(source.start).not.toHaveBeenCalled();
    grant();
    await started;
    expect(track.stop).toHaveBeenCalled();
    expect(source.start).toHaveBeenCalledTimes(1);
    expect(dictation.state).toBe('listening');

    await dictation.stop();
    await dictation.start();
    expect(media.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('a refused prompt is "blocked", a missing microphone says so, and recognition never starts', async () => {
    stubMedia(async () => {
      throw new DOMException('Permission denied', 'NotAllowedError');
    });
    const source = fakeSource();
    const denied = new Dictation({
      source: () => source,
      onText: () => {},
      log: () => {},
    });
    await denied.start();
    expect(denied.errorKind).toBe('denied');
    expect(denied.errorCode).toBe('NotAllowedError');
    expect(source.start).not.toHaveBeenCalled();

    stubMedia(async () => {
      throw new DOMException('Requested device not found', 'NotFoundError');
    });
    const none = new Dictation({
      source: () => fakeSource(),
      onText: () => {},
      log: () => {},
    });
    await none.start();
    expect(none.errorKind).toBe('microphone');
  });

  it('can be turned off', async () => {
    const media = stubMedia(async () => ({ getTracks: () => [] }));
    const dictation = new Dictation({
      source: () => fakeSource(),
      onText: () => {},
      beep: false,
      requestMicrophone: false,
    });
    await dictation.start();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(dictation.state).toBe('listening');
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

describe('Dictation with a long press', () => {
  it('letting go after the press keeps listening', async () => {
    vi.useFakeTimers();
    try {
      const source = fakeSource({ emitStart: true });
      const dictation = new Dictation({
        source: () => source,
        onText: () => {},
        beep: false,
        log: () => {},
      });
      const press = createLongPress({
        onLongPress: () => void dictation.start(),
        onRelease: () => void dictation.unlock(),
      });
      const at = {
        isPrimary: true,
        pointerId: 1,
        pointerType: 'touch',
        button: 0,
        clientX: 10,
        clientY: 10,
        target: document.body,
      };
      press.handlePointerDown({
        ...at,
        type: 'pointerdown',
      } as unknown as PointerEvent);
      vi.advanceTimersByTime(600);
      await vi.waitFor(() => expect(source.start).toHaveBeenCalled());
      source.emitStart();
      expect(dictation.state).toBe('listening');
      press.handlePointerUp({
        ...at,
        type: 'pointerup',
      } as unknown as PointerEvent);
      const click = new Event('click', { cancelable: true });
      press.handleClick(click);
      vi.advanceTimersByTime(300);
      expect(dictation.state).toBe('listening');
      expect(source.stop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
