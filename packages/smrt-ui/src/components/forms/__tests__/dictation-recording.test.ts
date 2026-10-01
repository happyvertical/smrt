/**
 * Dictation's recording fallback: when the browser has no speech recognition
 * (Firefox) or it fails with no speech service behind it (Brave), record with
 * MediaRecorder and hand the audio to `transcribe`. Fake speech source, fake
 * recorder, fake MediaRecorder: nothing here touches a real microphone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMediaRecorderCapture,
  type DictationAudioCapture,
  DictationError,
  type DictationRecording,
  pickDictationMimeType,
} from '../audio-capture.js';
import {
  Dictation,
  type DictationLogEvent,
  type DictationSpeechResult,
  type DictationSpeechSource,
} from '../dictation.svelte.js';
import { createHttpTranscriber } from '../dictation-transcribe.js';

function fakeSource(options: { startError?: Error } = {}) {
  const results = new Set<(r: DictationSpeechResult) => void>();
  const errors = new Set<(e: Error) => void>();
  const ends = new Set<() => void>();
  return {
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
    }),
    stop: vi.fn(async () => {
      for (const cb of ends) cb();
    }),
    onResult: (cb: (r: DictationSpeechResult) => void) => (
      results.add(cb), () => results.delete(cb)
    ),
    onError: (cb: (e: Error) => void) => (
      errors.add(cb), () => errors.delete(cb)
    ),
    onEnd: (cb: () => void) => (ends.add(cb), () => ends.delete(cb)),
    emitResult(text: string, isFinal: boolean) {
      for (const cb of results) cb({ text, isFinal });
    },
    emitError(error: Error) {
      for (const cb of errors) cb(error);
    },
    emitEnd() {
      for (const cb of ends) cb();
    },
  } satisfies DictationSpeechSource & Record<string, unknown>;
}

function speechError(code: string): Error {
  return Object.assign(new Error(`Speech recognition error: ${code}`), {
    speechError: code,
  });
}

interface FakeCapture extends DictationAudioCapture {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  hitLimit(reason: 'time' | 'size'): void;
}

function fakeCaptureFactory(
  options: {
    startError?: Error;
    startGate?: Promise<void>;
    recording?: Partial<DictationRecording>;
    stopError?: Error;
  } = {},
) {
  const made: FakeCapture[] = [];
  const factory = vi.fn(() => {
    const limits = new Set<(reason: 'time' | 'size') => void>();
    const capture: FakeCapture = {
      start: vi.fn(async () => {
        await options.startGate;
        if (options.startError) throw options.startError;
      }),
      stop: vi.fn(async () => {
        if (options.stopError) throw options.stopError;
        return {
          audio: new Blob(['opus-bytes'], { type: 'audio/webm;codecs=opus' }),
          mimeType: 'audio/webm;codecs=opus',
          durationMs: 3200,
          reachedTimeLimit: false,
          ...options.recording,
        };
      }),
      cancel: vi.fn(),
      onLimit: (cb) => (limits.add(cb), () => limits.delete(cb)),
      hitLimit(reason) {
        for (const cb of limits) cb(reason);
      },
    };
    made.push(capture);
    return capture;
  });
  return { factory, made };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Dictation recording fallback', () => {
  it('records when there is no speech source, then writes it down', async () => {
    const { factory, made } = fakeCaptureFactory();
    const transcribe = vi.fn(async () => 'make it square');
    const onText = vi.fn();
    const beep = vi.fn(async () => true);
    const dictation = new Dictation({
      onText,
      transcribe,
      capture: factory,
      beep,
      language: 'en-CA',
      maxDurationMs: 90_000,
      maxBytes: 5_000_000,
    });
    expect(dictation.available).toBe(true);
    await dictation.start();
    expect(dictation.state).toBe('listening');
    expect(dictation.recording).toBe(true);
    expect(factory).toHaveBeenCalledWith({
      maxDurationMs: 90_000,
      maxBytes: 5_000_000,
    });
    await vi.waitFor(() => expect(beep).toHaveBeenCalledTimes(1));

    let release!: (text: string) => void;
    transcribe.mockImplementationOnce(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const stopped = dictation.stop();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
    expect(dictation.state).toBe('transcribing');
    expect(dictation.active).toBe(false);
    release('  make it square ');
    await stopped;

    expect(made[0].stop).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), {
      mimeType: 'audio/webm;codecs=opus',
      language: 'en-CA',
      durationMs: 3200,
      signal: expect.any(AbortSignal),
    });
    expect(onText).toHaveBeenCalledWith('make it square');
    expect(dictation.state).toBe('idle');
    expect(dictation.recording).toBe(false);
  });

  it('switches to recording when Brave fails with `network`, and records straight away next time', async () => {
    const source = fakeSource();
    const { factory, made } = fakeCaptureFactory();
    const log = vi.fn<(event: DictationLogEvent) => void>();
    const onText = vi.fn();
    const dictation = new Dictation({
      source: () => source,
      onText,
      transcribe: async () => 'the arena at night',
      capture: factory,
      beep: false,
      requestMicrophone: false,
      log,
    });
    await dictation.start();
    expect(dictation.state).toBe('listening');
    expect(dictation.recording).toBe(false);

    source.emitError(speechError('network'));
    await vi.waitFor(() => expect(made).toHaveLength(1));
    await vi.waitFor(() => expect(made[0].start).toHaveBeenCalled());
    await made[0].start.mock.results[0].value;
    await Promise.resolve();
    expect(dictation.state).toBe('listening');
    expect(dictation.recording).toBe(true);
    expect(source.stop).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'unsupported',
        code: 'network',
        fallback: 'recording',
      }),
    );

    await dictation.stop();
    expect(onText).toHaveBeenCalledWith('the arena at night');
    expect(dictation.state).toBe('idle');

    source.start.mockClear();
    await dictation.start();
    expect(source.start).not.toHaveBeenCalled();
    expect(made).toHaveLength(2);
    expect(dictation.recording).toBe(true);
  });

  it('records when the recogniser refuses to start (`service-not-allowed`)', async () => {
    const source = fakeSource({
      startError: speechError('service-not-allowed'),
    });
    const { factory, made } = fakeCaptureFactory();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      transcribe: async () => 'hello',
      capture: factory,
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.state).toBe('listening'));
    expect(dictation.recording).toBe(true);
    expect(made).toHaveLength(1);
  });

  it('records when the browser has no speech recognition at all (Firefox)', async () => {
    const { factory } = fakeCaptureFactory();
    const dictation = new Dictation({
      source: () => {
        throw Object.assign(new Error('Speech recognition not available'), {
          code: 'CAPABILITY_NOT_AVAILABLE',
        });
      },
      onText: () => {},
      transcribe: async () => 'hello',
      capture: factory,
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await dictation.start();
    await vi.waitFor(() => expect(dictation.state).toBe('listening'));
    expect(dictation.recording).toBe(true);
  });

  it('records when the recogniser ends straight away without an error', async () => {
    const source = fakeSource();
    const { factory } = fakeCaptureFactory();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      transcribe: async () => 'hello',
      capture: factory,
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await dictation.start();
    source.emitEnd();
    await vi.waitFor(() => expect(dictation.recording).toBe(true));
    expect(dictation.state).toBe('listening');
  });

  it('keeps the plain error without a transcribe function', async () => {
    const source = fakeSource();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await dictation.start();
    source.emitError(speechError('network'));
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('unsupported');
  });

  it('does not switch after words were already heard', async () => {
    const source = fakeSource();
    const { factory } = fakeCaptureFactory();
    const dictation = new Dictation({
      source: () => source,
      onText: () => {},
      transcribe: async () => 'x',
      capture: factory,
      beep: false,
      requestMicrophone: false,
      log: () => {},
    });
    await dictation.start();
    source.emitResult('hello', true);
    source.emitError(speechError('network'));
    expect(dictation.state).toBe('error');
    expect(factory).not.toHaveBeenCalled();
  });

  it('does not record over a blocked microphone', async () => {
    const { factory } = fakeCaptureFactory({
      startError: Object.assign(new Error('Permission denied'), {
        name: 'NotAllowedError',
      }),
    });
    const dictation = new Dictation({
      onText: () => {},
      transcribe: async () => 'x',
      capture: factory,
      beep: false,
      log: () => {},
    });
    await dictation.start();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe('denied');
  });

  it.each([
    [new DictationError('too-long', 'too big'), 'too-long'],
    [new DictationError('unavailable', 'not set up'), 'unavailable'],
    [new DictationError('forbidden', 'no'), 'forbidden'],
    [new Error('Failed to fetch: network down'), 'not-transcribed'],
  ])('says why writing it down failed (%s)', async (error, kind) => {
    const { factory } = fakeCaptureFactory();
    const onText = vi.fn();
    const dictation = new Dictation({
      onText,
      transcribe: async () => {
        throw error;
      },
      capture: factory,
      beep: false,
      log: () => {},
    });
    await dictation.start();
    await dictation.stop();
    expect(dictation.state).toBe('error');
    expect(dictation.errorKind).toBe(kind);
    expect(onText).not.toHaveBeenCalled();
  });

  it('says nothing was heard when the text comes back empty', async () => {
    const { factory } = fakeCaptureFactory();
    const dictation = new Dictation({
      onText: () => {},
      transcribe: async () => ({ text: '   ' }),
      capture: factory,
      beep: false,
      log: () => {},
    });
    await dictation.start();
    await dictation.stop();
    expect(dictation.errorKind).toBe('no-speech');
  });

  it('writes the recording down by itself at the time limit', async () => {
    const { factory, made } = fakeCaptureFactory({
      recording: { reachedTimeLimit: true, durationMs: 120_000 },
    });
    const onText = vi.fn();
    const dictation = new Dictation({
      onText,
      transcribe: async () => 'a long story',
      capture: factory,
      beep: false,
    });
    await dictation.start();
    made[0].hitLimit('time');
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('a long story'));
    expect(dictation.state).toBe('idle');
  });

  it('fails as too long when the recording outgrows the size limit', async () => {
    const { factory, made } = fakeCaptureFactory({
      stopError: new DictationError('too-long', 'too large'),
    });
    const transcribe = vi.fn(async () => 'x');
    const dictation = new Dictation({
      onText: () => {},
      transcribe,
      capture: factory,
      beep: false,
      log: () => {},
    });
    await dictation.start();
    made[0].hitLimit('size');
    await vi.waitFor(() => expect(dictation.state).toBe('error'));
    expect(dictation.errorKind).toBe('too-long');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('stops quietly when the person stops before the microphone opened', async () => {
    let open!: () => void;
    const { factory, made } = fakeCaptureFactory({
      startGate: new Promise<void>((resolve) => (open = resolve)),
    });
    const transcribe = vi.fn(async () => 'x');
    const dictation = new Dictation({
      onText: () => {},
      transcribe,
      capture: factory,
      beep: false,
    });
    const started = dictation.start();
    await vi.waitFor(() => expect(made).toHaveLength(1));
    expect(dictation.state).toBe('starting');
    await dictation.stop();
    expect(dictation.state).toBe('idle');
    expect(made[0].cancel).toHaveBeenCalled();
    open();
    await started;
    expect(dictation.state).toBe('idle');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('cancels writing it down when disposed', async () => {
    const { factory } = fakeCaptureFactory();
    let signal!: AbortSignal;
    const onText = vi.fn();
    const dictation = new Dictation({
      onText,
      transcribe: (_audio, options) => {
        signal = options.signal;
        return new Promise<string>(() => {});
      },
      capture: factory,
      beep: false,
    });
    await dictation.start();
    void dictation.stop();
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(dictation.state).toBe('transcribing');
    dictation.dispose();
    expect(signal.aborted).toBe(true);
    expect(dictation.state).toBe('idle');
    expect(onText).not.toHaveBeenCalled();
  });

  it('gives up writing it down after the timeout', async () => {
    const { factory } = fakeCaptureFactory();
    const dictation = new Dictation({
      onText: () => {},
      transcribe: (_audio, { signal }) =>
        new Promise<string>((_resolve, reject) =>
          signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          ),
        ),
      capture: factory,
      beep: false,
      transcribeTimeoutMs: 20,
      log: () => {},
    });
    await dictation.start();
    await dictation.stop();
    expect(dictation.errorKind).toBe('not-transcribed');
    expect(dictation.errorCode).toBe('timeout');
  });

  it('ignores taps while writing it down', async () => {
    const { factory, made } = fakeCaptureFactory();
    const dictation = new Dictation({
      onText: () => {},
      transcribe: () => new Promise<string>(() => {}),
      capture: factory,
      beep: false,
    });
    await dictation.start();
    void dictation.stop();
    await vi.waitFor(() => expect(dictation.state).toBe('transcribing'));
    await dictation.toggle();
    expect(dictation.state).toBe('transcribing');
    expect(made).toHaveLength(1);
    dictation.dispose();
  });
});

describe('createHttpTranscriber', () => {
  it('posts the raw audio with its type, language and length, and reads the text', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: 'hello there' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const transcribe = createHttpTranscriber('/sites/x/api/transcribe', {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const audio = new Blob(['bytes'], { type: 'audio/mp4' });
    const controller = new AbortController();
    const text = await transcribe(audio, {
      mimeType: 'audio/mp4',
      language: 'en-US',
      durationMs: 4321.4,
      signal: controller.signal,
    });
    expect(text).toBe('hello there');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/sites/x/api/transcribe');
    expect(parsed.searchParams.get('language')).toBe('en-US');
    expect(parsed.searchParams.get('durationMs')).toBe('4321');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(audio);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'audio/mp4',
    );
    expect(init.signal).toBe(controller.signal);
  });

  it.each([
    [413, 'too-long'],
    [503, 'unavailable'],
    [403, 'forbidden'],
    [401, 'forbidden'],
    [502, 'not-transcribed'],
  ])('turns HTTP %i into %s', async (status, kind) => {
    const transcribe = createHttpTranscriber('/t', {
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'nope' }), {
          status,
        })) as unknown as typeof globalThis.fetch,
    });
    const error = await transcribe(new Blob(['x']), {
      mimeType: 'audio/webm',
      language: 'en',
      durationMs: 1,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DictationError);
    expect((error as DictationError).dictationKind).toBe(kind);
    expect((error as DictationError).message).toBe('nope');
  });
});

class FakeMediaRecorder extends EventTarget {
  static supported = new Set(['audio/webm;codecs=opus', 'audio/webm']);
  static isTypeSupported(type: string) {
    return FakeMediaRecorder.supported.has(type);
  }
  static last: FakeMediaRecorder | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  timeslice: number | undefined;
  constructor(
    public stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    super();
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.last = this;
  }
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => this.dispatchEvent(new Event('stop')));
  }
  emitData(bytes: number) {
    const event = Object.assign(new Event('dataavailable'), {
      data: new Blob([new Uint8Array(bytes)]),
    });
    this.dispatchEvent(event);
  }
}

function stubMedia() {
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { track, getUserMedia };
}

describe('createMediaRecorderCapture', () => {
  it('prefers WebM/Opus, then MP4 (Safari)', () => {
    stubMedia();
    expect(pickDictationMimeType()).toBe('audio/webm;codecs=opus');
    FakeMediaRecorder.supported = new Set(['audio/mp4']);
    expect(pickDictationMimeType()).toBe('audio/mp4');
    FakeMediaRecorder.supported = new Set([
      'audio/webm;codecs=opus',
      'audio/webm',
    ]);
  });

  it('records, stops, and closes the microphone', async () => {
    const { track, getUserMedia } = stubMedia();
    const capture = createMediaRecorderCapture({});
    await capture.start();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    const recorder = FakeMediaRecorder.last!;
    expect(recorder.mimeType).toBe('audio/webm;codecs=opus');
    expect(recorder.timeslice).toBe(1000);
    recorder.emitData(100);
    recorder.emitData(50);
    const recording = await capture.stop();
    expect(recording.audio.size).toBe(150);
    expect(recording.mimeType).toBe('audio/webm;codecs=opus');
    expect(recording.reachedTimeLimit).toBe(false);
    expect(track.stop).toHaveBeenCalled();
  });

  it('stops by itself at the time limit and keeps the audio', async () => {
    vi.useFakeTimers();
    const { track } = stubMedia();
    const capture = createMediaRecorderCapture({ maxDurationMs: 5000 });
    const onLimit = vi.fn();
    capture.onLimit(onLimit);
    await capture.start();
    FakeMediaRecorder.last!.emitData(10);
    vi.advanceTimersByTime(5000);
    expect(onLimit).toHaveBeenCalledWith('time');
    expect(track.stop).toHaveBeenCalled();
    const recording = await capture.stop();
    expect(recording.reachedTimeLimit).toBe(true);
    expect(recording.audio.size).toBe(10);
  });

  it('fails as too long past the size limit', async () => {
    stubMedia();
    const capture = createMediaRecorderCapture({ maxBytes: 100 });
    const onLimit = vi.fn();
    capture.onLimit(onLimit);
    await capture.start();
    FakeMediaRecorder.last!.emitData(80);
    FakeMediaRecorder.last!.emitData(80);
    expect(onLimit).toHaveBeenCalledWith('size');
    const error = await capture.stop().catch((e: unknown) => e);
    expect((error as DictationError).dictationKind).toBe('too-long');
  });

  it('reports a browser that cannot record', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const capture = createMediaRecorderCapture({});
    const error = await capture.start().catch((e: unknown) => e);
    expect((error as DictationError).dictationKind).toBe('unsupported');
  });
});
