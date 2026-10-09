/**
 * Speech-to-Text adapter types
 */

import type {
  BaseBrowserAIOptions,
  InitState,
  OnProgress,
} from '../../core/types.js';

/**
 * STT recognition result
 */
export interface STTResult {
  /** Transcribed text */
  text: string;
  /** Confidence score (0-1), if available */
  confidence: number;
  /** Whether this is a final result or interim */
  isFinal: boolean;
  /** Alternative transcriptions, if available */
  alternatives?: Array<{ text: string; confidence: number }>;
  /** Timestamp of the result */
  timestamp: number;
}

/**
 * STT adapter capabilities
 */
export interface STTCapabilities {
  /** Whether continuous listening is supported */
  continuous: boolean;
  /** Whether interim results are supported */
  interimResults: boolean;
  /** Supported languages (BCP-47 codes) */
  languages: string[];
  /** Estimated accuracy level */
  accuracy: 'low' | 'medium' | 'high';
  /** Whether download is required before use */
  requiresDownload: boolean;
  /** Estimated download size in bytes (if requiresDownload) */
  downloadSize?: number;
}

/**
 * Options for STT recognition session
 */
export interface STTOptions {
  /** Language code (BCP-47, e.g., 'en-US') */
  language?: string;
  /** Enable continuous recognition (keep listening after results) */
  continuous?: boolean;
  /** Provide interim results as user speaks */
  interimResults?: boolean;
}

/**
 * STT event callbacks
 */
export interface STTEventHandlers {
  onResult?: (result: STTResult) => void;
  onError?: (error: Error) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onSoundStart?: () => void;
  onSoundEnd?: () => void;
}

/**
 * STT adapter interface - all STT implementations must implement this
 */
export interface STTAdapter {
  /** Adapter type identifier */
  readonly type:
    | 'browser-speech'
    | 'whisper-wasm'
    | 'whisper-local'
    | 'moonshine'
    | 'whisper-cpp';

  /** Current initialization state */
  readonly initState: InitState;

  /**
   * Initialize the adapter (phase 2 of two-phase init)
   * Downloads models/WASM if required
   */
  ensureInitialized(onProgress?: OnProgress): Promise<void>;

  /**
   * Get adapter capabilities
   */
  getCapabilities(): STTCapabilities;

  /**
   * Start listening for speech
   */
  start(options?: STTOptions): Promise<void>;

  /**
   * Stop listening
   */
  stop(): Promise<void>;

  /**
   * Abort listening (stops immediately without final result)
   */
  abort(): void;

  /**
   * Check if currently listening
   */
  isListening(): boolean;

  /**
   * Subscribe to recognition results
   * @returns Unsubscribe function
   */
  onResult(callback: (result: STTResult) => void): () => void;

  /**
   * Subscribe to errors
   * @returns Unsubscribe function
   */
  onError(callback: (error: Error) => void): () => void;

  /**
   * Subscribe to start event
   * @returns Unsubscribe function
   */
  onStart(callback: () => void): () => void;

  /**
   * Subscribe to end event
   * @returns Unsubscribe function
   */
  onEnd(callback: () => void): () => void;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}

/**
 * Browser Speech API adapter options
 */
export interface BrowserSpeechSTTOptions extends BaseBrowserAIOptions {
  type?: 'browser-speech';
  /** Override default language */
  defaultLanguage?: string;
  /** Max alternatives to return */
  maxAlternatives?: number;
}

/**
 * On-device speech-to-text options (`@happyvertical/speech/local` on
 * transformers.js): speech recognition that runs in the browser after a
 * one-time model download, for browsers whose own speech recognition is
 * missing or unreliable (Firefox, Brave).
 *
 * `'whisper-local'` defaults to English-only Whisper; `'moonshine'` defaults
 * to Moonshine tiny, the fastest model for live dictation. `'whisper-wasm'`
 * is the older name for `'whisper-local'` and is accepted as an alias;
 * `modelSize` maps to the English-only Whisper model of that size.
 */
export interface LocalSpeechSTTOptions extends BaseBrowserAIOptions {
  type: 'whisper-local' | 'whisper-wasm' | 'moonshine';
  /**
   * A short name (`'moonshine-tiny'`, `'moonshine-base'`, `'whisper-tiny.en'`,
   * ...) or a Hugging Face model id. Default `onnx-community/whisper-tiny.en`
   * (`moonshine-tiny` for `type: 'moonshine'`).
   */
  model?: string;
  /** Alias of `model`. */
  modelId?: string;
  /** Legacy size selector (`whisper-wasm`): picks `whisper-<size>.en`. */
  modelSize?: 'tiny' | 'base' | 'small';
  /** `'auto'` (default): WebGPU when available, else single-thread WASM. */
  device?: 'auto' | 'webgpu' | 'wasm';
  /** Weight quantisation. Default `'q8'`. */
  dtype?: string;
  /** Language code for transcription (`en`, `fr-CA`, ...). */
  defaultLanguage?: string;
  /**
   * Make the Web Worker that runs the model. Pass one from the host app, where
   * the optional `@happyvertical/speech` and `@huggingface/transformers`
   * peers are installed (see `local-speech.worker.ts`). Without it the model
   * runs on the page's own thread.
   */
  createWorker?: () => Worker;
  /**
   * Load `@happyvertical/speech/local`, e.g.
   * `() => import('@happyvertical/speech/local')`. Needed in a bundled
   * browser app.
   */
  loadSpeech?: () => Promise<unknown>;
  /**
   * Load `@huggingface/transformers` for the in-page fallback, e.g.
   * `() => import('@huggingface/transformers')`. Needed in a browser when
   * there is no `createWorker`.
   */
  loadModule?: () => Promise<unknown>;
  /** Share one downloaded model between adapters and a consent UI. */
  modelHandle?: import('./local-speech-model.js').LocalSpeechModel;
  /** Longest recording in ms (default 2 minutes). */
  maxDurationMs?: number;
}

/** @deprecated Use {@link LocalSpeechSTTOptions}. */
export type WhisperLocalSTTOptions = LocalSpeechSTTOptions;

/** @deprecated Use {@link LocalSpeechSTTOptions}. */
export type WhisperWasmSTTOptions = LocalSpeechSTTOptions;

/**
 * Whisper.cpp WASM adapter options (using @remotion/whisper-web)
 */
export interface WhisperCppSTTOptions extends BaseBrowserAIOptions {
  type: 'whisper-cpp';
  /** Model size: 'tiny.en', 'base.en', 'small.en', 'tiny', 'base', 'small' */
  model?: 'tiny.en' | 'base.en' | 'small.en' | 'tiny' | 'base' | 'small';
}

/**
 * Union type for STT factory options
 */
export type GetSTTOptions =
  | BrowserSpeechSTTOptions
  | LocalSpeechSTTOptions
  | WhisperCppSTTOptions;
