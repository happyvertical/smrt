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
 * - `unsupported`: this browser cannot recognise speech;
 * - `denied`: the microphone is blocked;
 * - `no-speech`: nothing was heard;
 * - `failed`: anything else (network, audio capture…).
 */
export type DictationErrorKind =
  | 'unsupported'
  | 'denied'
  | 'no-speech'
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
  };
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
  if (/no speech|no-speech/.test(message)) return 'no-speech';
  return 'failed';
}

function pageLanguage(): string {
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.getAttribute('lang');
    if (lang) return lang;
  }
  return 'en-US';
}

export class Dictation {
  /** Where dictation is (see the module comment). */
  state = $state<DictationState>('idle');
  /** Why it stopped, while `state` is `error`. */
  errorKind = $state<DictationErrorKind | null>(null);
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
    this.interim = '';
    this.state = 'starting';
    const session = ++this.#session;
    const provider = this.#options.source;
    if (!provider) {
      this.#fail('unsupported');
      return;
    }
    let source: DictationSpeechSource;
    try {
      source = await this.#resolveSource(provider);
    } catch (error) {
      if (session === this.#session) this.#fail(classifyDictationError(error));
      return;
    }
    if (session !== this.#session || this.#disposed) return;
    try {
      await source.start({
        language: this.#options.language ?? pageLanguage(),
        continuous: true,
        interimResults: true,
      });
    } catch (error) {
      if (session === this.#session) this.#fail(classifyDictationError(error));
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
        this.#fail(classifyDictationError(error));
      }),
      source.onEnd(() => {
        if (this.#disposed) return;
        if (this.state === 'error') return;
        if (this.state !== 'idle') this.#idle();
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

  #fail(kind: DictationErrorKind): void {
    this.#clearStopTimer();
    this.errorKind = kind;
    this.state = 'error';
    this.interim = '';
    this.beepPending = false;
  }

  #clearStopTimer(): void {
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
  }
}
