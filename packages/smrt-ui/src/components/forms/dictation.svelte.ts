/**
 * Dictation: speak into a text field.
 *
 * The state machine behind the microphone button and "long-press a field to
 * speak". It does not recognise speech itself: the host hands it a speech
 * source, normally smrt-svelte's browser speech-to-text adapter
 * (`createSttDictationSource` in `@happyvertical/smrt-svelte/browser-ai`),
 * whose adapters already satisfy `DictationSpeechSource`. That keeps smrt-ui
 * free of the Provider and the speech engines, and gives one speech engine
 * for forms, chat, and anything else.
 *
 * States: `idle` → `starting` → `listening` → `stopping` → `idle`, and
 * `error` (with `errorKind`) from any of them. A "ready" beep plays when the
 * microphone is actually listening. Final phrases go to `onText` (put them
 * in the field with `insertTextAtCursor`); the phrase in progress is
 * `interim`.
 *
 * How listening stops: tap the microphone again (`toggle`/`stop`), send the
 * form, press Escape, or pause talking (the browser ends it). A long press
 * starts listening and it keeps listening after the finger comes up, so the
 * person can press, hear the beep, let go, and talk.
 *
 * On first use it asks for the microphone (`getUserMedia`) and waits for the
 * answer before it starts recognising, so the permission prompt cannot cut
 * the recogniser off and a "no" shows as "the microphone is blocked".
 *
 * It never stops silently. Every recogniser error becomes an `error` state
 * with a plain `errorKind` (and the raw `errorCode`, and a console warning);
 * a recogniser that ends on its own within `earlyEndMs` of starting without
 * hearing anything (Brave's speech recognition does this) is an error too.
 *
 * Recording fallback: give it a `transcribe` function and, when the browser
 * has no speech recognition (Firefox), or it fails with no speech service
 * behind it (Brave: Web Speech `network` / `service-not-allowed`, or an end
 * straight away), it records the message with `MediaRecorder` instead
 * (WebM/Opus, or MP4 on Safari; capped at `maxDurationMs` and `maxBytes`).
 * When the person stops, the state is `transcribing` ("Writing it down…")
 * while `transcribe(audio, { mimeType, language })` turns the recording into
 * text, which goes to `onText` like a spoken phrase. Once the browser's
 * recogniser has failed, this `Dictation` records straight away next time.
 *
 * Hands-free: with `mode: 'hands-free'`, a `handsFreeCapture` factory and a
 * source that has `transcribePcm` (smrt-svelte's on-device `whisper-local`
 * and `moonshine`), listening starts once and then stays on. The microphone
 * is cut into utterances on the device: `speaking` is true while one is
 * being spoken, `level` follows the voice, and each finished utterance is
 * written down (`queued` counts those waiting) and handed to `onText` in
 * the order spoken, while the next one is already being heard. One tap ends
 * it; whatever was said last is still written down (`transcribing`) before
 * it goes `idle`. Where any of the three is missing it is ordinary
 * press-to-talk.
 */
import {
  canCaptureDictationAudio,
  createMediaRecorderCapture,
  type DictationAudioCapture,
  type DictationAudioCaptureFactory,
  DictationError,
} from './audio-capture.js';
import type { DictationTranscribe } from './dictation-transcribe.js';
import type {
  HandsFreeCapture,
  HandsFreeCaptureFactory,
  HandsFreeUtterance,
  HandsFreeVadOptions,
} from './hands-free-capture.js';
import { playReadyBeep } from './ready-beep.js';

export type DictationState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping'
  | 'transcribing'
  | 'error';

/**
 * Why dictation stopped with an error:
 * - `unsupported`: this browser cannot recognise speech, or has no speech
 *   service behind it (Web Speech `network` / `service-not-allowed`: Brave);
 * - `denied`: the microphone is blocked;
 * - `no-speech`: nothing was heard;
 * - `microphone`: no microphone, or it could not be opened (`audio-capture`);
 * - `interrupted`: it stopped straight away without hearing anything
 *   (`aborted`, or an early end with no error);
 * - `too-long`: the recording was too long or too large to write down;
 * - `not-transcribed`: the recording could not be written down;
 * - `unavailable`: writing recordings down is not set up here;
 * - `forbidden`: this person may not use it here;
 * - `model-missing`: the on-device speech model is not downloaded (dictation
 *   never downloads it; the host asks first and loads it);
 * - `failed`: anything else.
 */
export type DictationErrorKind =
  | 'unsupported'
  | 'denied'
  | 'no-speech'
  | 'microphone'
  | 'interrupted'
  | 'too-long'
  | 'not-transcribed'
  | 'unavailable'
  | 'model-missing'
  | 'forbidden'
  | 'failed';

