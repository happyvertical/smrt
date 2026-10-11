import { type KitchenEndpoint, parseKitchenConfig } from '../kitchen/client.ts';

/**
 * Where the assistant's language model runs, chosen at runtime by
 * `planner.config.json` (served next to the app, like a host page's own
 * config file) or by a mounted `Planner`'s `inference` prop, which wins.
 *
 * - `browser`: a small model on this device (WebLLM). The default.
 * - `host`: the host page's server endpoint; the server owns the prompt.
 * - `byo`: the visitor's own OpenAI-compatible endpoint (Ollama, OpenRouter,
 *   OpenAI, custom), configured on the AI page.
 */
export type InferenceMode = 'browser' | 'host' | 'byo';

export const INFERENCE_MODES: readonly InferenceMode[] = [
  'browser',
  'host',
  'byo',
];

/** A bring-your-own endpoint the AI page offers. */
export interface ByoPresetDefinition {
  id: string;
  label: string;
  /** OpenAI-compatible base, e.g. `http://localhost:11434/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  /** A model to suggest. */
  model?: string;
  /** The visitor types the base URL themselves. */
  customUrl?: boolean;
  /** No key is needed (a local server). */
  keyless?: boolean;
  /** Browser-access note shown with the preset. */
  cors?: string;
}

export interface InferenceConfig {
  mode: InferenceMode;
  host?: { endpoint: string };
  byo?: {
    /**
     * Which presets to offer: ids of the built-in ones (`ollama`,
     * `openrouter`, `openai`, `custom`) or full definitions. Default: all
     * built-in presets.
     */
    presets?: (string | ByoPresetDefinition)[];
  };
}

export const DEFAULT_INFERENCE: InferenceConfig = { mode: 'browser' };

/** The file name, served at `${base}/planner.config.json`. */
export const CONFIG_FILE = 'planner.config.json';

export interface ConfigResult {
  config: InferenceConfig;
  /** The `kitchen` block (`smrt kitchen`), when the file has a usable one. */
  kitchen?: KitchenEndpoint;
  /** Shown to the visitor when the config was unusable and `browser` is used instead. */
  notice?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** http(s) only; a path-only endpoint (`/api/planner/chat`) is the host's own origin. */
export function isUsableEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  if (text.startsWith('/') && !text.startsWith('//')) return true;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parsePresetDefinition(value: unknown): ByoPresetDefinition | null {
  if (!isObject(value)) return null;
  const { id, label, baseUrl, model, keyless, cors } = value;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
    return null;
  }
  if (typeof label !== 'string' || !label.trim()) return null;
  if (!isUsableEndpoint(baseUrl) || baseUrl.startsWith('/')) return null;
  return {
    id,
    label: label.trim(),
    baseUrl: baseUrl.trim(),
    ...(typeof model === 'string' && model.trim()
      ? { model: model.trim() }
      : {}),
    ...(keyless === true ? { keyless: true } : {}),
    ...(typeof cors === 'string' && cors.trim() ? { cors: cors.trim() } : {}),
  };
}

const fallback = (why: string): ConfigResult => ({
  config: DEFAULT_INFERENCE,
  notice: `The assistant settings could not be used (${why}), so it runs in your browser instead.`,
});

/**
 * Validate a parsed config. Anything wrong (unknown mode, `host` without a
 * usable endpoint, a malformed preset list) falls back to `browser` with a
 * notice, never to a half-working mode.
 */
export function validateInferenceConfig(value: unknown): ConfigResult {
  if (!isObject(value)) return fallback('not an object');
  const inference = value.inference;
  if (inference === undefined) return { config: DEFAULT_INFERENCE };
  if (!isObject(inference)) return fallback('"inference" is not an object');
  const mode = inference.mode;
  if (mode === undefined || mode === 'browser') {
    return { config: DEFAULT_INFERENCE };
  }
  if (mode === 'host') {
    const host = inference.host;
    if (!isObject(host) || !isUsableEndpoint(host.endpoint)) {
      return fallback('host mode needs host.endpoint, an http(s) URL or path');
    }
    return {
      config: { mode: 'host', host: { endpoint: host.endpoint.trim() } },
    };
  }
  if (mode === 'byo') {
    const byo = inference.byo;
    if (byo === undefined) return { config: { mode: 'byo' } };
    if (!isObject(byo)) return fallback('"byo" is not an object');
    if (byo.presets === undefined) return { config: { mode: 'byo', byo: {} } };
    if (!Array.isArray(byo.presets) || byo.presets.length === 0) {
      return fallback('byo.presets must be a non-empty list');
    }
    const presets: (string | ByoPresetDefinition)[] = [];
    for (const entry of byo.presets) {
      if (typeof entry === 'string' && entry.trim()) {
        presets.push(entry.trim());
        continue;
      }
      const definition = parsePresetDefinition(entry);
      if (!definition) return fallback('a byo preset is malformed');
      presets.push(definition);
    }
    return { config: { mode: 'byo', byo: { presets } } };
  }
  return fallback(`unknown mode "${String(mode)}"`);
}

/** Parse the file's text. */
export function parseInferenceConfig(text: string): ConfigResult {
  try {
    const value: unknown = JSON.parse(text);
    const result = validateInferenceConfig(value);
    const kitchen = isObject(value)
      ? parseKitchenConfig(value.kitchen)
      : undefined;
    return kitchen ? { ...result, kitchen } : result;
  } catch {
    return fallback('it is not valid JSON');
  }
}

/** The mounted component's prop, validated like the file. Invalid: browser plus a notice. */
export function configFromProp(prop: unknown): ConfigResult {
  return validateInferenceConfig({ inference: prop });
}

/**
 * Fetch `${base}/planner.config.json`. A missing file (404, network error)
 * means the defaults and no notice; a file that is there but unusable means
 * `browser` and a notice.
 */
export async function loadInferenceConfig(
  base = '',
  fetcher: typeof fetch = fetch,
): Promise<ConfigResult> {
  let response: Response;
  try {
    response = await fetcher(`${base.replace(/\/$/, '')}/${CONFIG_FILE}`, {
      headers: { accept: 'application/json' },
      cache: 'no-cache',
    });
  } catch {
    return { config: DEFAULT_INFERENCE };
  }
  if (response.status === 404) return { config: DEFAULT_INFERENCE };
  if (!response.ok) return fallback(`the file answered ${response.status}`);
  const text = await response.text();
  // A static host with a SPA fallback answers a missing file with HTML.
  if (/^\s*</.test(text)) return { config: DEFAULT_INFERENCE };
  return parseInferenceConfig(text);
}
