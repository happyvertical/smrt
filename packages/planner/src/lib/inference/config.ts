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
export type InferenceMode = 'manual' | 'browser' | 'host' | 'byo';

/** Where BYO provider credentials may live. Preferences are always separate. */
export type CredentialPersistence = 'local' | 'memory';

export const INFERENCE_MODES: readonly InferenceMode[] = [
  'manual',
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
  /** Other modes the visitor may deliberately select, in display order. */
  alternatives?: InferenceMode[];
  /** Defaults to `local` for compatibility. Hosted apps should use `memory`. */
  credentialPersistence?: CredentialPersistence;
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
export const MANUAL_INFERENCE: InferenceConfig = { mode: 'manual' };

/** The file name, served at `${base}/planner.config.json`. */
export const CONFIG_FILE = 'planner.config.json';

export interface ConfigResult {
  config: InferenceConfig;
  /** The `kitchen` block (`smrt kitchen`), when the file has a usable one. */
  kitchen?: KitchenEndpoint;
  /** Shown when a present config was unusable and inference was disabled. */
  notice?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** http(s) only; a path-only endpoint (`/api/planner/chat`) is the host's own origin. */
export function isUsableEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const relative = text.startsWith('/') && !text.startsWith('//');
    const url = new URL(text, relative ? 'https://planner.invalid' : undefined);
    if (!relative && url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false;
    }
    if (url.username || url.password) return false;
    for (const name of url.searchParams.keys()) {
      if (
        /^(?:api[-_]?key|key|token|authorization|secret|password)$/i.test(name)
      ) {
        return false;
      }
    }
    return true;
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
  config: MANUAL_INFERENCE,
  notice: `The assistant settings could not be used (${why}), so inference is off. The planner still works manually.`,
});

function parseAlternatives(
  value: unknown,
  initial: InferenceMode,
): InferenceMode[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) return null;
  const modes: InferenceMode[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !INFERENCE_MODES.includes(entry as InferenceMode) ||
      entry === initial ||
      modes.includes(entry as InferenceMode)
    ) {
      return null;
    }
    modes.push(entry as InferenceMode);
  }
  return modes;
}

function parseByo(value: unknown): InferenceConfig['byo'] | null {
  if (value === undefined) return {};
  if (!isObject(value)) return null;
  if (value.presets === undefined) return {};
  if (!Array.isArray(value.presets) || value.presets.length === 0) return null;
  const presets: (string | ByoPresetDefinition)[] = [];
  for (const entry of value.presets) {
    if (typeof entry === 'string' && entry.trim()) {
      presets.push(entry.trim());
      continue;
    }
    const definition = parsePresetDefinition(entry);
    if (!definition) return null;
    presets.push(definition);
  }
  return { presets };
}

/**
 * Validate a parsed config. A missing config keeps the standalone browser
 * default. A present but invalid config fails closed to manual planning with a
 * visible notice; it never selects a provider or downloads a model.
 */
export function validateInferenceConfig(value: unknown): ConfigResult {
  if (!isObject(value)) return fallback('not an object');
  const inference = value.inference;
  if (inference === undefined) return { config: DEFAULT_INFERENCE };
  if (!isObject(inference)) return fallback('"inference" is not an object');
  const mode = inference.mode;
  if (mode === undefined) return { config: DEFAULT_INFERENCE };
  if (!INFERENCE_MODES.includes(mode as InferenceMode)) {
    return fallback(`unknown mode "${String(mode)}"`);
  }
  const selected = mode as InferenceMode;
  const alternatives = parseAlternatives(inference.alternatives, selected);
  if (!alternatives) {
    return fallback(
      'alternatives must be unique supported modes other than mode',
    );
  }
  const credentialPersistence = inference.credentialPersistence;
  if (
    credentialPersistence !== undefined &&
    credentialPersistence !== 'local' &&
    credentialPersistence !== 'memory'
  ) {
    return fallback('credentialPersistence must be "local" or "memory"');
  }
  const modes = [selected, ...alternatives];
  let host: InferenceConfig['host'];
  if (modes.includes('host')) {
    const configuredHost = inference.host;
    if (
      !isObject(configuredHost) ||
      !isUsableEndpoint(configuredHost.endpoint)
    ) {
      return fallback('host mode needs host.endpoint, an http(s) URL or path');
    }
    host = { endpoint: configuredHost.endpoint.trim() };
  }
  let byo: InferenceConfig['byo'];
  if (modes.includes('byo')) {
    byo = parseByo(inference.byo) ?? undefined;
    if (!byo) return fallback('byo.presets must be a non-empty valid list');
  }
  return {
    config: {
      mode: selected,
      ...(alternatives.length ? { alternatives } : {}),
      ...(credentialPersistence ? { credentialPersistence } : {}),
      ...(host ? { host } : {}),
      ...(byo ? { byo } : {}),
    },
  };
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
