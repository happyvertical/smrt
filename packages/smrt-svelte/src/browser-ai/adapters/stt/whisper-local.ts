/**
 * Local Whisper speech-to-text (`whisper-local`, alias `whisper-wasm`).
 *
 * For browsers whose own speech recognition is missing or unreliable
 * (Firefox, Brave). It is push-to-talk: `start()` records from the
 * microphone, `stop()` ends the recording and transcribes it with a Whisper
 * model running in the browser (WebGPU when available, single-thread WASM
 * otherwise, in a Web Worker when the host supplies one), then emits one
 * final result. The model is a one-time download kept in Cache Storage; see
 * `WhisperLocalModel` for the consent/progress API.
 */
import {
  createMediaRecorderCapture,
  type DictationAudioCapture,
  type DictationAudioCaptureFactory,
} from '@happyvertical/smrt-ui/forms';
import type { InitState, OnProgress } from '../../core/types.js';
import type {
  STTAdapter,
  STTCapabilities,
  STTOptions,
  STTResult,
  WhisperLocalSTTOptions,
} from './types.js';
import { WHISPER_LOCAL_DEFAULT_MODEL } from './whisper-local-engine.js';
import {
  createWhisperLocalModel,
  type WhisperLocalLoadOptions,
  type WhisperLocalModel,
} from './whisper-local-model.js';

const SIZE_MODELS = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
  small: 'onnx-community/whisper-small.en',
} as const;

/** Sample rate Whisper expects. */
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

export class WhisperLocalSTTAdapter implements STTAdapter {
  readonly type: 'whisper-local' | 'whisper-wasm';
  /**
   * `Dictation` waits this long for the text after the person stops.
   */
  readonly stopTimeoutMs = STOP_TIMEOUT_MS;

  private readonly options: WhisperLocalSTTOptions;
  private readonly _model: WhisperLocalModel;
  private readonly makeCapture: DictationAudioCaptureFactory;
  private capture: DictationAudioCapture | null = null;
  private captureOff: (() => void) | null = null;
  private _isListening = false;
  private language = 'en';
  private session = 0;
  private stopping: Promise<void> | null = null;

  private resultListeners = new Set<(result: STTResult) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private startListeners = new Set<() => void>();
  private endListeners = new Set<() => void>();

  constructor(
    options: Partial<WhisperLocalSTTOptions> & {
      /** Test seam: the microphone recorder. */
      capture?: DictationAudioCaptureFactory;
    } = {},
  ) {
    this.options = {
      type: 'whisper-local',
      defaultLanguage: 'en',
      ...options,
    } as WhisperLocalSTTOptions;
    this.type = this.options.type;
    this.language = this.options.defaultLanguage ?? 'en';
    this.makeCapture = options.capture ?? createMediaRecorderCapture;
    const modelId =
      this.options.modelId ??
      (this.options.modelSize
        ? SIZE_MODELS[this.options.modelSize]
        : WHISPER_LOCAL_DEFAULT_MODEL);
    this._model =
      this.options.modelHandle ??
      createWhisperLocalModel({
        modelId,
        device: this.options.device,
        dtype: this.options.dtype,
        createWorker: this.options.createWorker,
        loadModule: this.options.loadModule,
        allowLocalModels: this.options.allowLocalModels,
      });
  }

  /** The downloadable model, for consent UIs. */
  get model(): WhisperLocalModel {
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

  load(options?: WhisperLocalLoadOptions): Promise<void> {
    return this._model.load(options);
  }

  async ensureInitialized(onProgress?: OnProgress): Promise<void> {
    await this._model.load({
      onProgress: onProgress ?? this.options.onProgress,
    });
  }

  private englishOnly(): boolean {
    return this._model.modelId.endsWith('.en');
  }

  getCapabilities(): STTCapabilities {
    return {
      continuous: false,
      interimResults: false,
      languages: this.englishOnly()
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

  async start(options: STTOptions = {}): Promise<void> {
    if (this._isListening) return;
    await this.ensureInitialized();
    if (this._isListening) return;
    this.language = options.language ?? this.options.defaultLanguage ?? 'en';
    const session = ++this.session;
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

/** @deprecated Use {@link WhisperLocalSTTAdapter}. */
export { WhisperLocalSTTAdapter as WhisperWasmSTTAdapter };
