/**
 * The origin-bound key rule (#4754, ported from the planner's BYO screen).
 *
 * A key is bound, when it is saved, to the origin of the endpoint it was
 * entered for (the explicit base URL, else the preset's, else the provider's
 * default API endpoint). It is only ever sent to that origin: a request to
 * any other origin gets no key, even when the user later edits the base URL.
 * The settings panel never receives a key back, only "set / not set".
 *
 * Storage stays with the host: `bindInferenceKey()` returns the record the
 * host writes through smrt-secrets' `SecretService` (it is a subset of the
 * provider options #4756 stores as `inference.provider-config`).
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
