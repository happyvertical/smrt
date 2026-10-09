/**
 * The Whisper engine behind `whisper-local`: loads a transformers.js
 * speech-recognition pipeline and transcribes 16 kHz mono audio.
 *
 * It runs in one of two places, with the same code: inside a Web Worker
 * (`whisper-local.worker.ts` serves it over `postMessage`; the default for
 * a UI that must stay responsive) or in the page's own thread (tests, and
 * hosts that cannot bundle a worker). Nothing here touches the DOM.
 *
 * `@huggingface/transformers` is an OPTIONAL peer. This module never imports
 * it: whoever builds an engine hands it a loader, so apps that do not use
 * local speech recognition do not bundle it.
 */

/** Where the speech model comes from by default. */
export const WHISPER_LOCAL_DEFAULT_MODEL = 'onnx-community/whisper-tiny.en';

/**
 * Bytes a first download of the default model takes: the 8-bit encoder
 * (~10 MB), merged decoder (~31 MB) and tokenizer/config files (~4 MB).
 */
export const WHISPER_LOCAL_DEFAULT_SIZE_BYTES = 45_100_000;

/** Approximate download sizes (8-bit) for the other English-only sizes. */
export const WHISPER_LOCAL_MODEL_SIZE_BYTES: Readonly<Record<string, number>> =
  {
    'onnx-community/whisper-tiny.en': WHISPER_LOCAL_DEFAULT_SIZE_BYTES,
    'onnx-community/whisper-base.en': 85_000_000,
    'onnx-community/whisper-small.en': 260_000_000,
  };

export type WhisperLocalDevice = 'webgpu' | 'wasm';

/** What a load needs; sent to the worker as plain data. */
export interface WhisperLocalEngineConfig {
  modelId: string;
  /** `'auto'` picks WebGPU when an adapter exists, else WASM. */
  device: 'auto' | WhisperLocalDevice;
  /** Quantisation, e.g. `'q8'` (default). */
  dtype: string;
  allowLocalModels: boolean;
}

/** A pipeline progress event (the parts this module reads). */
export interface TransformersProgress {
  status?: string;
  loaded?: number;
  total?: number;
  file?: string;
}

export type WhisperLocalTranscriber = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text?: string } | Array<{ text?: string }>>;

/**
 * The slice of `@huggingface/transformers` this engine uses, described
 * structurally so its full types stay out of this module's surface.
 */
export interface WhisperTransformersModule {
  pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>,
  ): Promise<WhisperLocalTranscriber>;
  env?: {
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
    backends?: { onnx?: { wasm?: { numThreads?: number; proxy?: boolean } } };
  };
  ModelRegistry?: {
    is_pipeline_cached(
      task: string,
      model: string,
      options?: Record<string, unknown>,
    ): Promise<boolean>;
  };
}

export type WhisperTransformersLoader =
  () => Promise<WhisperTransformersModule>;

const TASK = 'automatic-speech-recognition';

/** True when this thread can get a WebGPU adapter. */
async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (
      globalThis as {
        navigator?: { gpu?: { requestAdapter(): Promise<unknown> } };
      }
    ).navigator?.gpu;
    if (!gpu) return false;
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

function isEnglishOnly(modelId: string): boolean {
  return /\.en$/i.test(modelId);
}

/** `en-CA` -> `en`; whisper wants the language's name or two-letter code. */
export function whisperLanguage(language?: string): string | undefined {
  const code = language?.split(/[-_]/)[0]?.toLowerCase();
  return code || undefined;
}

export class WhisperLocalEngine {
  private module: WhisperTransformersModule | null = null;
  private transcriber: WhisperLocalTranscriber | null = null;
  private config: WhisperLocalEngineConfig | null = null;
  private loading: Promise<WhisperLocalDevice> | null = null;
  device: WhisperLocalDevice | null = null;

  constructor(private readonly loadTransformers: WhisperTransformersLoader) {}

  private async transformers(
    config: WhisperLocalEngineConfig,
  ): Promise<WhisperTransformersModule> {
    if (!this.module) {
      this.module = await this.loadTransformers();
      const env = this.module.env;
      if (env) {
        env.allowLocalModels = config.allowLocalModels;
        // Cache Storage: the second load comes from disk, not the network.
        env.useBrowserCache = true;
        // Static hosts cannot send COOP/COEP, so there is no
        // SharedArrayBuffer: run the WASM runtime on one thread.
        const isolated =
          (globalThis as { crossOriginIsolated?: boolean })
            .crossOriginIsolated === true;
        const wasm = env.backends?.onnx?.wasm;
        if (wasm && !isolated) wasm.numThreads = 1;
      }
    }
    return this.module;
  }

