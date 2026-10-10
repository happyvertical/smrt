/**
 * On-device speech-to-text (`whisper-local`, alias `whisper-wasm`, and
 * `moonshine`).
 *
 * For browsers whose own speech recognition is missing or unreliable
 * (Firefox, Brave). It is push-to-talk: `start()` records from the
 * microphone, `stop()` ends the recording and transcribes it with a Whisper
 * or Moonshine model running in the browser (WebGPU when available,
 * single-thread WASM otherwise, in a Web Worker when the host supplies one),
 * then emits one final result. `transcribePcm()` transcribes one finished
 * utterance directly, which smrt-ui's hands-free dictation uses. The engine
 * is `@happyvertical/speech/local`; the model is a one-time download kept in
 * Cache Storage; see `LocalSpeechModel` for the consent/progress API.
 */
import {
  createMediaRecorderCapture,
  type DictationAudioCapture,
  type DictationAudioCaptureFactory,
} from '@happyvertical/smrt-ui/forms';
import { ModelNotDownloadedError } from '../../core/errors.js';
import type { InitState, OnProgress } from '../../core/types.js';
import {
  createLocalSpeechModel,
  type LocalSpeechLoadOptions,
  type LocalSpeechModel,
} from './local-speech-model.js';
import type {
  LocalSpeechSTTOptions,
  STTAdapter,
  STTCapabilities,
  STTOptions,
  STTResult,
} from './types.js';

const SIZE_MODELS = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
  small: 'onnx-community/whisper-small.en',
} as const;

/** Sample rate the speech models expect. */
const SAMPLE_RATE = 16_000;

/**
 * How long a caller should wait after `stop()` for the text: the dictation
 * state machine would otherwise give up after 1.5 s, long before a model
 * running in the browser has finished.
 */
const STOP_TIMEOUT_MS = 90_000;

/** Decode a recording into 16 kHz mono PCM with the Web Audio API. */
async function decodeAudio(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buffer = await context.decodeAudioData(bytes);
    // A copy: the channel data belongs to the AudioBuffer, and the worker
    // takes ownership of what it is sent.
    return buffer.getChannelData(0).slice();
  } finally {
    void context.close().catch(() => undefined);
  }
}

export class LocalSpeechSTTAdapter implements STTAdapter {
  readonly type: 'whisper-local' | 'whisper-wasm' | 'moonshine';
  /**
   * `Dictation` waits this long for the text after the person stops.
   */
  readonly stopTimeoutMs = STOP_TIMEOUT_MS;

  private readonly options: LocalSpeechSTTOptions;
  private readonly _model: LocalSpeechModel;
  private readonly makeCapture: DictationAudioCaptureFactory;
  private capture: DictationAudioCapture | null = null;
  private captureOff: (() => void) | null = null;
  private _isListening = false;
  private language = 'en';
  private session = 0;
  private starting = false;
  private stopping: Promise<void> | null = null;

  private resultListeners = new Set<(result: STTResult) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private startListeners = new Set<() => void>();
  private endListeners = new Set<() => void>();

  constructor(
    options: Partial<LocalSpeechSTTOptions> & {
      /** Test seam: the microphone recorder. */
      capture?: DictationAudioCaptureFactory;
    } = {},
  ) {
    this.options = {
      type: 'whisper-local',
      defaultLanguage: 'en',
      ...options,
    } as LocalSpeechSTTOptions;
    this.type = this.options.type;
    this.language = this.options.defaultLanguage ?? 'en';
    this.makeCapture = options.capture ?? createMediaRecorderCapture;
    const model =
      this.options.model ??
      this.options.modelId ??
      (this.options.modelSize
        ? SIZE_MODELS[this.options.modelSize]
        : this.type === 'moonshine'
          ? 'moonshine-tiny'
          : undefined);
    this._model =
      this.options.modelHandle ??
      createLocalSpeechModel({
        model,
        device: this.options.device,
        dtype: this.options.dtype,
        createWorker: this.options.createWorker,
        loadSpeech: this.options.loadSpeech,
        loadModule: this.options.loadModule,
        allowLocalModels: this.options.allowLocalModels,
      });
  }

  /** The downloadable model, for consent UIs. */
  get model(): LocalSpeechModel {
    return this._model;
  }

  get initState(): InitState {
    switch (this._model.state) {
      case 'ready':
        return 'ready';
      case 'loading':
        return 'initializing';
      case 'error':
        return 'error';
      default:
        return 'uninitialized';
    }
  }

  estimateSize(): number {
    return this._model.estimateSize();
  }

  isCached(): Promise<boolean> {
    return this._model.isCached();
  }

  load(options?: LocalSpeechLoadOptions): Promise<void> {
    return this._model.load(options);
  }

  async ensureInitialized(onProgress?: OnProgress): Promise<void> {
    await this._model.load({
      onProgress: onProgress ?? this.options.onProgress,
    });
  }

