/**
 * The stored inference provider config (#4756): one smrt-secrets type,
 * `inference.provider-config`, holding a user's or a tenant's provider
 * options. The hosted wave (#4759) writes the same type with
 * `source: 'hosted'`.
 *
 * Browser-safe (core types and presets only) so a settings panel can share
 * the shape and the redacted view; reading and writing secrets lives in the
 * Node-only `./resolver` entry.
 */

import {
  INFERENCE_MODES,
  INFERENCE_PRESETS,
  INFERENCE_TIERS,
  type InferenceMode,
  type InferenceTarget,
  type InferenceTier,
  isInferenceMode,
  isInferencePresetId,
  isInferenceTier,
} from '@happyvertical/smrt-core';
import { SmrtError } from '@happyvertical/smrt-core/smrt-error';

/** The smrt-secrets category (and name prefix) of a stored provider config. */
export const INFERENCE_PROVIDER_CONFIG_SECRET_TYPE =
  'inference.provider-config';

/** Sources a stored config may declare; `app` belongs to app config only. */
export const INFERENCE_PROVIDER_CONFIG_SOURCES = [
  'byo',
  'local',
  'hosted',
] as const;

export type InferenceProviderConfigSource =
  (typeof INFERENCE_PROVIDER_CONFIG_SOURCES)[number];

/** One binding: provider options for every tier, or for one tier. */
export interface InferenceProviderBinding {
  /** Provider name (`openai`, `anthropic`, `ollama`, ...). */
  provider?: string;
  /** Endpoint. Required with `apiKey` unless `preset` supplies it. */
  baseUrl?: string;
  model?: string;
  /** The credential. Never logged, tagged, or returned redacted. */
  apiKey?: string;
  /** A #4674 preset id (`openrouter`, `lemonade`, ...); needs `model`. */
  preset?: string;
  /**
   * Per-call generation defaults; caller options win. Only
   * {@link INFERENCE_PROVIDER_PARAM_KEYS} with scalar values are accepted,
   * so no credential or header can hide here.
   */
  params?: Record<string, unknown>;
}

/**
 * The value of an `inference.provider-config` secret. The top-level binding
 * is the default for every tier; `tiers` binds tiers individually (#4754
 * Advanced) and wins for the tiers it names.
 */
export interface InferenceProviderConfig extends InferenceProviderBinding {
  version?: 1;
  /** Declared origin; derived (`local` / `byo`) when absent. */
  source?: InferenceProviderConfigSource;
  /**
   * The chosen inference mode (#4757). `off` turns every call off for this
   * scope; `byo` / `local` / `hosted` use only a stored binding of that
   * source. Absent: the fall-through order (user, tenant, app). A config may
   * hold only a mode (no binding, no key).
   */
  mode?: InferenceMode;
  /**
   * Hosted inference (#4759): the gateway virtual key's alias, a non-secret
   * handle recorded as the `gatewayKeyAlias` usage tag on every call this
   * config answers. Only valid with `source: 'hosted'`; never the key.
   */
  gatewayKeyAlias?: string;
  tiers?: Partial<Record<InferenceTier, InferenceProviderBinding>>;
}

/** A binding with its key removed: what a settings panel may read. */
export type RedactedInferenceProviderBinding = Omit<
  InferenceProviderBinding,
  'apiKey'
> & { hasApiKey: boolean };

/** {@link InferenceProviderConfig} with every key removed. */
export interface RedactedInferenceProviderConfig
  extends RedactedInferenceProviderBinding {
  version?: 1;
  source?: InferenceProviderConfigSource;
  mode?: InferenceMode;
  gatewayKeyAlias?: string;
  tiers?: Partial<Record<InferenceTier, RedactedInferenceProviderBinding>>;
}

/**
 * A stored config that cannot bind (`INFERENCE_PROVIDER_CONFIG_INVALID`).
 * Messages name fields by path, never values.
 */
export class InferenceProviderConfigError extends SmrtError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(
      `Invalid inference provider config: ${issues.join('; ')}`,
      'INFERENCE_PROVIDER_CONFIG_INVALID',
      'configuration',
      { issues },
    );
    this.issues = issues;
  }
}

