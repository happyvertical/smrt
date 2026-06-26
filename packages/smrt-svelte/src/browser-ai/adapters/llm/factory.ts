/**
 * LLM adapter factory with type guards
 */

import {
  detectCapabilities,
  getBestLLMBackend,
} from '../../capabilities/detector.js';
import { UnsupportedAdapterError } from '../../core/errors.js';
import type {
  GetLLMOptions,
  LLMAdapter,
  TransformersLLMOptions,
  WebLLMOptions,
} from './types.js';

/**
 * Type guard for WebLLM options
 */
function isWebLLMOptions(options: GetLLMOptions): options is WebLLMOptions {
  return !options.type || options.type === 'webllm';
}

/**
 * Type guard for Transformers.js LLM options
 */
function isTransformersLLMOptions(
  options: GetLLMOptions,
): options is TransformersLLMOptions {
  return options.type === 'transformers-llm';
}

/**
 * Create an LLM adapter
 *
 * Uses lazy loading to only import the requested adapter.
 *
 * @example
 * ```ts
 * // WebLLM (default)
 * const llm = await getLLM();
 *
 * // With specific model
 * const llm = await getLLM({ defaultModel: 'Llama-3.2-1B-Instruct-q4f16_1-MLC' });
 * ```
 */
export async function getLLM(options: GetLLMOptions = {}): Promise<LLMAdapter> {
  if (isWebLLMOptions(options)) {
    const { WebLLMAdapter } = await import('./webllm.js');
    return new WebLLMAdapter(options);
  }

  if (isTransformersLLMOptions(options)) {
    // Transformers.js adapter not yet implemented
    throw new UnsupportedAdapterError('transformers-llm', ['webllm']);
  }

  throw new UnsupportedAdapterError(String((options as GetLLMOptions).type), [
    'webllm',
    'transformers-llm',
  ]);
}

/**
 * Auto-detect and create the best available LLM adapter
 *
 * Selection priority:
 * 1. WebLLM with WebGPU (best performance)
 * 2. Transformers.js as fallback
 *
 * @throws If no LLM adapter is available
 */
export async function getLLMAuto(
  options: Partial<Omit<GetLLMOptions, 'type'>> = {},
): Promise<LLMAdapter> {
  const caps = detectCapabilities();
  const backend = getBestLLMBackend(caps);

  if (!backend) {
    throw new Error('No LLM capability available in this browser');
  }

  if (backend === 'webllm') {
    return getLLM({
      type: 'webllm',
      ...options,
    } as WebLLMOptions);
  }

  // transformers-llm fallback (not yet implemented)
  return getLLM({
    type: 'webllm', // Fall back to webllm even without WebGPU
    ...options,
  } as WebLLMOptions);
}

/**
 * Check if a specific LLM backend is available
 */
export function isLLMAvailable(type: 'webllm' | 'transformers-llm'): boolean {
  const caps = detectCapabilities();

  if (type === 'webllm') {
    return caps.llm.webllm;
  }

  if (type === 'transformers-llm') {
    return caps.llm.transformersLLM;
  }

  return false;
}

/**
 * Check if WebGPU is available for accelerated inference
 */
export function hasWebGPU(): boolean {
  return detectCapabilities().llm.webgpu;
}
