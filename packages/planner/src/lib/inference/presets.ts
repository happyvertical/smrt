import type { ByoPresetDefinition } from './config.ts';

/** The first-party presets; a config's `byo.presets` picks from or adds to these. */
export const BUILT_IN_PRESETS: readonly ByoPresetDefinition[] = [
  {
    id: 'ollama',
    label: 'Ollama (on this computer)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    keyless: true,
    cors: 'Ollama only answers pages it trusts. Start it with OLLAMA_ORIGINS set to this site, for example OLLAMA_ORIGINS=https://your-site.example ollama serve (on macOS: launchctl setenv OLLAMA_ORIGINS https://your-site.example, then restart Ollama). A page served from http://localhost needs no change.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    cors: 'OpenRouter accepts calls from any web page, so no setup is needed. Use a key with a spending limit.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    cors: 'OpenAI accepts calls from web pages when the request carries a key. Use a restricted key with a low spending limit: anyone with access to this browser profile can read it.',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    baseUrl: '',
    customUrl: true,
    cors: 'The server must answer the browser\'s CORS preflight: allow this site\'s origin, the "authorization" and "content-type" headers, and the POST and OPTIONS methods.',
  },
];

/** Presets a config offers, in its order; unknown ids are dropped. Default: all built-ins. */
export function resolvePresets(
  requested?: readonly (string | ByoPresetDefinition)[],
): ByoPresetDefinition[] {
  if (!requested?.length) return [...BUILT_IN_PRESETS];
  const out: ByoPresetDefinition[] = [];
  for (const entry of requested) {
    const preset =
      typeof entry === 'string'
        ? BUILT_IN_PRESETS.find((p) => p.id === entry)
        : entry;
    if (preset && !out.some((p) => p.id === preset.id)) out.push(preset);
  }
  return out.length ? out : [...BUILT_IN_PRESETS];
}