const DICTATION_ERROR_KINDS = new Set<DictationErrorKind>([
  'unsupported',
  'denied',
  'no-speech',
  'microphone',
  'interrupted',
  'too-long',
  'not-transcribed',
  'unavailable',
  'model-missing',
  'forbidden',
  'failed',
]);

export interface DictationSpeechResult {
  text: string;
  isFinal: boolean;
}

export interface DictationStartOptions {
  language?: string;
  continuous?: boolean;
  interimResults?: boolean;
}

/**
 * A speech recogniser. smrt-svelte's `STTAdapter` satisfies it structurally.
 * `start` may reject (not supported, microphone blocked); later failures
 * arrive through `onError`, and `onEnd` fires when it stops listening.
 */
export interface DictationSpeechSource {
  start(options?: DictationStartOptions): Promise<void>;
  stop(): Promise<void>;
  onResult(callback: (result: DictationSpeechResult) => void): () => void;
  onError(callback: (error: Error) => void): () => void;
  onEnd(callback: () => void): () => void;
  /** When given, listening (and the beep) starts on this event. */
  onStart?(callback: () => void): () => void;
  /**
   * Write down one finished utterance (16 kHz mono PCM, -1 to 1) and resolve
   * the text (empty when nothing intelligible was said). A source that has
   * it can be used in hands-free mode, where `Dictation` captures and
   * segments the microphone itself and never calls `start`.
   */
  transcribePcm?(
    pcm: Float32Array,
    options?: { language?: string },
  ): Promise<string>;
  /**
   * Check the source can write down speech now, before the microphone opens
   * (hands-free calls it; push-to-talk sources do the same inside `start`).
   * Rejects when it cannot, for example an on-device model that is not
   * downloaded yet. It must never start a download itself.
   */
  prepare?(): Promise<void>;
  /**
   * How long to wait for the source to finish after `stop()` before giving
   * up (default: the `stopTimeoutMs` option). A source that writes the
   * message down after the person stops (a model running in the browser)
   * needs far longer than one that has the text already.
   */
  readonly stopTimeoutMs?: number;
}

/** Resolves the speech source on first use (it may load lazily). */
export type DictationSourceProvider = () =>
  | DictationSpeechSource
  | Promise<DictationSpeechSource>;

export interface DictationOptions {
  /** The speech source; without one dictation reports `unsupported`. */
  source?: DictationSourceProvider | null;
  /** A finished phrase to put into the field. */
  onText: (text: string) => void;
  /** The phrase in progress (also on `interim`). */
  onInterim?: (text: string) => void;
  /** BCP-47 language. Default: the page's `lang`, else `en-US`. */
  language?: string;
  /**
   * The ready beep: `true` (default) plays the built-in beep, `false` none,
   * or a function that plays one and resolves whether it did.
   */
  beep?: boolean | (() => Promise<boolean> | boolean);
  /** How long to wait for the source to confirm it stopped. Default 1500ms. */
  stopTimeoutMs?: number;
  /**
   * Ask for the microphone (`getUserMedia`) and wait for the answer before
   * starting the source, once per `Dictation`. Default `true`; skipped where
   * the browser has no `navigator.mediaDevices`.
   */
  requestMicrophone?: boolean;
  /**
   * A source that ends by itself this soon after it started listening,
   * without a result and without being asked to stop, failed
   * (`interrupted`). Default 1000ms; `0` turns the check off.
   */
  earlyEndMs?: number;
  /**
   * Where problems are reported (default: `console.warn`). Never given the
   * audio or the words heard.
   */
  log?: (event: DictationLogEvent) => void;
  /**
   * Turns a recorded message into text. With it, dictation records instead
   * when the browser cannot recognise speech (see the module comment), and
   * without a `source` it always records. Normally
   * `createHttpTranscriber('/your/route')`: the speech service's key stays on
   * the server.
   */
  transcribe?: DictationTranscribe | null;
  /** Records the message (default: `MediaRecorder`). For tests and hosts. */
  capture?: DictationAudioCaptureFactory;
  /**
   * `'push'` (default): listen until stopped. `'hands-free'`: stay on and
   * write down each utterance as it ends (see the module comment). Needs
   * `handsFreeCapture` and a source with `transcribePcm`, else it is `'push'`.
   */
  mode?: 'push' | 'hands-free';
  /**
   * The microphone for hands-free mode, normally `createHandsFreeCapture`
   * from `@happyvertical/smrt-ui/forms/hands-free`.
   */
  handsFreeCapture?: HandsFreeCaptureFactory | null;
  /** Voice activity tuning for hands-free mode (pause length, sensitivity). */
  vad?: HandsFreeVadOptions;
  /** Longest recording, in ms; it stops and is written down then. Default 120000. */
  maxDurationMs?: number;
  /** Largest recording, in bytes. Default 10 MB. */
  maxBytes?: number;
  /** How long writing a recording down may take. Default 60000ms. */
  transcribeTimeoutMs?: number;
}

