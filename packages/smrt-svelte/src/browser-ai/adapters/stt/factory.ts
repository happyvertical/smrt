/**
 * STT adapter factory with type guards
 *
 * Uses discriminated unions and lazy loading following SDK patterns.
 */

import {
  detectCapabilities,
  getBestSTTBackend,
} from '../../capabilities/detector.js';
import { UnsupportedAdapterError } from '../../core/errors.js';
import type {
  BrowserSpeechSTTOptions,
  GetSTTOptions,
  STTAdapter,
  WhisperCppSTTOptions,
  WhisperWasmSTTOptions,
} from './types.js';

/**
 * Type guard for Browser Speech API options
 */
function isBrowserSpeechOptions(
  options: GetSTTOptions,
): options is BrowserSpeechSTTOptions {
  return !options.type || options.type === 'browser-speech';
}

/**
 * Type guard for Whisper WASM options (transformers.js)
 */
function isWhisperWasmOptions(
  options: GetSTTOptions,
): options is WhisperWasmSTTOptions {
  return options.type === 'whisper-wasm';
}

/**
 * Type guard for Whisper.cpp options (@remotion/whisper-web)
 */
function isWhisperCppOptions(
  options: GetSTTOptions,
): options is WhisperCppSTTOptions {
  return options.type === 'whisper-cpp';
}

/**
 * Create an STT adapter
 *
 * Uses lazy loading to only import the requested adapter.
 *
 * @example
 * ```ts
 * // Browser Speech API (default)
 * const stt = await getSTT();
 *
 * // Explicit Browser Speech
 * const stt = await getSTT({ type: 'browser-speech' });
 *
 * // Whisper.cpp (recommended for accuracy)
 * const stt = await getSTT({ type: 'whisper-cpp', model: 'tiny.en' });
 *
 * // Whisper WASM (transformers.js - has known issues)
 * const stt = await getSTT({ type: 'whisper-wasm', modelSize: 'tiny' });
 * ```
 */
export async function getSTT(options: GetSTTOptions = {}): Promise<STTAdapter> {
  if (isBrowserSpeechOptions(options)) {
    const { BrowserSpeechSTTAdapter } = await import('./browser-speech.js');
    return new BrowserSpeechSTTAdapter(options);
  }

  if (isWhisperCppOptions(options)) {
    const { WhisperCppSTTAdapter } = await import('./whisper-cpp.js');
    return new WhisperCppSTTAdapter(options);
  }

  if (isWhisperWasmOptions(options)) {
    const { WhisperWasmSTTAdapter } = await import('./whisper-wasm.js');
    return new WhisperWasmSTTAdapter(options);
  }

  throw new UnsupportedAdapterError(String((options as GetSTTOptions).type), [
    'browser-speech',
    'whisper-cpp',
    'whisper-wasm',
  ]);
}

/**
 * Auto-detect and create the best available STT adapter
 *
 * Selection priority:
 * 1. Whisper WASM if WebGPU is available (best accuracy)
 * 2. Browser Speech API if available (no download)
 * 3. Whisper WASM as fallback
 *
 * @throws {CapabilityNotAvailableError} If no STT adapter is available
 *
 * @example
 * ```ts
 * const stt = await getSTTAuto();
 * console.log(`Using ${stt.type} adapter`);
 * ```
 */
export async function getSTTAuto(
  options: Partial<Omit<GetSTTOptions, 'type'>> = {},
): Promise<STTAdapter> {
  const caps = detectCapabilities();
  const backend = getBestSTTBackend(caps);

  if (!backend) {
    throw new Error('No STT capability available in this browser');
  }

  if (backend === 'whisper-wasm') {
    return getSTT({
      type: 'whisper-wasm',
      ...options,
    } as WhisperWasmSTTOptions);
  }

  return getSTT({
    type: 'browser-speech',
    ...options,
  } as BrowserSpeechSTTOptions);
}

/**
 * Check if a specific STT backend is available
 */
export function isSTTAvailable(
  type: 'browser-speech' | 'whisper-wasm',
): boolean {
  const caps = detectCapabilities();

  if (type === 'browser-speech') {
    return caps.stt.browserSpeechAPI;
  }

  if (type === 'whisper-wasm') {
    return caps.stt.whisperWasm;
  }

  return false;
}