/** Generation options a stored binding may carry in `params`. */
export const INFERENCE_PROVIDER_PARAM_KEYS = [
  'temperature',
  'maxTokens',
  'topP',
  'topK',
  'frequencyPenalty',
  'presencePenalty',
  'seed',
  'stop',
] as const;

const PARAM_KEYS: readonly string[] = INFERENCE_PROVIDER_PARAM_KEYS;

function isParamValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return true;
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((entry) => typeof entry === 'string')
  );
}

/** Only the allowed scalar generation options (defence for legacy rows). */
function safeParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!params) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined && isParamValue(value)) {
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const BINDING_FIELDS = [
  'provider',
  'baseUrl',
  'model',
  'apiKey',
  'preset',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function hasBinding(binding: InferenceProviderBinding | undefined): boolean {
  return !!binding && (!!binding.provider || !!binding.preset);
}

function parseBinding(
  value: unknown,
  path: string,
  issues: string[],
): InferenceProviderBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return undefined;
  }
  const binding: InferenceProviderBinding = {};
  for (const field of BINDING_FIELDS) {
    const raw = value[field];
    if (raw === undefined || raw === null || raw === '') continue;
    const parsed = text(raw);
    if (!parsed) {
      issues.push(`${path}.${field} must be a non-empty string`);
      continue;
    }
    binding[field] = parsed;
  }
  if (value.params !== undefined) {
    if (!isRecord(value.params)) {
      issues.push(`${path}.params must be an object`);
    } else {
      for (const [key, param] of Object.entries(value.params)) {
        if (!PARAM_KEYS.includes(key)) {
          issues.push(
            `${path}.params.${key} is not a supported generation option (${INFERENCE_PROVIDER_PARAM_KEYS.join(', ')})`,
          );
        } else if (!isParamValue(param)) {
          issues.push(`${path}.params.${key} must be a number or string`);
        }
      }
      const params = safeParams(value.params);
      if (params) binding.params = params;
    }
  }
  if (binding.preset) {
    if (!isInferencePresetId(binding.preset)) {
      issues.push(`${path}.preset is not a known preset`);
    } else {
      if (!binding.model) issues.push(`${path}.model is required with preset`);
      if (INFERENCE_PRESETS[binding.preset].requiresApiKey && !binding.apiKey) {
        issues.push(`${path}.apiKey is required by preset`);
      }
    }
    if (binding.provider) {
      issues.push(`${path} names both provider and preset`);
    }
  } else if (Object.keys(binding).length > 0 && !binding.provider) {
    issues.push(`${path}.provider is required`);
  }
  if (binding.baseUrl && !isPlainEndpoint(binding.baseUrl)) {
    issues.push(
      `${path}.baseUrl must be an http(s) URL without credentials, query or fragment`,
    );
  }
  // A stored binding is self-contained: its own endpoint and its own key
  // (core's pair rule), so it never borrows the server's environment
  // credentials (`OPENAI_API_KEY`, `HAVE_AI_*`, ...) for another provider.
  if (binding.provider && !binding.preset) {
    if (!binding.baseUrl) {
      issues.push(
        `${path}.baseUrl is required (a stored binding names its own endpoint)`,
      );
    }
    if (!binding.apiKey) {
      issues.push(
        `${path}.apiKey is required (a placeholder such as 'smrt-local' for a keyless local server)`,
      );
    }
  }
  return binding;
}

/**
 * Validate a stored value (an object, or its JSON text). Throws
 * {@link InferenceProviderConfigError} naming every offending path.
 */
