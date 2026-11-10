/**
 * The origin-bound key rule (#4754, ported from the planner's BYO screen).
 *
 * A key is bound, when it is saved, to the origin of the endpoint it was
 * entered for (the explicit base URL, else the preset's, else the provider's
 * default API endpoint). It is only ever sent to that origin: a request to
 * any other origin gets no key, even when the user later edits the base URL.
 * The settings panel never receives a key back, only "set / not set".
 *
 * Storage stays with the host: `bindInferenceKey()` returns the bound
 * record, and `inferenceProviderConfigFromKey()` turns it into the #4756
 * `inference.provider-config` value the host writes through the user
 * resolver's `write()` (one secret type for every key).
 */
import { isInferencePresetId } from '@happyvertical/smrt-core';
import { inferenceProbeUrl } from '../node.js';

/** What the host stores in smrt-secrets for one provider key. */
export interface InferenceKeyRecord {
  provider: string;
  preset?: string;
  /** The base URL the key was entered for, when one was given. */
  baseUrl?: string;
  /** The only origin this key is ever sent to. */
  origin: string;
  apiKey: string;
}

/** Thrown when a key cannot be bound to an origin. Nothing should be stored. */
export class InferenceKeyOriginError extends Error {
  readonly status = 400;
  constructor(reason: string) {
    super(`Cannot bind the key: ${reason}`);
    this.name = 'InferenceKeyOriginError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * SDK base URLs for providers whose client appends its own version path
 * (the Anthropic SDK calls `{baseURL}/v1/messages`; the probe base carries
 * `/v1`). A stored binding names these, not the probe base.
 */
const SDK_DEFAULT_BASE: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
};

/** Gateways whose default endpoint is not the provider's own: they need a base URL. */
const NEEDS_BASE_URL = new Set(['litellm', 'bifrost']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InferenceKeyOriginError('the base URL is not a URL');
  }
  if (parsed.username || parsed.password) {
    throw new InferenceKeyOriginError('the base URL carries credentials');
  }
  if (parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) {
    return parsed.origin;
  }
  throw new InferenceKeyOriginError(
    'a key travels only over https (plain http is allowed for loopback servers)',
  );
}

/**
 * The origin a key for this endpoint is bound to, or `null` when none can be
 * known (an unknown provider without a base URL, or a gateway without one).
 */
export function inferenceKeyOrigin(input: {
  provider?: string;
  preset?: string;
  baseUrl?: string;
}): string | null {
  const baseUrl = text(input.baseUrl);
  if (baseUrl) return originOf(baseUrl);
  const provider = text(input.provider)?.toLowerCase();
  // A provider id that names a #4674 preset (the panel's preset choices)
  // binds to that preset's endpoint.
  const preset =
    text(input.preset) ??
    (provider && isInferencePresetId(provider) ? provider : undefined);
  if (!preset && (!provider || NEEDS_BASE_URL.has(provider))) return null;
  if (preset && !isInferencePresetId(preset)) return null;
  const url = inferenceProbeUrl(preset ? { preset } : { provider });
  return url ? originOf(url) : null;
}

/**
 * Bind a key to its endpoint's origin. The host stores the returned record
 * through `SecretService` and hands the panel back only `keySet: true`.
 *
 * @throws {InferenceKeyOriginError} when the key is blank or no origin can be known.
 */
export function bindInferenceKey(input: {
  provider: string;
  key: string;
  preset?: string;
  baseUrl?: string;
}): InferenceKeyRecord {
  const provider = text(input.provider);
  const apiKey = text(input.key);
  if (!provider) throw new InferenceKeyOriginError('no provider');
  if (!apiKey) throw new InferenceKeyOriginError('the key is empty');
  const origin = inferenceKeyOrigin(input);
  if (!origin) {
    throw new InferenceKeyOriginError(
      `no endpoint is known for "${provider}"; enter its base URL first`,
    );
  }
  const record: InferenceKeyRecord = { provider, origin, apiKey };
  const preset = text(input.preset);
  const baseUrl = text(input.baseUrl);
  if (preset) record.preset = preset;
  if (baseUrl) record.baseUrl = baseUrl;
  return record;
}

