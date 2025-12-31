/**
 * Browser capability detection for AI features
 */

import type { BrowserAICapabilities } from '../core/types.js';

/**
 * Detect all browser AI capabilities
 * This is synchronous and cheap to call - no network requests
 */
export function detectCapabilities(): BrowserAICapabilities {
  const browser = detectBrowserCapabilities();

  return {
    stt: detectSTTCapabilities(browser),
    tts: detectTTSCapabilities(browser),
    llm: detectLLMCapabilities(browser),
    browser,
  };
}

/**
 * Detect general browser capabilities
 */
function detectBrowserCapabilities(): BrowserAICapabilities['browser'] {
  // Check if we're in a browser environment
  const isBrowser = typeof window !== 'undefined';

  if (!isBrowser) {
    return {
      sharedArrayBuffer: false,
      webWorkers: false,
      indexedDB: false,
      wasmSupport: false,
      wasmSimd: false,
    };
  }

  return {
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webWorkers: typeof Worker !== 'undefined',
    indexedDB: typeof indexedDB !== 'undefined',
    wasmSupport: typeof WebAssembly !== 'undefined',
    wasmSimd: detectWasmSimd(),
  };
}

/**
 * Detect WASM SIMD support
 */
function detectWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined') return false;

  try {
    // SIMD detection via a minimal WASM module that uses SIMD
    // This is the standard way to detect SIMD support
    const simdTest = new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d, // WASM magic
      0x01,
      0x00,
      0x00,
      0x00, // Version 1
      0x01,
      0x05,
      0x01,
      0x60,
      0x00,
      0x01,
      0x7b, // Type section: () -> v128
      0x03,
      0x02,
      0x01,
      0x00, // Function section
      0x0a,
      0x0a,
      0x01,
      0x08,
      0x00,
      0xfd,
      0x0c, // Code with v128.const
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x0b,
    ]);
    return WebAssembly.validate(simdTest);
  } catch {
    return false;
  }
}

/**
 * Detect STT capabilities
 */
function detectSTTCapabilities(
  browser: BrowserAICapabilities['browser'],
): BrowserAICapabilities['stt'] {
  const isBrowser = typeof window !== 'undefined';

  return {
    // Web Speech API
    browserSpeechAPI:
      isBrowser &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window),

    // Whisper WASM requires WASM support
    // SharedArrayBuffer is nice for threading but not strictly required
    whisperWasm: browser.wasmSupport,
  };
}

/**
 * Detect TTS capabilities
 */
function detectTTSCapabilities(
  browser: BrowserAICapabilities['browser'],
): BrowserAICapabilities['tts'] {
  const isBrowser = typeof window !== 'undefined';

  return {
    // Speech Synthesis API
    browserSynthesisAPI: isBrowser && 'speechSynthesis' in window,

    // Transformers.js TTS requires WASM
    transformersTTS: browser.wasmSupport,
  };
}

/**
 * Detect LLM capabilities
 */
function detectLLMCapabilities(
  browser: BrowserAICapabilities['browser'],
): BrowserAICapabilities['llm'] {
  const isBrowser = typeof window !== 'undefined';

  // Check for WebGPU
  const webgpu = isBrowser && 'gpu' in navigator;

  return {
    // WebLLM requires WebGPU for good performance
    // Can fall back to WASM but very slow
    webllm: webgpu || browser.wasmSupport,

    // Transformers.js can use WASM
    transformersLLM: browser.wasmSupport,

    // WebGPU for acceleration
    webgpu,
  };
}

/**
 * Check if any STT capability is available
 */
export function hasSTT(caps: BrowserAICapabilities): boolean {
  return caps.stt.browserSpeechAPI || caps.stt.whisperWasm;
}

/**
 * Check if any TTS capability is available
 */
export function hasTTS(caps: BrowserAICapabilities): boolean {
  return caps.tts.browserSynthesisAPI || caps.tts.transformersTTS;
}

/**
 * Check if any LLM capability is available
 */
export function hasLLM(caps: BrowserAICapabilities): boolean {
  return caps.llm.webllm || caps.llm.transformersLLM;
}

/**
 * Check if "smrt" mode can be enabled (at least one AI capability available)
 */
export function canEnableSmrtMode(caps: BrowserAICapabilities): boolean {
  return hasSTT(caps) || hasTTS(caps) || hasLLM(caps);
}

/**
 * Get the best available STT backend
 */
export function getBestSTTBackend(
  caps: BrowserAICapabilities,
): 'whisper-wasm' | 'browser-speech' | null {
  // Prefer Whisper for accuracy if available
  if (caps.stt.whisperWasm && caps.llm.webgpu) {
    return 'whisper-wasm';
  }
  if (caps.stt.browserSpeechAPI) {
    return 'browser-speech';
  }
  if (caps.stt.whisperWasm) {
    return 'whisper-wasm';
  }
  return null;
}

/**
 * Get the best available TTS backend
 */
export function getBestTTSBackend(
  caps: BrowserAICapabilities,
): 'browser-synthesis' | 'transformers' | null {
  // Prefer browser synthesis (no download, instant)
  if (caps.tts.browserSynthesisAPI) {
    return 'browser-synthesis';
  }
  if (caps.tts.transformersTTS) {
    return 'transformers';
  }
  return null;
}

/**
 * Get the best available LLM backend
 */
export function getBestLLMBackend(
  caps: BrowserAICapabilities,
): 'webllm' | 'transformers-llm' | null {
  // Prefer WebLLM with WebGPU for performance
  if (caps.llm.webllm && caps.llm.webgpu) {
    return 'webllm';
  }
  if (caps.llm.transformersLLM) {
    return 'transformers-llm';
  }
  if (caps.llm.webllm) {
    return 'webllm';
  }
  return null;
}