export function parseInferenceProviderConfig(
  value: unknown,
): InferenceProviderConfig {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new InferenceProviderConfigError(['value is not JSON']);
    }
  }
  if (!isRecord(raw)) {
    throw new InferenceProviderConfigError(['value must be an object']);
  }
  const issues: string[] = [];
  const config: InferenceProviderConfig = {
    ...(parseBinding(
      Object.fromEntries(
        Object.entries(raw).filter(
          ([key]) =>
            key !== 'tiers' &&
            key !== 'source' &&
            key !== 'version' &&
            key !== 'mode' &&
            key !== 'gatewayKeyAlias',
        ),
      ),
      'config',
      issues,
    ) ?? {}),
  };
  if (raw.version !== undefined && raw.version !== 1) {
    issues.push('version must be 1');
  } else if (raw.version === 1) {
    config.version = 1;
  }
  if (raw.source !== undefined) {
    if (
      (INFERENCE_PROVIDER_CONFIG_SOURCES as readonly unknown[]).includes(
        raw.source,
      )
    ) {
      config.source = raw.source as InferenceProviderConfigSource;
    } else {
      issues.push(
        `source must be one of ${INFERENCE_PROVIDER_CONFIG_SOURCES.join(', ')}`,
      );
    }
  }
  if (raw.mode !== undefined) {
    if (isInferenceMode(raw.mode)) {
      config.mode = raw.mode;
    } else {
      issues.push(`mode must be one of ${INFERENCE_MODES.join(', ')}`);
    }
  }
  if (raw.gatewayKeyAlias !== undefined) {
    const alias = text(raw.gatewayKeyAlias);
    if (!alias || alias.length > 200) {
      issues.push(
        'gatewayKeyAlias must be a non-empty string of at most 200 characters',
      );
    } else if (config.source !== 'hosted') {
      issues.push("gatewayKeyAlias needs source 'hosted'");
    } else {
      config.gatewayKeyAlias = alias;
    }
  }
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) {
      issues.push('tiers must be an object');
    } else {
      const tiers: Partial<Record<InferenceTier, InferenceProviderBinding>> =
        {};
      for (const [tier, binding] of Object.entries(raw.tiers)) {
        if (!isInferenceTier(tier)) {
          issues.push(
            `tiers.${tier} is not a tier (${INFERENCE_TIERS.join(', ')})`,
          );
          continue;
        }
        const parsed = parseBinding(binding, `tiers.${tier}`, issues);
        if (parsed && hasBinding(parsed)) tiers[tier] = parsed;
      }
      if (Object.keys(tiers).length > 0) config.tiers = tiers;
    }
  }
  for (const known of Object.keys(raw)) {
    if (
      ![
        ...BINDING_FIELDS,
        'params',
        'tiers',
        'source',
        'version',
        'mode',
        'gatewayKeyAlias',
      ].includes(known)
    ) {
      issues.push(`config.${known} is not a provider config field`);
    }
  }
  if (issues.length > 0) throw new InferenceProviderConfigError(issues);
  return config;
}

/** An http(s) URL with no userinfo, query or fragment (no hidden secrets). */
function isPlainEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isLoopbackUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * The origin a binding reports as its `source` usage tag: the config's
 * declared source, else `local` for a keyless preset or a loopback endpoint,
 * else `byo`.
 */
export function inferenceProviderSource(
  config: Pick<InferenceProviderConfig, 'source'>,
  binding: InferenceProviderBinding,
): InferenceProviderConfigSource {
  if (config.source) return config.source;
  if (binding.preset && isInferencePresetId(binding.preset)) {
    return INFERENCE_PRESETS[binding.preset].requiresApiKey ? 'byo' : 'local';
  }
  if (binding.provider?.toLowerCase() === 'ollama') return 'local';
  return isLoopbackUrl(binding.baseUrl) ? 'local' : 'byo';
}

/** Keyless placeholder core's pair rule accepts for a local server. */
const KEYLESS_PLACEHOLDER = 'smrt-local';

function bindingToTarget(
  config: InferenceProviderConfig,
  binding: InferenceProviderBinding,
): InferenceTarget {
  const source = inferenceProviderSource(config, binding);
  // Hosted keys are tagged by alias (never the key) so metering can join
  // usage rows to the gateway's own key ledger (#4759).
  const usageTags = config.gatewayKeyAlias
    ? { usageTags: { gatewayKeyAlias: config.gatewayKeyAlias } }
    : {};
  if (binding.preset && isInferencePresetId(binding.preset)) {
    return {
      provider: 'openai',
      baseUrl: binding.baseUrl ?? INFERENCE_PRESETS[binding.preset].baseUrl,
      ...(binding.model ? { model: binding.model } : {}),
      apiKey: binding.apiKey ?? KEYLESS_PLACEHOLDER,
      ...(safeParams(binding.params)
        ? { params: safeParams(binding.params) }
        : {}),
      source,
      ...usageTags,
    };
  }
  return {
    ...(binding.provider ? { provider: binding.provider } : {}),
    ...(binding.model ? { model: binding.model } : {}),
    ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    ...(binding.apiKey ? { apiKey: binding.apiKey } : {}),
    ...(safeParams(binding.params)
      ? { params: safeParams(binding.params) }
      : {}),
    source,
    ...usageTags,
  };
}