/** A dictation problem, for logs. */
export interface DictationLogEvent {
  kind: DictationErrorKind;
  /** Raw code: the Web Speech error (`network`, …) or the error's name. */
  code: string | null;
  message: string;
  /**
   * Where it happened: `microphone`, `source`, `start`, `error`, `end`, or
   * in the recording fallback `record` / `transcribe`.
   */
  stage:
    | 'microphone'
    | 'source'
    | 'start'
    | 'error'
    | 'end'
    | 'record'
    | 'transcribe'
    | 'hands-free';
  /** Set when dictation carried on by recording instead of stopping. */
  fallback?: 'recording';
}

const TRANSCRIBE_ERROR_KINDS = new Set<DictationErrorKind>([
  'too-long',
  'not-transcribed',
  'unavailable',
  'forbidden',
  'no-speech',
]);

const SPEECH_ERROR_KINDS: Record<string, DictationErrorKind> = {
  network: 'unsupported',
  'service-not-allowed': 'unsupported',
  'language-not-supported': 'unsupported',
  'not-allowed': 'denied',
  'no-speech': 'no-speech',
  'audio-capture': 'microphone',
  aborted: 'interrupted',
};

/** The raw code of a speech or media error, when it has one. */
export function dictationErrorCode(error: unknown): string | null {
  if (error instanceof DictationError) return error.code;
  const e = (error ?? {}) as {
    speechError?: unknown;
    error?: unknown;
    name?: unknown;
    code?: unknown;
  };
  if (typeof e.speechError === 'string') return e.speechError;
  // A raw SpeechRecognitionErrorEvent carries the code as `error`.
  if (typeof e.error === 'string') return e.error;
  if (typeof e.code === 'string') return e.code;
  if (typeof e.name === 'string' && e.name !== 'Error') return e.name;
  return null;
}

/**
 * Sort a speech error into a `DictationErrorKind`. Reads the error's `code`
 * and `name` (smrt-svelte browser-ai errors: `PERMISSION_DENIED`,
 * `CAPABILITY_NOT_AVAILABLE`) and the Web Speech error names.
 */
export function classifyDictationError(error: unknown): DictationErrorKind {
  const known = (error as { dictationKind?: unknown } | null)?.dictationKind;
  if (
    typeof known === 'string' &&
    DICTATION_ERROR_KINDS.has(known as DictationErrorKind)
  ) {
    return known as DictationErrorKind;
  }
  const e = (error ?? {}) as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    speechError?: unknown;
    error?: unknown;
  };
  const speechCode =
    typeof e.speechError === 'string'
      ? e.speechError
      : typeof e.error === 'string'
        ? e.error
        : '';
  if (speechCode && SPEECH_ERROR_KINDS[speechCode]) {
    return SPEECH_ERROR_KINDS[speechCode];
  }
  const code = typeof e.code === 'string' ? e.code : '';
  const name = typeof e.name === 'string' ? e.name : '';
  const message =
    typeof e.message === 'string'
      ? e.message.toLowerCase()
      : String(error ?? '').toLowerCase();
  if (
    code === 'PERMISSION_DENIED' ||
    name === 'PermissionDeniedError' ||
    name === 'NotAllowedError' ||
    /not-allowed|service-not-allowed|permission denied/.test(message)
  ) {
    return 'denied';
  }
  if (
    code === 'CAPABILITY_NOT_AVAILABLE' ||
    code === 'UNSUPPORTED_ADAPTER' ||
    name === 'CapabilityNotAvailableError' ||
    name === 'NotSupportedError' ||
    /not available|not supported|unsupported/.test(message)
  ) {
    return 'unsupported';
  }
  if (
    name === 'NotFoundError' ||
    name === 'NotReadableError' ||
    name === 'OverconstrainedError' ||
    /audio capture|audio-capture/.test(message)
  ) {
    return 'microphone';
  }
  if (/no speech|no-speech/.test(message)) return 'no-speech';
  if (/network/.test(message)) return 'unsupported';
  if (/aborted/.test(message)) return 'interrupted';
  return 'failed';
}

function pageLanguage(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.getAttribute('lang');
    if (lang) return lang;
  }
  return 'en-US';
}

