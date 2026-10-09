/**
 * The downloadable speech model behind `whisper-local`, as a handle a consent
 * UI can drive before anything is spoken:
 *
 * ```ts
 * const model = createWhisperLocalModel({ createWorker });
 * const bytes = model.estimateSize();            // "Download 45 MB?"
 * if (await model.isCached()) { ... }            // already on this device
 * await model.load({ onProgress, signal });      // downloads, then ready
 * createSttDictationSource({ type: 'whisper-local', modelHandle: model });
 * ```
 *
 * The library keeps the files in Cache Storage, so a later `load()` (even in
 * a new tab) is quick. Passing the handle to the adapter shares the one
 * loaded pipeline rather than loading a second copy.
 */
import { importOptional } from '@happyvertical/smrt-ui/utils/import-optional.js';
import { InitializationError } from '../../core/errors.js';
import type { DownloadProgressInfo } from '../../core/types.js';
import {
  WHISPER_LOCAL_DEFAULT_MODEL,
  WHISPER_LOCAL_DEFAULT_SIZE_BYTES,
  WHISPER_LOCAL_MODEL_SIZE_BYTES,
  type WhisperLocalDevice,
  WhisperLocalEngine,
  type WhisperLocalEngineConfig,
  type WhisperTransformersModule,
  type WhisperWorkerRequest,
  type WhisperWorkerResponse,
} from './whisper-local-engine.js';

export interface WhisperLocalModelOptions {
  /** Hugging Face model id. Default `onnx-community/whisper-tiny.en`. */
  modelId?: string;
  /** `'auto'` (default): WebGPU when available, else single-thread WASM. */
  device?: 'auto' | WhisperLocalDevice;
  /** Weight quantisation. Default `'q8'`. */
  dtype?: string;
  /** Make the Web Worker (see `whisper-local.worker.ts`). */
  createWorker?: () => Worker;
  /** Load `@huggingface/transformers` when running on the page's thread. */
  loadModule?: () => Promise<unknown>;
  allowLocalModels?: boolean;
}

export interface WhisperLocalLoadOptions {
  onProgress?: (progress: DownloadProgressInfo) => void;
  /**
   * Cancel the download. With a worker the download stops (the worker is
   * ended); on the page's own thread the promise rejects and the files
   * already fetched stay cached.
   */
  signal?: AbortSignal;
}

export type WhisperLocalModelState = 'idle' | 'loading' | 'ready' | 'error';

function abortError(): Error {
  const error = new Error('Download cancelled');
  error.name = 'AbortError';
  return error;
}

/** One request/response channel to the engine, in a worker or in-page. */
interface Backend {
  isCached(config: WhisperLocalEngineConfig): Promise<boolean>;
  load(
    config: WhisperLocalEngineConfig,
    onProgress: (loaded: number, total: number, file?: string) => void,
    signal?: AbortSignal,
  ): Promise<WhisperLocalDevice>;
  transcribe(audio: Float32Array, language?: string): Promise<string>;
  dispose(): void;
}

class InPageBackend implements Backend {
  private engine: WhisperLocalEngine;
  constructor(loadModule: () => Promise<unknown>) {
    this.engine = new WhisperLocalEngine(
      () => loadModule() as Promise<WhisperTransformersModule>,
    );
  }
  isCached(config: WhisperLocalEngineConfig) {
    return this.engine.isCached(config);
  }
  load(
    config: WhisperLocalEngineConfig,
    onProgress: (loaded: number, total: number, file?: string) => void,
    signal?: AbortSignal,
  ) {
    const loading = this.engine.load(config, onProgress);
    if (!signal) return loading;
    return new Promise<WhisperLocalDevice>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener('abort', () => reject(abortError()), {
        once: true,
      });
      loading.then(resolve, reject);
    });
  }
  transcribe(audio: Float32Array, language?: string) {
    return this.engine.transcribe(audio, language);
  }
  dispose() {
    this.engine.dispose();
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?: (loaded: number, total: number, file?: string) => void;
}