  /** Whether every file the model needs is already in the browser cache. */
  async isCached(config: WhisperLocalEngineConfig): Promise<boolean> {
    try {
      const mod = await this.transformers(config);
      if (!mod.ModelRegistry) return false;
      return await mod.ModelRegistry.is_pipeline_cached(TASK, config.modelId, {
        dtype: config.dtype,
      });
    } catch {
      return false;
    }
  }

  /**
   * Download (or read from cache) and build the pipeline. Concurrent calls
   * share one load. `onProgress` gets cumulative bytes across all files.
   */
  load(
    config: WhisperLocalEngineConfig,
    onProgress?: (loaded: number, total: number, file?: string) => void,
  ): Promise<WhisperLocalDevice> {
    if (this.transcriber && this.device) return Promise.resolve(this.device);
    this.loading ??= this.doLoad(config, onProgress).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async doLoad(
    config: WhisperLocalEngineConfig,
    onProgress?: (loaded: number, total: number, file?: string) => void,
  ): Promise<WhisperLocalDevice> {
    const mod = await this.transformers(config);
    this.config = config;
    const progress_callback = (event: TransformersProgress) => {
      if (
        event.status === 'progress_total' &&
        typeof event.loaded === 'number' &&
        typeof event.total === 'number'
      ) {
        onProgress?.(event.loaded, event.total, event.file);
      }
    };
    const wantGpu =
      config.device === 'webgpu' ||
      (config.device === 'auto' && (await hasWebGpu()));
    if (wantGpu) {
      try {
        this.transcriber = await mod.pipeline(TASK, config.modelId, {
          device: 'webgpu',
          dtype: config.dtype,
          progress_callback,
        });
        this.device = 'webgpu';
        return 'webgpu';
      } catch (error) {
        // An explicit request for WebGPU is honoured as a failure; "auto"
        // quietly falls back to the WASM runtime.
        if (config.device === 'webgpu') throw error;
      }
    }
    this.transcriber = await mod.pipeline(TASK, config.modelId, {
      device: 'wasm',
      dtype: config.dtype,
      progress_callback,
    });
    this.device = 'wasm';
    return 'wasm';
  }

  /** Transcribe 16 kHz mono PCM. Resolves the trimmed text. */
  async transcribe(audio: Float32Array, language?: string): Promise<string> {
    if (!this.transcriber || !this.config) {
      throw new Error('The speech model is not loaded');
    }
    const options: Record<string, unknown> = {
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    };
    const lang = whisperLanguage(language);
    // English-only models reject a language option.
    if (lang && !isEnglishOnly(this.config.modelId)) options.language = lang;
    const out = await this.transcriber(audio, options);
    const first = Array.isArray(out)
      ? out.map((o) => o.text ?? '').join(' ')
      : out.text;
    return (first ?? '').trim();
  }

  dispose(): void {
    this.transcriber = null;
    this.device = null;
    this.module = null;
    this.config = null;
  }
}

// -- Worker protocol ---------------------------------------------------------

export type WhisperWorkerRequest =
  | { id: number; type: 'isCached'; config: WhisperLocalEngineConfig }
  | { id: number; type: 'load'; config: WhisperLocalEngineConfig }
  | { id: number; type: 'transcribe'; audio: Float32Array; language?: string };

export type WhisperWorkerResponse =
  | {
      id: number;
      type: 'progress';
      loaded: number;
      total: number;
      file?: string;
    }
  | { id: number; type: 'result'; value: unknown }
  | { id: number; type: 'error'; message: string };

/** The part of a worker's global scope the server uses. */
export interface WhisperWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: { data: WhisperWorkerRequest }) => void,
  ): void;
  postMessage(message: WhisperWorkerResponse): void;
}

/** Answer `WhisperWorkerRequest`s on `scope` with a fresh engine. */
export function serveWhisperLocalEngine(
  scope: WhisperWorkerScope,
  loadTransformers: WhisperTransformersLoader,
): WhisperLocalEngine {
  const engine = new WhisperLocalEngine(loadTransformers);
  scope.addEventListener('message', (event) => {
    const request = event.data;
    const reply = (message: WhisperWorkerResponse) =>
      scope.postMessage(message);
    const run = async (): Promise<unknown> => {
      switch (request.type) {
        case 'isCached':
          return engine.isCached(request.config);
        case 'load':
          return engine.load(request.config, (loaded, total, file) =>
            reply({ id: request.id, type: 'progress', loaded, total, file }),
          );
        case 'transcribe':
          return engine.transcribe(request.audio, request.language);
      }
    };
    run().then(
      (value) => reply({ id: request.id, type: 'result', value }),
      (error: unknown) =>
        reply({
          id: request.id,
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  });
  return engine;
}
