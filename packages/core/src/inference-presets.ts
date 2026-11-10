/**
 * BYO inference presets (#4674): named OpenAI-compatible endpoints a user
 * picks instead of typing a base URL. Browser-safe (no `node:` imports) so an
 * alias candidate can name a preset id on any runtime (#4752); local model
 * discovery stays in the Node-only `./byo-inference` subpath.
 */

import type { OpenAIOptions } from '@happyvertical/ai';

export const INFERENCE_PRESETS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  lemonade: {
    baseUrl: 'http://127.0.0.1:13305/v1',
    requiresApiKey: false,
  },
  'llama.cpp': {
    baseUrl: 'http://127.0.0.1:9931/v1',
    requiresApiKey: false,
  },
  'lm-studio': {
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresApiKey: false,
  },
} as const;

export type InferencePresetId = keyof typeof INFERENCE_PRESETS;

/** Every preset id, in declaration order. */
export const INFERENCE_PRESET_IDS = Object.freeze(
  Object.keys(INFERENCE_PRESETS),
) as readonly InferencePresetId[];

export function isInferencePresetId(id: unknown): id is InferencePresetId {
  return typeof id === 'string' && Object.hasOwn(INFERENCE_PRESETS, id);
}

/**
 * Resolve a named preset with an explicit model. Returns null when a preset,
 * model, or required API key is missing or invalid.
 */
export function resolveInferencePreset(
  id: string,
  input: { model: string; apiKey?: string },
): OpenAIOptions | null {
  if (!isInferencePresetId(id)) return null;

  const preset = INFERENCE_PRESETS[id];
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const apiKey =
    typeof input.apiKey === 'string' ? input.apiKey.trim() : undefined;
  if (!model || (!apiKey && preset.requiresApiKey)) return null;

  return {
    type: 'openai',
    baseUrl: preset.baseUrl,
    defaultModel: model,
    // The SDK requires a nonempty key. A fixed placeholder keeps keyless
    // local servers from receiving credentials inherited from the environment.
    apiKey: apiKey || 'smrt-local',
  };
}