class WorkerBackend implements Backend {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  constructor(private readonly createWorker: () => Worker) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.addEventListener('message', (event: MessageEvent) => {
      const message = event.data as WhisperWorkerResponse;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') {
        entry.onProgress?.(message.loaded, message.total, message.file);
        return;
      }
      this.pending.delete(message.id);
      if (message.type === 'result') entry.resolve(message.value);
      else entry.reject(new Error(message.message));
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      this.failAll(new Error(event.message || 'The speech worker failed'));
    });
    this.worker = worker;
    return worker;
  }

  private failAll(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const entry of entries) entry.reject(error);
  }

  private request<T>(
    message: WhisperWorkerRequest extends infer R
      ? R extends { id: number }
        ? Omit<R, 'id'>
        : never
      : never,
    onProgress?: Pending['onProgress'],
    signal?: AbortSignal,
    transfer: Transferable[] = [],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const worker = this.ensure();
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
      });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.has(id)) return;
          // The only way to stop a download in a worker is to end the worker.
          this.failAll(abortError());
        },
        { once: true },
      );
      worker.postMessage({ ...message, id }, transfer);
    });
  }

  isCached(config: WhisperLocalEngineConfig) {
    return this.request<boolean>({ type: 'isCached', config });
  }
  load(
    config: WhisperLocalEngineConfig,
    onProgress: (loaded: number, total: number, file?: string) => void,
    signal?: AbortSignal,
  ) {
    return this.request<WhisperLocalDevice>(
      { type: 'load', config },
      onProgress,
      signal,
    );
  }
  transcribe(audio: Float32Array, language?: string) {
    return this.request<string>(
      { type: 'transcribe', audio, language },
      undefined,
      undefined,
      [audio.buffer],
    );
  }
  dispose() {
    this.failAll(new Error('The speech model was disposed'));
  }
}

export class WhisperLocalModel {
  readonly modelId: string;
  private readonly config: WhisperLocalEngineConfig;
  private backend: Backend | null = null;
  private loadPromise: Promise<void> | null = null;
  private listeners = new Set<(p: DownloadProgressInfo) => void>();
  private _state: WhisperLocalModelState = 'idle';
  private _device: WhisperLocalDevice | null = null;

  constructor(private readonly options: WhisperLocalModelOptions = {}) {
    this.modelId = options.modelId ?? WHISPER_LOCAL_DEFAULT_MODEL;
    this.config = {
      modelId: this.modelId,
      device: options.device ?? 'auto',
      dtype: options.dtype ?? 'q8',
      allowLocalModels: options.allowLocalModels ?? false,
    };
  }

  get state(): WhisperLocalModelState {
    return this._state;
  }

  /** `'webgpu'` or `'wasm'`, once loaded. */
  get device(): WhisperLocalDevice | null {
    return this._device;
  }

  get ready(): boolean {
    return this._state === 'ready';
  }

  /** Bytes a first download takes (an estimate; cached models take none). */
  estimateSize(): number {
    return (
      WHISPER_LOCAL_MODEL_SIZE_BYTES[this.modelId] ??
      WHISPER_LOCAL_DEFAULT_SIZE_BYTES
    );
  }

  private getBackend(): Backend {
    if (this.backend) return this.backend;
    const { createWorker, loadModule } = this.options;
    if (createWorker) {
      this.backend = new WorkerBackend(createWorker);
    } else {
      this.backend = new InPageBackend(
        loadModule ??
          (async () => {
            try {
              return await importOptional<WhisperTransformersModule>(
                '@huggingface/transformers',
              );
            } catch {
              throw new InitializationError(
                'whisper-local',
                '@huggingface/transformers could not be loaded. Install it ' +
                  'and pass `createWorker` (see whisper-local.worker.ts) or ' +
                  '`loadModule: () => import("@huggingface/transformers")`.',
              );
            }
          }),
      );
    }
    return this.backend;
  }

  /** Whether the model files are already stored on this device. */
  async isCached(): Promise<boolean> {
    if (this._state === 'ready') return true;
    return this.getBackend().isCached(this.config);
  }

  /**
   * Download (if needed) and prepare the model. Safe to call again: a ready
   * model returns at once and a load in flight is shared.
   */
  load(options: WhisperLocalLoadOptions = {}): Promise<void> {
    const { onProgress, signal } = options;
    if (this._state === 'ready') return Promise.resolve();
    if (onProgress) this.listeners.add(onProgress);
    if (!this.loadPromise) {
      this._state = 'loading';
      const total = this.estimateSize();
      const emit = (p: DownloadProgressInfo) => {
        for (const listener of this.listeners) listener(p);
      };
      emit({
        state: 'downloading',
        bytesLoaded: 0,
        bytesTotal: total,
        percent: 0,
      });
      this.loadPromise = this.getBackend()
        .load(
          this.config,
          (loaded, bytesTotal, file) =>
            emit({
              state: 'downloading',
              bytesLoaded: loaded,
              bytesTotal: bytesTotal || total,
              percent: bytesTotal ? Math.round((loaded / bytesTotal) * 100) : 0,
              currentFile: file,
            }),
          signal,
        )
        .then((device) => {
          this._device = device;
          this._state = 'ready';
          emit({
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
            emit({
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
    return this.getBackend().transcribe(audio, language);
  }

  dispose(): void {
    this.backend?.dispose();
    this.backend = null;
    this.loadPromise = null;
    this.listeners.clear();
    this._state = 'idle';
    this._device = null;
  }
}

export function createWhisperLocalModel(
  options: WhisperLocalModelOptions = {},
): WhisperLocalModel {
  return new WhisperLocalModel(options);
}