function defaultLog(event: DictationLogEvent): void {
  // biome-ignore lint/suspicious/noConsole: dictation must never fail silently; this is the diagnostic trail.
  console.warn(
    `[dictation] stopped (${event.kind}) at ${event.stage}` +
      (event.code ? ` [${event.code}]` : '') +
      `: ${event.message}` +
      (event.fallback === 'recording' ? ' (recording instead)' : ''),
  );
}

export class Dictation {
  /** Where dictation is (see the module comment). */
  state = $state<DictationState>('idle');
  /** Why it stopped, while `state` is `error`. */
  errorKind = $state<DictationErrorKind | null>(null);
  /** The raw error code behind `errorKind` (`network`, `NotAllowedError`…). */
  errorCode = $state<string | null>(null);
  /** The phrase being spoken right now. */
  interim = $state('');
  /** The ready beep could not play yet (no user gesture); `unlock` plays it. */
  beepPending = $state(false);
  /**
   * `true` while this message is being recorded (the fallback) rather than
   * recognised by the browser.
   */
  recording = $state(false);
  /** This session is hands-free: the microphone stays on between phrases. */
  handsFree = $state(false);
  /** Hands-free: someone is speaking right now (an utterance is open). */
  speaking = $state(false);
  /**
   * Hands-free: listening is paused (`suspend()`), for example while the page
   * reads a reply aloud, so the microphone does not hear the assistant.
   */
  suspended = $state(false);
  /** `suspend()` was called and not yet undone (it may precede the start). */
  #suspendWanted = false;
  /** Hands-free: how loud the voice is, 0 to 1 (in steps of 0.05). */
  level = $state(0);
  /** Hands-free: utterances heard that are not written down yet. */
  queued = $state(0);

  #options: DictationOptions;
  #source: DictationSpeechSource | null = null;
  #sourcePromise: Promise<DictationSpeechSource> | null = null;
  #unsubscribe: Array<() => void> = [];
  #session = 0;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #microphoneReady = false;
  /** When the source said it is listening (for the early-end check). */
  #listeningAt = 0;
  /** A result arrived in this session. */
  #heard = false;
  /** The browser's recogniser failed for want of a speech service. */
  #speechBroken = false;
  /** The recorder for this message, in the recording fallback. */
  #capture: DictationAudioCapture | null = null;
  /** The recorder is recording (its `start` resolved). */
  #captureReady = false;
  #captureOff: (() => void) | null = null;
  /** Cancels writing a recording down. */
  #transcribeAbort: AbortController | null = null;
  /** The hands-free microphone, while open. */
  #handsFreeCapture: HandsFreeCapture | null = null;
  /** Hands-free utterances are written down one at a time, in order. */
  #utteranceQueue: Promise<void> = Promise.resolve();
  /** The person ended hands-free; the queue is being drained. */
  #handsFreeDraining = false;

  constructor(options: DictationOptions) {
    this.#options = options;
  }