/** The binding a config applies to `tier`, if any. */
export function inferenceProviderBindingFor(
  config: InferenceProviderConfig | undefined,
  tier: InferenceTier,
): InferenceProviderBinding | undefined {
  if (!config) return undefined;
  const own = config.tiers?.[tier];
  if (hasBinding(own)) return own;
  return hasBinding(config) ? config : undefined;
}

/**
 * The tier → target map a config binds. A tier the config does not bind is
 * absent (the next layer answers it). Targets carry the key: server-only.
 */
export function inferenceProviderTargets(
  config: InferenceProviderConfig | undefined,
): Partial<Record<InferenceTier, InferenceTarget>> {
  const targets: Partial<Record<InferenceTier, InferenceTarget>> = {};
  if (!config) return targets;
  for (const tier of INFERENCE_TIERS) {
    const binding = inferenceProviderBindingFor(config, tier);
    if (binding) targets[tier] = bindingToTarget(config, binding);
  }
  return targets;
}

function redactBinding(
  binding: InferenceProviderBinding,
): RedactedInferenceProviderBinding {
  // Copy known non-secret fields only: nothing unexpected in a stored row
  // (legacy or hand-written) can reach the settings view.
  const params = safeParams(binding.params);
  return {
    ...(binding.provider ? { provider: binding.provider } : {}),
    ...(binding.preset ? { preset: binding.preset } : {}),
    ...(binding.baseUrl ? { baseUrl: binding.baseUrl } : {}),
    ...(binding.model ? { model: binding.model } : {}),
    ...(params ? { params } : {}),
    hasApiKey: !!binding.apiKey && binding.apiKey !== KEYLESS_PLACEHOLDER,
  };
}

/** The config without any key: the shape a settings panel reads. */
export function redactInferenceProviderConfig(
  config: InferenceProviderConfig,
): RedactedInferenceProviderConfig {
  const { tiers, version, source, mode, gatewayKeyAlias, ...binding } = config;
  const redacted: RedactedInferenceProviderConfig = {
    ...redactBinding(binding),
    ...(version ? { version } : {}),
    ...(source ? { source } : {}),
    ...(mode ? { mode } : {}),
    ...(gatewayKeyAlias ? { gatewayKeyAlias } : {}),
  };
  if (tiers) {
    redacted.tiers = {};
    for (const [tier, value] of Object.entries(tiers)) {
      if (value) redacted.tiers[tier as InferenceTier] = redactBinding(value);
    }
  }
  return redacted;
}

/** A target without its key (`hasApiKey` says whether one is bound). */
export function redactInferenceTarget(
  target: InferenceTarget,
): Omit<InferenceTarget, 'apiKey'> & { hasApiKey: boolean } {
  const params = safeParams(target.params);
  return {
    ...(target.provider ? { provider: target.provider } : {}),
    ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    ...(target.model ? { model: target.model } : {}),
    ...(target.latency ? { latency: target.latency } : {}),
    ...(target.source ? { source: target.source } : {}),
    ...(params ? { params } : {}),
    ...(target.usageTags ? { usageTags: { ...target.usageTags } } : {}),
    hasApiKey: !!target.apiKey && target.apiKey !== KEYLESS_PLACEHOLDER,
  };
}

/**
 * The secret name for a scope: user configs are user-qualified, the tenant
 * config is one name; both live under `context = tenantId`.
 */
export function inferenceProviderConfigSecretName(scope: {
  userId?: string | null;
}): string {
  const userId = text(scope.userId);
  return userId
    ? `${INFERENCE_PROVIDER_CONFIG_SECRET_TYPE}:user:${userId}`
    : `${INFERENCE_PROVIDER_CONFIG_SECRET_TYPE}:tenant`;
}
