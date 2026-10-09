/**
 * The downloadable on-device speech model behind `whisper-local` and
 * `moonshine`, as a handle a consent UI can drive before anything is spoken:
 *
 * ```ts
 * const model = createLocalSpeechModel({ model: 'moonshine-tiny', createWorker });
 * const bytes = model.estimateSize();            // "Download 32 MB?"
 * if (await model.isCached()) { ... }            // already on this device
 * await model.load({ onProgress, signal });      // downloads, then ready
 * createSttDictationSource({ type: 'moonshine', modelHandle: model });
 * ```
 *
 * The engine is `@happyvertical/speech/local` (`LocalTranscriber`, or its
 * worker host `serveLocalTranscriber` when `createWorker` is given). The
 * files live in Cache Storage, so a later `load()` (even in a new tab) is
 * quick. Passing the handle to an adapter shares the one loaded pipeline
 * rather than loading a second copy.
 *
 * `@happyvertical/speech` and `@huggingface/transformers` are OPTIONAL
 * peers. This module never imports them statically: a host supplies
 * `loadSpeech` (and, without a worker, `loadModule`), or builds the worker
 * from `@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker`.
 */
import { importOptional } from '@happyvertical/smrt-ui/utils/import-optional.js';
import { InitializationError } from '../../core/errors.js';
import type { DownloadProgressInfo } from '../../core/types.js';
import { configureTransformersEnv } from './transformers-env.js';

/** Where the speech model comes from by default (kept for `whisper-local`). */
export const WHISPER_LOCAL_DEFAULT_MODEL = 'onnx-community/whisper-tiny.en';

/**
 * Bytes a first download of the default model takes: the 8-bit encoder
 * (~10 MB), merged decoder (~31 MB) and tokenizer/config files (~4 MB).
 */
export const WHISPER_LOCAL_DEFAULT_SIZE_BYTES = 45_100_000;

/** A model this package knows by a short name. */
export interface LocalSpeechModelPreset {
  /** Hugging Face model id. */
  id: string;
  /** Approximate first-download size in bytes (8-bit weights + tokenizer). */
  bytes: number;
  /** Transcribes English only (its decoder takes no `language`). */
  englishOnly: boolean;
  label: string;
}

/**
 * Short names for `model`. Moonshine is the fastest for live dictation;
 * Whisper `.en` is the longer-established English model.
 */
export const LOCAL_SPEECH_MODELS: Readonly<
  Record<string, LocalSpeechModelPreset>
> = {
  'moonshine-tiny': {
    id: 'onnx-community/moonshine-tiny-ONNX',
    bytes: 32_200_000,
    englishOnly: true,
    label: 'Moonshine tiny',
  },
  'moonshine-base': {
    id: 'onnx-community/moonshine-base-ONNX',
    bytes: 67_000_000,
    englishOnly: true,
    label: 'Moonshine base',
  },
  'whisper-tiny.en': {
    id: WHISPER_LOCAL_DEFAULT_MODEL,
    bytes: WHISPER_LOCAL_DEFAULT_SIZE_BYTES,
    englishOnly: true,
    label: 'Whisper tiny (English)',
  },
  'whisper-base.en': {
    id: 'onnx-community/whisper-base.en',
    bytes: 85_000_000,
    englishOnly: true,
    label: 'Whisper base (English)',
  },
  'whisper-small.en': {
    id: 'onnx-community/whisper-small.en',
    bytes: 260_000_000,
    englishOnly: true,
    label: 'Whisper small (English)',
  },
};

/** Resolve a short name (`moonshine-tiny`) or a Hugging Face id. */
export function resolveLocalSpeechModelId(model?: string): string {
  if (!model) return WHISPER_LOCAL_DEFAULT_MODEL;
  return LOCAL_SPEECH_MODELS[model]?.id ?? model;
}

/** Whether a model id only transcribes English. */
export function isEnglishOnlyLocalSpeechModel(modelId: string): boolean {
  return (
    Object.values(LOCAL_SPEECH_MODELS).some(
      (preset) => preset.id === modelId && preset.englishOnly,
    ) || /\.en$|moonshine/i.test(modelId)
  );
}

export type LocalSpeechDevice = 'webgpu' | 'wasm';