  /** A speech source or a `transcribe` was given (the browser may still turn out unable). */
  get available(): boolean {
    return Boolean(this.#options.source || this.#options.transcribe);
  }

  /**
   * Hands-free is set up: `mode: 'hands-free'` with a microphone factory.
   * (Whether the speech source can do it is only known once it loads.)
   */
  get wantsHandsFree(): boolean {
    return (
      this.#options.mode === 'hands-free' &&
      Boolean(this.#options.handsFreeCapture)
    );
  }

  /** Starting or listening. */
  get active(): boolean {
    return this.state === 'starting' || this.state === 'listening';
  }

  /** Replace options (for example a new `onText`). */
  setOptions(options: Partial<DictationOptions>): void {
    this.#options = { ...this.#options, ...options };
  }

  /** Start listening. A no-op while already starting, listening, or writing down. */
  async start(): Promise<void> {
    if (
      this.#disposed ||
      this.active ||
      this.state === 'stopping' ||
      this.state === 'transcribing'
    )
      return;
    this.errorKind = null;
    this.errorCode = null;
    this.interim = '';
    this.#heard = false;
    this.#listeningAt = 0;
    this.recording = false;
    this.state = 'starting';
    const session = ++this.#session;
    const provider = this.#options.source;
    if (this.#canRecord() && (this.#speechBroken || !provider)) {
      await this.#startRecording(session);
      return;
    }
    if (!provider) {
      this.#fail('unsupported', null, 'No speech source', 'source');
      return;
    }
    let source: DictationSpeechSource;
    try {
      source = await this.#resolveSource(provider);
    } catch (error) {
      if (session === this.#session)
        this.#failOrRecord(error, 'source', session);
      return;
    }
    if (session !== this.#session || this.#disposed) return;
    if (this.#wantsHandsFree(source)) {
      await this.#startHandsFree(session, source);
      return;
    }
    // Ask for the microphone first and wait for the answer: the recogniser
    // then starts with the permission settled instead of racing the prompt.
    try {
      await this.#ensureMicrophone();
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'microphone');
      return;
    }
    if (
      session !== this.#session ||
      this.#disposed ||
      this.state !== 'starting'
    )
      return;
    try {
      await source.start({
        language: this.#language(),
        continuous: true,
        interimResults: true,
      });
    } catch (error) {
      if (session === this.#session)
        this.#failOrRecord(error, 'start', session);
      return;
    }
    if (session !== this.#session || this.recording) return;
    if (!source.onStart && this.state === 'starting') this.#listening();
  }

  /**
   * Stop listening; the phrase in progress is kept if the source finishes it.
   * A recording is written down (`transcribing`) and its text handed over.
   */
  async stop(): Promise<void> {
    if (!this.active) return;
    if (this.recording) {
      await this.#finishRecording();
      return;
    }
    if (this.handsFree) {
      this.#stopHandsFree();
      return;
    }
    this.state = 'stopping';
    const session = this.#session;
    this.#clearStopTimer();
    this.#stopTimer = setTimeout(
      () => {
        if (session === this.#session && this.state === 'stopping')
          this.#idle();
      },
      this.#source?.stopTimeoutMs ?? this.#options.stopTimeoutMs ?? 1500,
    );
    try {
      await this.#source?.stop();
    } catch {
      if (session === this.#session) this.#idle();
    }
  }

  /**
   * Hands-free half-duplex gate: stop hearing while the page plays audio
   * (the microphone stays open). Safe to call before, during or after
   * hands-free; it applies whenever hands-free is on. Idempotent.
   */
  suspend(): void {
    this.#suspendWanted = true;
    if (!this.handsFree || this.suspended) return;
    this.#handsFreeCapture?.suspend?.();
    this.suspended = true;
    this.speaking = false;
    this.level = 0;
  }

  /** Undo `suspend()`: hear again after a short guard against the echo's tail. */
  resume(): void {
    this.#suspendWanted = false;
    if (!this.suspended) return;
    this.#handsFreeCapture?.resume?.();
    this.suspended = false;
  }

  /** Tap on the microphone: start, or stop while listening. */
  async toggle(): Promise<void> {
    if (this.active) await this.stop();
    else await this.start();
  }

  /** Clear an error so the field looks normal again. */
  clearError(): void {
    if (this.state === 'error') {
      this.state = 'idle';
      this.errorKind = null;
      this.errorCode = null;
    }
  }

  /**
   * Call from a user gesture (a tap, a long press's release): plays the
   * ready beep if it could not play when listening started.
   */
  async unlock(): Promise<void> {
    if (!this.beepPending) return;
    const played = await this.#playBeep();
    if (played) this.beepPending = false;
  }

  dispose(): void {
    this.#disposed = true;
    this.#session++;
    this.#clearStopTimer();
    if (this.active && !this.recording && !this.handsFree)
      void this.#source?.stop().catch(() => undefined);
    this.#dropCapture(true);
    this.#dropHandsFree();
    this.#transcribeAbort?.abort();
    this.#transcribeAbort = null;
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.state = 'idle';
    this.recording = false;
    this.#resetHandsFree();
  }

  #language(): string {
    return this.#options.language ?? pageLanguage();
  }

  /** A `transcribe` was given and this browser (or host) can record. */
  #canRecord(): boolean {
    return Boolean(
      this.#options.transcribe &&
        (this.#options.capture || canCaptureDictationAudio()),
    );
  }

  /**
   * The browser's recogniser failed in a way that means it has no speech
   * service (or none at all): record instead, if we can and nothing was
   * heard yet.
   */
  #shouldRecordInstead(
    kind: DictationErrorKind,
    stage: DictationLogEvent['stage'],
  ): boolean {
    if (!this.#canRecord() || this.#heard) return false;
    return (
      kind === 'unsupported' || (kind === 'interrupted' && stage === 'end')
    );
  }

  #failOrRecord(
    error: unknown,
    stage: DictationLogEvent['stage'],
    session: number,
  ): void {
    const kind = classifyDictationError(error);
    if (this.#shouldRecordInstead(kind, stage)) {
      this.#log(
        kind,
        dictationErrorCode(error),
        errorMessage(error),
        stage,
        true,
      );
      void this.#switchToRecording(session);
      return;
    }
    this.#failWith(error, stage);
  }

  /** Leave the browser's recogniser and record this message instead. */
  async #switchToRecording(session: number): Promise<void> {
    this.#speechBroken = true;
    this.interim = '';
    this.#clearStopTimer();
    const source = this.#source;
    this.recording = true;
    if (source) void source.stop().catch(() => undefined);
    await this.#startRecording(session);
  }

  async #startRecording(session: number): Promise<void> {
    this.recording = true;
    const factory = this.#options.capture ?? createMediaRecorderCapture;
    let capture: DictationAudioCapture;
    try {
      capture = factory({
        maxDurationMs: this.#options.maxDurationMs,
        maxBytes: this.#options.maxBytes,
      });
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'record');
      return;
    }
    this.#dropCapture(true);
    this.#capture = capture;
    // Reaching the time cap writes the recording down; growing past the size
    // cap fails (`stop` then rejects with `too-long`). Either way, stop.
    this.#captureOff = capture.onLimit(() => {
      if (session === this.#session && this.state === 'listening') {
        void this.#finishRecording();
      }
    });
    try {
      await capture.start();
      if (this.#capture === capture) this.#captureReady = true;
    } catch (error) {
      if (session === this.#session && this.#capture === capture) {
        this.#dropCapture(true);
        this.#failWith(error, 'record');
      } else {
        capture.cancel();
      }
      return;
    }
    if (
      session !== this.#session ||
      this.#disposed ||
      this.#capture !== capture ||
      !this.active
    ) {
      if (this.#capture === capture) this.#dropCapture(true);
      else capture.cancel();
      return;
    }
    // Recording from the start: it is listening now (and beeps). Switched
    // over mid-message: it already said "Listening…".
    if (this.state === 'starting') this.#listening();
  }

  /** Stop recording, write it down, and hand the text over. */
  async #finishRecording(): Promise<void> {
    const session = this.#session;
    const capture = this.#capture;
    if (!capture || !this.#captureReady) {
      // Still opening the microphone: nothing recorded yet, just stop.
      this.#dropCapture(true);
      this.#session++;
      this.#idle();
      return;
    }
    this.#dropCapture(false);
    this.state = 'transcribing';
    this.interim = '';
    this.beepPending = false;
    let recording: Awaited<ReturnType<DictationAudioCapture['stop']>>;
    try {
      recording = await capture.stop();
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'record');
      return;
    }
    if (session !== this.#session || this.#disposed) return;
    if (recording.audio.size === 0) {
      this.#fail('no-speech', null, 'The recording is empty', 'record');
      return;
    }
    const transcribe = this.#options.transcribe;
    if (!transcribe) {
      this.#fail('unavailable', null, 'No transcribe function', 'transcribe');
      return;
    }
    const controller = new AbortController();
    this.#transcribeAbort = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#options.transcribeTimeoutMs ?? 60_000);
    let text = '';
    try {
      const result = await transcribe(recording.audio, {
        mimeType: recording.mimeType,
        language: this.#language(),
        durationMs: recording.durationMs,
        signal: controller.signal,
      });
      text = (
        typeof result === 'string' ? result : (result?.text ?? '')
      ).trim();
    } catch (error) {
      if (session !== this.#session || this.#disposed) return;
      if (timedOut) {
        this.#fail(
          'not-transcribed',
          'timeout',
          'Writing the recording down took too long',
          'transcribe',
        );
      } else {
        // Only the writing-down kinds make sense here; a provider's
        // "network" error is not the browser lacking speech recognition.
        const kind = classifyDictationError(error);
        this.#fail(
          TRANSCRIBE_ERROR_KINDS.has(kind) ? kind : 'not-transcribed',
          dictationErrorCode(error),
          errorMessage(error),
          'transcribe',
        );
      }
      return;
    } finally {
      clearTimeout(timer);
      if (this.#transcribeAbort === controller) this.#transcribeAbort = null;
    }
    if (session !== this.#session || this.#disposed) return;
    if (!text) {
      this.#fail('no-speech', null, 'Nothing was written down', 'transcribe');
      return;
    }
    this.#idle();
    this.#options.onText(text);
  }

  /** Hands-free is wanted and possible with this source. */
  #wantsHandsFree(source: DictationSpeechSource): boolean {
    return Boolean(
      this.#options.mode === 'hands-free' &&
        this.#options.handsFreeCapture &&
        typeof source.transcribePcm === 'function',
    );
  }

  async #startHandsFree(
    session: number,
    source: DictationSpeechSource,
  ): Promise<void> {
    const factory = this.#options.handsFreeCapture;
    if (!factory) return;
    try {
      await source.prepare?.();
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'source');
      return;
    }
    if (session !== this.#session || this.#disposed) return;
    this.#resetHandsFree();
    this.handsFree = true;
    let capture: HandsFreeCapture;
    try {
      capture = factory({
        vad: this.#options.vad,
        onUtterance: (utterance) => {
          // Backstop for captures without their own gate.
          if (this.suspended) return;
          this.#enqueueUtterance(session, source, utterance);
        },
        onSpeaking: (speaking) => {
          if (session === this.#session && this.handsFree && !this.suspended) {
            this.speaking = speaking;
          }
        },
        onLevel: (level) => {
          if (session !== this.#session || !this.handsFree) return;
          const stepped = Math.round(Math.min(1, Math.max(0, level)) * 20) / 20;
          if (stepped !== this.level) this.level = stepped;
        },
        onError: (error) => {
          if (session === this.#session) this.#failWith(error, 'hands-free');
        },
      });
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'hands-free');
      return;
    }
    this.#handsFreeCapture = capture;
    if (this.#suspendWanted) {
      capture.suspend?.();
      this.suspended = true;
    }
    try {
      await capture.start();
    } catch (error) {
      if (this.#handsFreeCapture === capture) this.#handsFreeCapture = null;
      if (session === this.#session) this.#failWith(error, 'microphone');
      return;
    }
    if (
      session !== this.#session ||
      this.#disposed ||
      this.#handsFreeCapture !== capture ||
      !this.active
    ) {
      // Stopped (or disposed) while the microphone was opening.
      if (this.#handsFreeCapture === capture) this.#handsFreeCapture = null;
      capture.cancel();
      return;
    }
    if (this.state === 'starting') this.#listening();
  }

  /** Write one utterance down, after the ones before it. */
  #enqueueUtterance(
    session: number,
    source: DictationSpeechSource,
    utterance: HandsFreeUtterance,
  ): void {
    if (this.#disposed || session !== this.#session) return;
    this.queued += 1;
    const language = this.#language();
    this.#utteranceQueue = this.#utteranceQueue.then(async () => {
      if (this.#disposed || session !== this.#session) return;
      let text = '';
      try {
        text = (
          (await source.transcribePcm?.(utterance.pcm, { language })) ?? ''
        ).trim();
      } catch (error) {
        if (session === this.#session) {
          const kind = classifyDictationError(error);
          this.#fail(
            TRANSCRIBE_ERROR_KINDS.has(kind) ? kind : 'not-transcribed',
            dictationErrorCode(error),
            errorMessage(error),
            'transcribe',
          );
        }
        return;
      }
      if (this.#disposed || session !== this.#session) return;
      this.queued = Math.max(0, this.queued - 1);
      // Models write "[BLANK_AUDIO]" or "(silence)" for noise: not words.
      if (text && !/^[[(].*[\])]$/.test(text)) this.#options.onText(text);
      if (this.#handsFreeDraining && this.queued === 0) this.#idle();
    });
  }

  /**
   * Resolves once every hands-free utterance heard so far has been written
   * down (and handed to `onText`). A caller that reads the field right after
   * `stop()` (a send) awaits this to see the last sentence.
   */
  async whenSettled(): Promise<void> {
    await this.#utteranceQueue;
  }

  /** The person ended hands-free: finish the phrase, then write it all down. */
  #stopHandsFree(): void {
    const capture = this.#handsFreeCapture;
    this.#handsFreeCapture = null;
    this.speaking = false;
    this.suspended = false;
    this.level = 0;
    this.beepPending = false;
    // Hands over the utterance in progress, then releases the microphone.
    capture?.stop();
    if (this.queued > 0) {
      this.#handsFreeDraining = true;
      this.state = 'transcribing';
    } else {
      this.#idle();
    }
  }

  /** Release the hands-free microphone and drop what it heard. */
  #dropHandsFree(): void {
    const capture = this.#handsFreeCapture;
    this.#handsFreeCapture = null;
    capture?.cancel();
  }

  #resetHandsFree(): void {
    this.handsFree = false;
    this.suspended = false;
    this.speaking = false;
    this.level = 0;
    this.queued = 0;
    this.#handsFreeDraining = false;
    this.#utteranceQueue = Promise.resolve();
  }

  /** Forget the recorder; `cancel` throws its audio away too. */
  #dropCapture(cancel: boolean): void {
    this.#captureOff?.();
    this.#captureOff = null;
    if (cancel) this.#capture?.cancel();
    this.#capture = null;
    this.#captureReady = false;
  }

  async #ensureMicrophone(): Promise<void> {
    if (this.#microphoneReady || this.#options.requestMicrophone === false)
      return;
    const media =
      typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.getUserMedia !== 'function') return;
    const stream = await media.getUserMedia({ audio: true });
    // Only the permission was wanted; the recogniser opens its own stream.
    for (const track of stream.getTracks()) track.stop();
    this.#microphoneReady = true;
  }

  async #resolveSource(
    provider: DictationSourceProvider,
  ): Promise<DictationSpeechSource> {
    if (this.#source) return this.#source;
    this.#sourcePromise ??= Promise.resolve().then(provider);
    try {
      const source = await this.#sourcePromise;
      if (!this.#source) {
        this.#source = source;
        this.#subscribe(source);
      }
      return source;
    } catch (error) {
      this.#sourcePromise = null;
      throw error;
    }
  }

  #subscribe(source: DictationSpeechSource): void {
    this.#unsubscribe.push(
      source.onResult((result) => {
        if (this.#disposed || this.recording) return;
        if (!(this.active || this.state === 'stopping')) return;
        this.#heard = true;
        if (result.isFinal) {
          this.interim = '';
          this.#options.onInterim?.('');
          const text = result.text.trim();
          if (text) this.#options.onText(text);
        } else {
          this.interim = result.text;
          this.#options.onInterim?.(result.text);
        }
      }),
      source.onError((error) => {
        if (this.#disposed || this.recording) return;
        if (this.state === 'idle' || this.state === 'error') return;
        // Cut off after the person asked it to stop: that is the stop.
        if (
          this.state === 'stopping' &&
          classifyDictationError(error) === 'interrupted'
        )
          return;
        if (this.active) {
          this.#failOrRecord(error, 'error', this.#session);
          return;
        }
        this.#failWith(error, 'error');
      }),
      source.onEnd(() => {
        if (this.#disposed || this.recording) return;
        if (this.state === 'error' || this.state === 'idle') return;
        if (this.state === 'stopping') {
          this.#idle();
          return;
        }
        // Ended by itself, with no error. Before it ever listened, or within
        // `earlyEndMs` without hearing anything, it did not really work
        // (Brave ends like this): say so rather than going quiet, or record
        // instead when we can.
        const early = this.#options.earlyEndMs ?? 1000;
        if (
          this.state === 'starting' ||
          (early > 0 && !this.#heard && Date.now() - this.#listeningAt < early)
        ) {
          const message = 'Speech recognition ended straight away';
          if (this.#shouldRecordInstead('interrupted', 'end')) {
            this.#log('interrupted', null, message, 'end', true);
            void this.#switchToRecording(this.#session);
            return;
          }
          this.#fail('interrupted', null, message, 'end');
          return;
        }
        this.#idle();
      }),
    );
    if (source.onStart) {
      this.#unsubscribe.push(
        source.onStart(() => {
          if (this.recording) return;
          if (!this.#disposed && this.state === 'starting') {
            this.#listening();
            return;
          }
          if (!this.#disposed && this.state === 'listening') return;
          // Stopped (or disposed) before the microphone opened: close it again.
          void source.stop().catch(() => undefined);
        }),
      );
    }
  }

  #listening(): void {
    this.state = 'listening';
    this.#listeningAt = Date.now();
    void this.#playBeep().then((played) => {
      this.beepPending = !played && this.state === 'listening';
    });
  }

  async #playBeep(): Promise<boolean> {
    const beep = this.#options.beep ?? true;
    if (beep === false) return true;
    try {
      return beep === true ? await playReadyBeep() : Boolean(await beep());
    } catch {
      return false;
    }
  }

  #idle(): void {
    this.#clearStopTimer();
    this.state = 'idle';
    this.interim = '';
    this.beepPending = false;
    this.recording = false;
    this.#resetHandsFree();
  }

  #failWith(error: unknown, stage: DictationLogEvent['stage']): void {
    this.#fail(
      classifyDictationError(error),
      dictationErrorCode(error),
      errorMessage(error),
      stage,
    );
  }

  #log(
    kind: DictationErrorKind,
    code: string | null,
    message: string,
    stage: DictationLogEvent['stage'],
    fallback = false,
  ): void {
    const log = this.#options.log ?? defaultLog;
    try {
      log({
        kind,
        code,
        message,
        stage,
        ...(fallback ? { fallback: 'recording' as const } : {}),
      });
    } catch {
      // A broken logger must not hide the error from the person.
    }
  }

  #fail(
    kind: DictationErrorKind,
    code: string | null,
    message: string,
    stage: DictationLogEvent['stage'],
  ): void {
    this.#clearStopTimer();
    this.#dropCapture(true);
    if (this.handsFree) {
      // Whatever was queued dies with the session.
      this.#session++;
      this.#dropHandsFree();
    }
    this.#log(kind, code, message, stage);
    this.errorKind = kind;
    this.errorCode = code;
    this.state = 'error';
    this.interim = '';
    this.beepPending = false;
    this.recording = false;
    this.#resetHandsFree();
  }

  #clearStopTimer(): void {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown');
}
