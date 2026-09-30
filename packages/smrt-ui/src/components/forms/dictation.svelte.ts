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
 */
import { playReadyBeep } from './ready-beep.js';

export type DictationState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'stopping'
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
 * - `failed`: anything else.
 */
export type DictationErrorKind =
  | 'unsupported'
  | 'denied'
  | 'no-speech'
  | 'microphone'
  | 'interrupted'
  | 'failed';

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
}

/** A dictation problem, for logs. */
export interface DictationLogEvent {
  kind: DictationErrorKind;
  /** Raw code: the Web Speech error (`network`, …) or the error's name. */
  code: string | null;
  message: string;
  /** Where it happened: `microphone`, `source`, `start`, `error`, `end`. */
  stage: 'microphone' | 'source' | 'start' | 'error' | 'end';
}

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
      `: ${event.message}`,
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

  constructor(options: DictationOptions) {
    this.#options = options;
  }

  /** A speech source was given (the browser may still turn out unable). */
  get available(): boolean {
    return Boolean(this.#options.source);
  }

  /** Starting or listening. */
  get active(): boolean {
    return this.state === 'starting' || this.state === 'listening';
  }

  /** Replace options (for example a new `onText`). */
  setOptions(options: Partial<DictationOptions>): void {
    this.#options = { ...this.#options, ...options };
  }

  /** Start listening. A no-op while already starting or listening. */
  async start(): Promise<void> {
    if (this.#disposed || this.active || this.state === 'stopping') return;
    this.errorKind = null;
    this.errorCode = null;
    this.interim = '';
    this.#heard = false;
    this.#listeningAt = 0;
    this.state = 'starting';
    const session = ++this.#session;
    const provider = this.#options.source;
    if (!provider) {
      this.#fail('unsupported', null, 'No speech source', 'source');
      return;
    }
    let source: DictationSpeechSource;
    try {
      source = await this.#resolveSource(provider);
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'source');
      return;
    }
    if (session !== this.#session || this.#disposed) return;
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
        language: this.#options.language ?? pageLanguage(),
        continuous: true,
        interimResults: true,
      });
    } catch (error) {
      if (session === this.#session) this.#failWith(error, 'start');
      return;
    }
    if (session !== this.#session) return;
    if (!source.onStart && this.state === 'starting') this.#listening();
  }

  /** Stop listening; the phrase in progress is kept if the source finishes it. */
  async stop(): Promise<void> {
    if (!this.active) return;
    this.state = 'stopping';
    const session = this.#session;
    this.#clearStopTimer();
    this.#stopTimer = setTimeout(() => {
      if (session === this.#session && this.state === 'stopping') this.#idle();
    }, this.#options.stopTimeoutMs ?? 1500);
    try {
      await this.#source?.stop();
    } catch {
      if (session === this.#session) this.#idle();
    }
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
    if (this.active) void this.#source?.stop().catch(() => undefined);
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.state = 'idle';
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
        if (this.#disposed || !(this.active || this.state === 'stopping'))
          return;
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
        if (this.#disposed || this.state === 'idle' || this.state === 'error')
          return;
        // Cut off after the person asked it to stop: that is the stop.
        if (
          this.state === 'stopping' &&
          classifyDictationError(error) === 'interrupted'
        )
          return;
        this.#failWith(error, 'error');
      }),
      source.onEnd(() => {
        if (this.#disposed) return;
        if (this.state === 'error' || this.state === 'idle') return;
        if (this.state === 'stopping') {
          this.#idle();
          return;
        }
        // Ended by itself, with no error. Before it ever listened, or within
        // `earlyEndMs` without hearing anything, it did not really work
        // (Brave ends like this): say so rather than going quiet.
        const early = this.#options.earlyEndMs ?? 1000;
        if (
          this.state === 'starting' ||
          (early > 0 && !this.#heard && Date.now() - this.#listeningAt < early)
        ) {
          this.#fail(
            'interrupted',
            null,
            'Speech recognition ended straight away',
            'end',
          );
          return;
        }
        this.#idle();
      }),
    );
    if (source.onStart) {
      this.#unsubscribe.push(
        source.onStart(() => {
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
  }

  #failWith(error: unknown, stage: DictationLogEvent['stage']): void {
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    this.#fail(
      classifyDictationError(error),
      dictationErrorCode(error),
      message,
      stage,
    );
  }

  #fail(
    kind: DictationErrorKind,
    code: string | null,
    message: string,
    stage: DictationLogEvent['stage'],
  ): void {
    this.#clearStopTimer();
    const log = this.#options.log ?? defaultLog;
    try {
      log({ kind, code, message, stage });
    } catch {
      // A broken logger must not hide the error from the person.
    }
    this.errorKind = kind;
    this.errorCode = code;
    this.state = 'error';
    this.interim = '';
    this.beepPending = false;
  }

  #clearStopTimer(): void {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }
}