/**
 * The #4756 stored provider config (`inference.provider-config`, written
 * through the user resolver's `write(level, config)`) for a bound key: the
 * one place a panel-saved key is stored, so the resolver uses it. The
 * binding is self-contained: a preset key keeps its preset (the preset
 * supplies the endpoint), a provider key names its endpoint explicitly
 * (its base URL, else the provider default it was bound to), and the
 * endpoint is checked against the bound origin again.
 *
 * @throws {InferenceKeyOriginError} when no endpoint on the bound origin is
 *   known, or a preset key has no model.
 */
export function inferenceProviderConfigFromKey(
  record: InferenceKeyRecord,
  choice: { model?: string } = {},
): {
  provider?: string;
  preset?: string;
  baseUrl?: string;
  model?: string;
  apiKey: string;
} {
  const model = text(choice.model);
  // A provider id that names a preset binds to that preset (as
  // `inferenceKeyOrigin()` does).
  const preset =
    text(record.preset) ??
    (isInferencePresetId(record.provider) ? record.provider : undefined);
  if (preset) {
    if (!model) throw new InferenceKeyOriginError('a preset key needs a model');
    const custom = text(record.baseUrl);
    const presetUrl = isInferencePresetId(preset)
      ? inferenceProbeUrl({ preset })
      : undefined;
    const endpoint = custom ?? presetUrl;
    if (!endpoint || originOf(endpoint) !== record.origin) {
      throw new InferenceKeyOriginError(
        `no endpoint on ${record.origin} is known for preset "${preset}"`,
      );
    }
    // A preset always calls its own endpoint, so a key entered for a custom
    // base URL on another origin is stored as the OpenAI-compatible endpoint
    // it was entered for (every preset is one), never under the preset.
    if (custom && (!presetUrl || originOf(presetUrl) !== record.origin)) {
      return {
        provider: 'openai',
        baseUrl: custom,
        model,
        apiKey: record.apiKey,
      };
    }
    return { preset, model, apiKey: record.apiKey };
  }
  let baseUrl = text(record.baseUrl);
  if (!baseUrl) {
    const provider = record.provider.toLowerCase();
    const url = inferenceProbeUrl({ provider });
    baseUrl = Object.hasOwn(SDK_DEFAULT_BASE, provider)
      ? SDK_DEFAULT_BASE[provider]
      : url?.replace(/\/(?:models|api\/tags)$/, '');
  }
  if (!baseUrl || originOf(baseUrl) !== record.origin) {
    throw new InferenceKeyOriginError(
      `no endpoint on ${record.origin} is known for "${record.provider}"; enter its base URL`,
    );
  }
  return {
    provider: record.provider,
    baseUrl,
    ...(model ? { model } : {}),
    apiKey: record.apiKey,
  };
}

/**
 * The key to send to `url`, or `undefined` when `url` is not on the key's
 * bound origin (or is not a URL). The only way a stored key reaches a request.
 */
export function inferenceKeyFor(
  record: InferenceKeyRecord | null | undefined,
  url: string,
): string | undefined {
  if (!record?.apiKey || !record.origin) return undefined;
  try {
    return new URL(url).origin === record.origin ? record.apiKey : undefined;
  } catch {
    return undefined;
  }
}

/** A short placeholder for a stored key; never derived from the key itself. */
export const REDACTED_KEY = '[redacted]';

/**
 * Remove a key (and common key shapes) from text bound for a screen or a
 * log. Used on every test-connection detail before it leaves the server.
 */
export function redactInferenceSecret(text: string, secret?: string): string {
  let out = text;
  if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED_KEY);
  return out
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, REDACTED_KEY)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED_KEY}`);
}
