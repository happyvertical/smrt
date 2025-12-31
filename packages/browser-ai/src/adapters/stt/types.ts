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
  readonly type: 'browser-speech' | 'whisper-wasm' | 'whisper-cpp';

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
 * Whisper WASM adapter options
 */
export interface WhisperWasmSTTOptions extends BaseBrowserAIOptions {
  type: 'whisper-wasm';
  /** Model size: 'tiny', 'base', 'small' */
  modelSize?: 'tiny' | 'base' | 'small';
  /** Custom model URL (overrides modelSize) */
  modelUrl?: string;
  /** Language code for transcription */
  defaultLanguage?: string;
}

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
  | WhisperWasmSTTOptions
  | WhisperCppSTTOptions;