/** @deprecated Use {@link LocalSpeechDevice}. */
export type WhisperLocalDevice = LocalSpeechDevice;

export interface LocalSpeechModelOptions {
  /**
   * A short name (`'moonshine-tiny'`, `'moonshine-base'`, `'whisper-tiny.en'`,
   * ...) or a Hugging Face model id. Default `onnx-community/whisper-tiny.en`.
   */
  model?: string;
  /** Alias of `model`, kept from `createWhisperLocalModel`. */
  modelId?: string;
  /**
   * `'auto'` (default): WebGPU when available, else single-thread WASM.
   * With a worker, the worker entry decides (see `local-speech.worker.ts`).
   */
  device?: 'auto' | LocalSpeechDevice;
  /** Weight quantisation. Default `'q8'`. Page-thread only, as `device`. */
  dtype?: string;
  /** Make the Web Worker (see `local-speech.worker.ts`). */
  createWorker?: () => Worker;
  /**
   * Load `@happyvertical/speech/local`, e.g.
   * `() => import('@happyvertical/speech/local')`. A bundled browser app
   * needs it; plain `import()` of the bare name only works where Node (or
   * an import map) resolves it.
   */
  loadSpeech?: () => Promise<unknown>;
  /**
   * Load `@huggingface/transformers` when running on the page's thread,
   * e.g. `() => import('@huggingface/transformers')`.
   */
  loadModule?: () => Promise<unknown>;
  allowLocalModels?: boolean;
}

/** @deprecated Use {@link LocalSpeechModelOptions}. */
export type WhisperLocalModelOptions = LocalSpeechModelOptions;

export interface LocalSpeechLoadOptions {
  onProgress?: (progress: DownloadProgressInfo) => void;
  /**
   * Cancel the download. With a worker the download stops (the worker is
   * ended); on the page's own thread the promise rejects and the files
   * already fetched stay cached.
   */
  signal?: AbortSignal;
}

/** @deprecated Use {@link LocalSpeechLoadOptions}. */
export type WhisperLocalLoadOptions = LocalSpeechLoadOptions;

export type LocalSpeechModelState = 'idle' | 'loading' | 'ready' | 'error';

/** @deprecated Use {@link LocalSpeechModelState}. */
export type WhisperLocalModelState = LocalSpeechModelState;

// -- The slice of @happyvertical/speech/local this module uses ---------------
// Structural, so the package's types stay out of this module's surface and a
// host can supply any compatible build.

interface SpeechProgressEvent {
  status?: string;
  loaded?: number;
  total?: number;
  file?: string;
}

