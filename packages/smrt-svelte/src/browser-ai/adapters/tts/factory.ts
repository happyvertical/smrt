/**
 * TTS adapter factory with type guards
 *
 * Uses discriminated unions and lazy loading following SDK patterns.
 */

import {
  detectCapabilities,
  getBestTTSBackend,
} from '../../capabilities/detector.js';
import { UnsupportedAdapterError } from '../../core/errors.js';
import type { BrowserSynthesisTTSOptions, TTSAdapter } from './types.js';

/**
 * Options for getting a TTS adapter
 */
export type GetTTSOptions =
  | (BrowserSynthesisTTSOptions & { type?: 'browser-synthesis' })
  | { type: 'transformers' };

/**
 * Type guard for Browser Speech Synthesis options
 */
function isBrowserSynthesisOptions(
  options: GetTTSOptions,
): options is BrowserSynthesisTTSOptions & { type?: 'browser-synthesis' } {
  return !options.type || options.type === 'browser-synthesis';
}

/**
 * Type guard for Transformers.js TTS options
 */
function isTransformersOptions(
  options: GetTTSOptions,
): options is { type: 'transformers' } {
  return options.type === 'transformers';
}

/**
 * Create a TTS adapter
 *
 * Uses lazy loading to only import the requested adapter.
 *
 * @example
 * ```ts
 * // Browser Speech Synthesis (default)
 * const tts = await getTTS();
 *
 * // Explicit Browser Synthesis
 * const tts = await getTTS({ type: 'browser-synthesis' });
 *
 * // With custom defaults
 * const tts = await getTTS({ defaultRate: 1.2, defaultVoice: 'Google US English' });
 * ```
 */
export async function getTTS(options: GetTTSOptions = {}): Promise<TTSAdapter> {
  if (isBrowserSynthesisOptions(options)) {
    const { BrowserSynthesisTTSAdapter } = await import(
      './browser-synthesis.js'
    );
    return new BrowserSynthesisTTSAdapter(options);
  }

  if (isTransformersOptions(options)) {
    // Transformers.js TTS not yet implemented
    throw new UnsupportedAdapterError('transformers', ['browser-synthesis']);
  }

  throw new UnsupportedAdapterError((options as any).type, [
    'browser-synthesis',
  ]);
}

/**
 * Auto-detect and create the best available TTS adapter
 *
 * Selection priority:
 * 1. Browser Speech Synthesis (no download, instant)
 * 2. Transformers.js TTS (requires model download)
 *
 * @throws {Error} If no TTS adapter is available
 *
 * @example
 * ```ts
 * const tts = await getTTSAuto();
 * console.log(`Using ${tts.type} adapter`);
 * ```
 */
export async function getTTSAuto(
  options: Partial<Omit<GetTTSOptions, 'type'>> = {},
): Promise<TTSAdapter> {
  const caps = detectCapabilities();
  const backend = getBestTTSBackend(caps);

  if (!backend) {
    throw new Error('No TTS capability available in this browser');
  }

  if (backend === 'browser-synthesis') {
    return getTTS({
      type: 'browser-synthesis',
      ...options,
    } as BrowserSynthesisTTSOptions & { type: 'browser-synthesis' });
  }

  // Transformers.js TTS not yet implemented
  throw new Error('Transformers.js TTS not yet implemented');
}

/**
 * Check if a specific TTS backend is available
 */
export function isTTSAvailable(
  type: 'browser-synthesis' | 'transformers',
): boolean {
  const caps = detectCapabilities();

  if (type === 'browser-synthesis') {
    return caps.tts.browserSynthesisAPI;
  }

  if (type === 'transformers') {
    return caps.tts.transformersTTS;
  }

  return false;
}
