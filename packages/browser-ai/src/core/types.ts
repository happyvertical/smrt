/**
 * Core types for browser AI capabilities
 */

/**
 * Download progress tracking for large models/WASM files
 */
export interface DownloadProgress {
  /** Current download state */
  state: 'idle' | 'downloading' | 'extracting' | 'complete' | 'error';
  /** Bytes downloaded so far */
  bytesLoaded: number;
  /** Total bytes to download (0 if unknown) */
  bytesTotal: number;
  /** Progress percentage (0-100) */
  percent: number;
  /** Current file being downloaded (for multi-file downloads) */
  currentFile?: string;
  /** Estimated time remaining in ms */
  estimatedTimeRemaining?: number;
  /** Error message if state is 'error' */
  error?: string;
}

/**
 * Callback for download progress updates
 */
export type OnProgress = (progress: DownloadProgress) => void;

/**
 * Initialization state for adapters with two-phase init
 */
export type InitState = 'uninitialized' | 'initializing' | 'ready' | 'error';

/**
 * Base options for all browser AI adapters
 */
export interface BaseBrowserAIOptions {
  /** Callback for download progress */
  onProgress?: OnProgress;
  /** Timeout for initialization in ms */
  timeout?: number;
  /**
   * Whether to allow loading models from local /models/ path.
   * When false, models are loaded from remote CDN (HuggingFace Hub).
   * @default false - Use remote models by default to avoid 404s
   */
  allowLocalModels?: boolean;
}

/**
 * Speech-to-text capabilities
 */
export interface STTCapabilitiesInfo {
  /** Browser Web Speech API available */
  browserSpeechAPI: boolean;
  /** Whisper WASM can run (requires WASM + potentially SharedArrayBuffer) */
  whisperWasm: boolean;
}

/**
 * Text-to-speech capabilities
 */
export interface TTSCapabilitiesInfo {
  /** Browser Speech Synthesis API available */
  browserSynthesisAPI: boolean;
  /** Transformers.js TTS can run */
  transformersTTS: boolean;
}

/**
 * LLM capabilities
 */
export interface LLMCapabilitiesInfo {
  /** WebLLM can run */
  webllm: boolean;
  /** Transformers.js LLM can run */
  transformersLLM: boolean;
  /** WebGPU acceleration available */
  webgpu: boolean;
}

/**
 * General browser capabilities
 */
export interface BrowserCapabilitiesInfo {
  /** SharedArrayBuffer available (needed for some WASM) */
  sharedArrayBuffer: boolean;
  /** Web Workers available */
  webWorkers: boolean;
  /** IndexedDB available (for caching models) */
  indexedDB: boolean;
  /** WebAssembly supported */
  wasmSupport: boolean;
  /** SIMD WASM supported */
  wasmSimd: boolean;
}

/**
 * Complete browser AI capabilities
 */
export interface BrowserAICapabilities {
  /** Speech-to-text capabilities */
  stt: STTCapabilitiesInfo;
  /** Text-to-speech capabilities */
  tts: TTSCapabilitiesInfo;
  /** LLM capabilities */
  llm: LLMCapabilitiesInfo;
  /** General browser capabilities */
  browser: BrowserCapabilitiesInfo;
}

/**
 * Create a default "idle" progress state
 */
export function createIdleProgress(): DownloadProgress {
  return {
    state: 'idle',
    bytesLoaded: 0,
    bytesTotal: 0,
    percent: 0,
  };
}

/**
 * Create an error progress state
 */
export function createErrorProgress(error: string): DownloadProgress {
  return {
    state: 'error',
    bytesLoaded: 0,
    bytesTotal: 0,
    percent: 0,
    error,
  };
}

/**
 * Calculate progress percentage
 */
export function calculatePercent(loaded: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((loaded / total) * 100);
}