interface SpeechTranscriber {
  preload(model?: string, signal?: AbortSignal): Promise<void>;
  isCached(model?: string): Promise<boolean>;
  transcribe(request: {
    audio: { data: Uint8Array; mimeType: string };
    model?: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

interface SpeechLocalModule {
  LocalTranscriber: new (
    options: Record<string, unknown>,
  ) => SpeechTranscriber & {
    dispose(): Promise<void>;
  };
  LocalTranscriberWorkerClient: new (
    endpoint: unknown,
    options: { onProgress?: (progress: SpeechProgressEvent) => void },
  ) => SpeechTranscriber & { close(): void };
}

type ProgressSink = (progress: SpeechProgressEvent) => void;

/** One request channel to the engine, in a worker or in-page. */
interface Backend {
  isCached(model: string): Promise<boolean>;
  preload(model: string, signal?: AbortSignal): Promise<void>;
  transcribe(
    pcm: Float32Array,
    model: string,
    language?: string,
  ): Promise<string>;
  dispose(): void;
}

const PCM_MIME = 'audio/pcm;rate=16000;channels=1;encoding=f32le';

function abortError(): Error {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

/** `en-CA` -> `en`; Whisper wants the two-letter code. */
function languageCode(language?: string): string | undefined {
  return language?.split(/[-_]/)[0]?.toLowerCase() || undefined;
}

function pcmRequest(pcm: Float32Array) {
  // The worker takes ownership of what it is sent: hand over a copy.
  const bytes = new Uint8Array(pcm.slice().buffer);
  return { data: bytes, mimeType: PCM_MIME };
}

async function loadSpeechModule(
  loadSpeech?: () => Promise<unknown>,
): Promise<SpeechLocalModule> {
  try {
    return (await (loadSpeech
      ? loadSpeech()
      : importOptional('@happyvertical/speech/local'))) as SpeechLocalModule;
  } catch (error) {
    throw new InitializationError(
      'local-speech',
      '@happyvertical/speech could not be loaded. Install it (and ' +
        '@huggingface/transformers) and pass ' +
        '`loadSpeech: () => import("@happyvertical/speech/local")`.',
    );
  }
}

class WorkerBackend implements Backend {
  private worker: Worker | null = null;
  private client: Promise<SpeechTranscriber & { close(): void }> | null = null;
  constructor(
    private readonly createWorker: () => Worker,
    private readonly loadSpeech: (() => Promise<unknown>) | undefined,
    private readonly progress: ProgressSink,
  ) {}

  private ensure() {
    this.client ??= loadSpeechModule(this.loadSpeech).then((speech) => {
      const worker = this.createWorker();
      this.worker = worker;
      return new speech.LocalTranscriberWorkerClient(worker, {
        onProgress: this.progress,
      });
    });
    return this.client;
  }

  async isCached(model: string) {
    const client = await this.ensure();
    return client.isCached(model);
  }

  async preload(model: string, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    const client = await this.ensure();
    if (!signal) return client.preload(model);
    // The only way to stop a download in a worker is to end the worker.
    const onAbort = () => this.dispose();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await Promise.race([
        client.preload(model),
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(abortError()), {
            once: true,
          }),
        ),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async transcribe(pcm: Float32Array, model: string, language?: string) {
    const client = await this.ensure();
    const result = await client.transcribe({
      audio: pcmRequest(pcm),
      model,
      language: languageCode(language),
    });
    return result.text.trim();
  }

  dispose() {
    this.client?.then((client) => client.close()).catch(() => undefined);
    this.worker?.terminate();
    this.worker = null;
    this.client = null;
  }
}

class InPageBackend implements Backend {
  private transcriber: Promise<
    SpeechTranscriber & { dispose(): Promise<void> }
  > | null = null;
  constructor(
    private readonly options: LocalSpeechModelOptions,
    private readonly model: string,
    private readonly progress: ProgressSink,
  ) {}

  private ensure() {
    this.transcriber ??= loadSpeechModule(this.options.loadSpeech).then(
      (speech) =>
        new speech.LocalTranscriber({
          model: this.model,
          device: this.options.device ?? 'auto',
          dtype: this.options.dtype ?? 'q8',
          ...(this.options.loadModule
            ? { transformers: this.options.loadModule }
            : {}),
          onProgress: this.progress,
          configureEnv: configureTransformersEnv(
            this.options.allowLocalModels ?? false,
          ),
        }),
    );
    return this.transcriber;
  }

  async isCached(model: string) {
    const transcriber = await this.ensure();
    return transcriber.isCached(model);
  }

  async preload(model: string, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    const transcriber = await this.ensure();
    // `preload` stops waiting on abort; the files fetched stay cached.
    await transcriber.preload(model, signal).catch((error: unknown) => {
      if (signal?.aborted) throw abortError();
      throw error;
    });
  }

  async transcribe(pcm: Float32Array, model: string, language?: string) {
    const transcriber = await this.ensure();
    const result = await transcriber.transcribe({
      audio: pcmRequest(pcm),
      model,
      language: languageCode(language),
    });
    return result.text.trim();
  }

  dispose() {
    this.transcriber?.then((t) => t.dispose()).catch(() => undefined);
    this.transcriber = null;
  }
}

export class LocalSpeechModel {
  readonly modelId: string;
  private backend: Backend | null = null;
  private loadPromise: Promise<void> | null = null;
  private listeners = new Set<(p: DownloadProgressInfo) => void>();
  private _state: LocalSpeechModelState = 'idle';

  constructor(private readonly options: LocalSpeechModelOptions = {}) {
    this.modelId = resolveLocalSpeechModelId(options.model ?? options.modelId);
  }

  get state(): LocalSpeechModelState {
    return this._state;
  }

  get ready(): boolean {
    return this._state === 'ready';
  }

  /** Transcribes English only (no `language` is sent to the engine). */
  get englishOnly(): boolean {
    return isEnglishOnlyLocalSpeechModel(this.modelId);
  }

  /** Bytes a first download takes (an estimate; cached models take none). */
  estimateSize(): number {
    return (
      Object.values(LOCAL_SPEECH_MODELS).find((p) => p.id === this.modelId)
        ?.bytes ?? WHISPER_LOCAL_DEFAULT_SIZE_BYTES
    );
  }

  private emit(progress: DownloadProgressInfo): void {
    for (const listener of this.listeners) listener(progress);
  }

  private onEngineProgress = (event: {
    status?: string;
    loaded?: number;
    total?: number;
    file?: string;
  }): void => {
    if (
      event.status !== 'progress_total' ||
      typeof event.loaded !== 'number' ||
      typeof event.total !== 'number'
    ) {
      return;
    }
    const total = this.estimateSize();
    const bytesTotal = event.total || total;
    // All bytes are in: what remains is compiling the model ("Getting ready").
    const finished = event.total > 0 && event.loaded >= event.total;
    this.emit({
      state: finished ? 'extracting' : 'downloading',
      bytesLoaded: event.loaded,
      bytesTotal,
      percent: event.total ? Math.round((event.loaded / event.total) * 100) : 0,
      currentFile: event.file,
    });
  };

  private getBackend(): Backend {
    if (this.backend) return this.backend;
    const { createWorker, loadSpeech } = this.options;
    this.backend = createWorker
      ? new WorkerBackend(createWorker, loadSpeech, this.onEngineProgress)
      : new InPageBackend(this.options, this.modelId, this.onEngineProgress);
    return this.backend;
  }

  /** Whether the model files are already stored on this device. */
  async isCached(): Promise<boolean> {
    if (this._state === 'ready') return true;
    try {
      return await this.getBackend().isCached(this.modelId);
    } catch {
      return false;
    }
  }

  /**
   * Download (if needed) and prepare the model. Safe to call again: a ready
   * model returns at once and a load in flight is shared.
   */
  load(options: LocalSpeechLoadOptions = {}): Promise<void> {
    const { onProgress, signal } = options;
    if (this._state === 'ready') return Promise.resolve();
    if (onProgress) this.listeners.add(onProgress);
    if (!this.loadPromise) {
      this._state = 'loading';
      const total = this.estimateSize();
      this.emit({
        state: 'downloading',
        bytesLoaded: 0,
        bytesTotal: total,
        percent: 0,
      });
      this.loadPromise = this.getBackend()
        .preload(this.modelId, signal)
        .then(() => {
          this._state = 'ready';
          this.emit({
            state: 'complete',
            bytesLoaded: total,
            bytesTotal: total,
            percent: 100,
          });
        })
        .catch((error: unknown) => {
          this._state = 'idle';
          // A cancelled worker is gone; start fresh next time.
          this.backend?.dispose();
          this.backend = null;
          const err = error instanceof Error ? error : new Error(String(error));
          if (err.name !== 'AbortError') {
            this._state = 'error';
            this.emit({
              state: 'error',
              bytesLoaded: 0,
              bytesTotal: total,
              percent: 0,
              error: err.message,
            });
          }
          throw err;
        })
        .finally(() => {
          this.loadPromise = null;
          this.listeners.clear();
        });
    }
    const shared = this.loadPromise;
    if (!signal) return shared;
    // Each caller's own signal rejects its own promise; the load stops only
    // when the backend can (worker) and the call that owns it aborts.
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
      shared.then(resolve, reject);
    });
  }

  /** Transcribe 16 kHz mono PCM. The model must be loaded. */
  transcribe(audio: Float32Array, language?: string): Promise<string> {
    if (this._state !== 'ready') {
      return Promise.reject(new Error('The speech model is not loaded'));
    }
    return this.getBackend().transcribe(audio, this.modelId, language);
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.loadPromise = null;
    this.listeners.clear();
    this._state = 'idle';
  }
}

/** @deprecated Use {@link LocalSpeechModel}. */
export { LocalSpeechModel as WhisperLocalModel };

export function createLocalSpeechModel(
  options: LocalSpeechModelOptions = {},
): LocalSpeechModel {
  return new LocalSpeechModel(options);
}

/** @deprecated Use {@link createLocalSpeechModel}. */
export const createWhisperLocalModel = createLocalSpeechModel;