  /**
   * Make the model ready for dictation without ever downloading it: a model
   * already loaded is used, one stored on this device is loaded from there,
   * and anything else rejects with `ModelNotDownloadedError`. The host asks
   * for consent and calls `load()` itself.
   */
  async prepare(): Promise<void> {
    if (this._model.state === 'ready') return;
    if (!(await this._model.isCached())) {
      throw new ModelNotDownloadedError(this._model.modelId, this.type);
    }
    await this.ensureInitialized();
  }

  getCapabilities(): STTCapabilities {
    return {
      continuous: false,
      interimResults: false,
      languages: this._model.englishOnly
        ? ['en']
        : [
            'en',
            'es',
            'fr',
            'de',
            'it',
            'pt',
            'nl',
            'pl',
            'ru',
            'zh',
            'ja',
            'ko',
          ],
      accuracy: 'medium',
      requiresDownload: true,
      downloadSize: this._model.estimateSize(),
    };
  }

  /**
   * Transcribe one finished utterance (16 kHz mono PCM). Loads the model
   * first if it is not ready. This is what hands-free dictation calls for
   * each utterance the voice activity detector cuts out.
   */
  async transcribePcm(
    pcm: Float32Array,
    options: { language?: string } = {},
  ): Promise<string> {
    await this.prepare();
    return this._model.transcribe(
      pcm,
      options.language ?? this.options.defaultLanguage ?? 'en',
    );
  }

  async start(options: STTOptions = {}): Promise<void> {
    if (this._isListening || this.starting) return;
    // The session token is taken before the (possibly long) model load, so a
    // stop() or abort() meanwhile cancels this start instead of letting the
    // microphone open once the load finishes.
    const session = ++this.session;
    this.starting = true;
    try {
      await this.prepare();
    } finally {
      this.starting = false;
    }
    if (session !== this.session || this._isListening) return;
    this.language = options.language ?? this.options.defaultLanguage ?? 'en';
    const capture = this.makeCapture({
      maxDurationMs: this.options.maxDurationMs,
    });
    try {
      await capture.start();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitError(err);
      throw err;
    }
    if (session !== this.session) {
      capture.cancel();
      return;
    }
    this.capture = capture;
    this.captureOff = capture.onLimit((reason) => {
      if (reason === 'time') void this.stop();
      else {
        this.captureOff?.();
        void this.finish(session, null, new Error('The recording is too long'));
      }
    });
    this._isListening = true;
    for (const cb of this.startListeners) cb();
  }

  /** End the recording, transcribe it, emit the final result, then end. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const capture = this.capture;
    if (this.starting) this.session++;
    if (!capture || !this._isListening) return Promise.resolve();
    const session = this.session;
    this.stopping = (async () => {
      let text: string | null = null;
      let failure: Error | null = null;
      try {
        const recording = await capture.stop();
        if (session !== this.session) return;
        const audio = await decodeAudio(recording.audio);
        text = await this._model.transcribe(audio, this.language);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      await this.finish(session, text, failure);
    })();
    return this.stopping;
  }

  private async finish(
    session: number,
    text: string | null,
    failure: Error | null,
  ): Promise<void> {
    if (session !== this.session) return;
    this.captureOff?.();
    this.captureOff = null;
    this.capture = null;
    this._isListening = false;
    this.stopping = null;
    if (failure) this.emitError(failure);
    else if (text) {
      const result: STTResult = {
        text,
        confidence: 1,
        isFinal: true,
        timestamp: Date.now(),
      };
      for (const cb of this.resultListeners) cb(result);
    }
    for (const cb of this.endListeners) cb();
  }

  private emitError(error: Error): void {
    for (const cb of this.errorListeners) cb(error);
  }

  abort(): void {
    if (this.starting) this.session++;
    if (!this._isListening) return;
    this.session++;
    this.captureOff?.();
    this.captureOff = null;
    this.capture?.cancel();
    this.capture = null;
    this._isListening = false;
    this.stopping = null;
    for (const cb of this.endListeners) cb();
  }

  isListening(): boolean {
    return this._isListening;
  }

  onResult(callback: (result: STTResult) => void): () => void {
    this.resultListeners.add(callback);
    return () => this.resultListeners.delete(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  onStart(callback: () => void): () => void {
    this.startListeners.add(callback);
    return () => this.startListeners.delete(callback);
  }

  onEnd(callback: () => void): () => void {
    this.endListeners.add(callback);
    return () => this.endListeners.delete(callback);
  }

  async dispose(): Promise<void> {
    this.abort();
    // A shared handle belongs to whoever made it.
    if (!this.options.modelHandle) this._model.dispose();
    this.resultListeners.clear();
    this.errorListeners.clear();
    this.startListeners.clear();
    this.endListeners.clear();
  }
}

/** @deprecated Use {@link LocalSpeechSTTAdapter}. */
/** @deprecated Use {@link LocalSpeechSTTAdapter}. */
export {
  LocalSpeechSTTAdapter as WhisperLocalSTTAdapter,
  LocalSpeechSTTAdapter as WhisperWasmSTTAdapter,
};
