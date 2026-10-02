/**
 * Shared AI provider resolution (#3372).
 *
 * One resolver for every AI consumer. Default precedence, highest first, applied
 * per field (`provider`, `apiKey`, `baseUrl`, `model`):
 *
 * 1. `explicit` — values the caller passes in (for example `options.ai`).
 * 2. The `ai` block of `smrt.config.ts` (`apiKeyEnv` names the key variable).
 * 3. Environment variables, one prefix at a time, in `prefixes` order:
 *    `<PREFIX>_PROVIDER`, `<PREFIX>_API_KEY`, `<PREFIX>_BASE_URL`,
 *    `<PREFIX>_MODEL`. Default prefixes: `SMRT_AI`, then `HAVE_AI`.
 * 4. Provider-specific key variable for the *selected* provider only
 *    (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).
 * 5. Auto-detect: with no provider selected, the first provider whose key
 *    variable is set (openai, anthropic, gemini).
 *
 * `envOverridesConfig` swaps (2) and (3) for call sites that historically let
 * env win.
 *
 * Credential binding: a key or base URL is bound to the provider named by its
 * own source (explicit, the config block, or one env prefix). When a
 * higher-priority source selects a different provider, the lower source's key
 * and base URL are discarded, then the selected provider's own key variable is
 * used. A source that supplies a key but names no provider is generic and
 * binds to whichever provider is selected.
 *
 * Redaction: displayed base URLs expose only the origin. Secrets are never included in errors, `toJSON()` or `describe`.
 */
import type { AIConfigBlock } from './types.js';

/** Provider -> conventional API key variable. */
export const AI_PROVIDER_KEY_ENV: Readonly<Record<string, string>> =
  Object.freeze({
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    gemini: 'GEMINI_API_KEY',
  });

/** Auto-detection order. */
const AUTO_DETECT_ORDER = ['openai', 'anthropic', 'gemini'] as const;

/** Default env prefixes, highest priority first. */
export const DEFAULT_AI_ENV_PREFIXES: readonly string[] = Object.freeze([
  'SMRT_AI',
  'HAVE_AI',
]);

/** Conventional key variable for a provider name, if it has one. */
export function getDefaultAIKeyEnvName(
  provider: string | undefined | null,
): string | undefined {
  const normalized = nonEmpty(provider)?.toLowerCase();
  return normalized && Object.hasOwn(AI_PROVIDER_KEY_ENV, normalized)
    ? AI_PROVIDER_KEY_ENV[normalized]
    : undefined;
}

export type AIConfigField = 'provider' | 'apiKey' | 'baseUrl' | 'model';

/** Where a field came from. Names only; never values. */
export type AIConfigSource =
  | 'explicit'
  | 'config'
  | `env:${string}`
  | 'provider-key-env'
  | 'auto-detect';

export interface AIExplicitConfig {
  provider?: string;
  /** Alias of `provider` accepted for `AIClientOptions` compatibility. */
  type?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Alias of `model` accepted for `AIClientOptions` compatibility. */
  defaultModel?: string;
}

export interface ResolveAIProviderOptions {
  /** Caller-supplied values; highest priority. */
  explicit?: AIExplicitConfig | null;
  /**
   * The `smrt.config.ts` `ai` block. Omit to use the loaded config (via
   * `resolveConfiguredAIProvider`); pass `null` to ignore config entirely.
   */
  config?: AIConfigBlock | null;
  /** Environment to read. Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Env prefixes, highest priority first. Default `['SMRT_AI', 'HAVE_AI']`. */
  prefixes?: readonly string[];
  /** Auto-detect provider from well-known key variables. Default `true`. */
  autoDetect?: boolean;
  /** Let env prefixes beat the config block. Default `false`. */
  envOverridesConfig?: boolean;
  /**
   * Treat "no provider" as unconfigured even when an API key is present.
   * Default `true`; when `false`, a key alone is enough (`provider` stays
   * undefined and the provider layer applies its own default).
   */
  requireProvider?: boolean;
}

export interface ResolvedAIProviderConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Which source supplied each field (names only). */
  sources: Partial<Record<AIConfigField, AIConfigSource>>;
  /** Redacted view: safe to log or serialize. */
  toJSON(): Record<string, unknown>;
}

/** Options for `getAI` (from `@happyvertical/ai`). */
export interface AIProviderClientOptions {
  type?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

/** Thrown when no provider is configured. The message names variables only. */
export class AIProviderNotConfiguredError extends Error {
  readonly code = 'SMRT_AI_NOT_CONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'AIProviderNotConfiguredError';
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/**
 * Reduce a base URL to its origin (scheme, host, port) for display. Userinfo,
 * path, query and fragment can all carry credentials, so none are shown. The
 * real URL is still what is passed to the client.
 */
export function redactBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[unparseable-url]';
  }
}

interface Candidate {
  source: AIConfigSource;
  value: string | undefined;
}

export function tryResolveAIProviderConfig(
  options: ResolveAIProviderOptions = {},
): ResolvedAIProviderConfig | undefined {
  const env = options.env ?? process.env;
  const read = (name: string) => nonEmpty(env[name]);
  const prefixes = options.prefixes ?? DEFAULT_AI_ENV_PREFIXES;
  const explicit = options.explicit ?? {};
  const block = options.config ?? {};

  const fromEnv = (suffix: string): Candidate[] =>
    prefixes.map((prefix) => ({
      source: `env:${prefix}_${suffix}` as const,
      value: read(`${prefix}_${suffix}`),
    }));

  const explicitCand = (value: unknown): Candidate => ({
    source: 'explicit',
    value: nonEmpty(value),
  });
  const configCand = (value: unknown): Candidate => ({
    source: 'config',
    value: nonEmpty(value),
  });
  const layered = (
    exp: Candidate[],
    cfg: Candidate[],
    envs: Candidate[],
  ): Candidate[] =>
    options.envOverridesConfig
      ? [...exp, ...envs, ...cfg]
      : [...exp, ...cfg, ...envs];
  const first = (
    candidates: Candidate[],
  ): { value: string; source: AIConfigSource } | undefined => {
    for (const c of candidates) {
      if (c.value) return { value: c.value, source: c.source };
    }
    return undefined;
  };

  const sources: ResolvedAIProviderConfig['sources'] = {};
  const result: Partial<Record<AIConfigField, string>> = {};
  const set = (
    field: AIConfigField,
    hit: { value: string; source: AIConfigSource } | undefined,
  ) => {
    if (hit) {
      result[field] = hit.value;
      sources[field] = hit.source;
    }
  };

  set(
    'provider',
    first(
      layered(
        [explicitCand(explicit.provider ?? explicit.type)],
        [configCand(block.provider)],
        fromEnv('PROVIDER'),
      ),
    ),
  );
  set(
    'model',
    first(
      layered(
        [explicitCand(explicit.model ?? explicit.defaultModel)],
        [configCand(block.model)],
        fromEnv('MODEL'),
      ),
    ),
  );

  // Credentials (key, base URL) are bound to the provider of the source they
  // come from. A source that names a different provider than the one finally
  // selected is skipped, so one provider's secret or endpoint is never sent to
  // another. A source that supplies a credential but names no provider is
  // generic: it is bound to whichever provider is selected.
  const autoDetected =
    result.provider || options.autoDetect === false
      ? undefined
      : AUTO_DETECT_ORDER.find((p) => read(AI_PROVIDER_KEY_ENV[p]));
  if (autoDetected) {
    result.provider = autoDetected;
    sources.provider = 'auto-detect';
  }
  const selected = result.provider?.toLowerCase();

  interface CredentialGroup {
    source: AIConfigSource;
    provider?: string;
    apiKey?: string;
    baseUrl?: string;
  }
  const configKeyEnv = nonEmpty(block.apiKeyEnv);
  const explicitGroup: CredentialGroup = {
    source: 'explicit',
    provider: nonEmpty(explicit.provider ?? explicit.type),
    apiKey: nonEmpty(explicit.apiKey),
    baseUrl: nonEmpty(explicit.baseUrl),
  };
  const configGroup: CredentialGroup = {
    source: 'config',
    provider: nonEmpty(block.provider),
    apiKey:
      nonEmpty(block.apiKey) ?? (configKeyEnv ? read(configKeyEnv) : undefined),
    baseUrl: nonEmpty(block.baseUrl),
  };
  const envGroups: CredentialGroup[] = prefixes.map((prefix) => ({
    source: `env:${prefix}` as AIConfigSource,
    provider: read(`${prefix}_PROVIDER`),
    apiKey: read(`${prefix}_API_KEY`),
    baseUrl: read(`${prefix}_BASE_URL`),
  }));
  const groups = options.envOverridesConfig
    ? [explicitGroup, ...envGroups, configGroup]
    : [explicitGroup, configGroup, ...envGroups];
  const usable = (g: CredentialGroup) =>
    !g.provider || g.provider.toLowerCase() === selected;
  const sourceName = (
    g: CredentialGroup,
    suffix: 'API_KEY' | 'BASE_URL',
  ): AIConfigSource =>
    g.source.startsWith('env:')
      ? (`${g.source}_${suffix}` as AIConfigSource)
      : g.source;

  for (const g of groups) {
    if (!usable(g)) continue;
    if (g.baseUrl && !result.baseUrl) {
      result.baseUrl = g.baseUrl;
      sources.baseUrl = sourceName(g, 'BASE_URL');
    }
    if (g.apiKey && !result.apiKey) {
      result.apiKey = g.apiKey;
      sources.apiKey = sourceName(g, 'API_KEY');
    }
  }
  const providerKeyEnv = getDefaultAIKeyEnvName(result.provider);
  if (!result.apiKey && providerKeyEnv && read(providerKeyEnv)) {
    result.apiKey = read(providerKeyEnv);
    sources.apiKey = 'provider-key-env';
  }

  if (!result.provider && (options.requireProvider ?? true)) {
    return undefined;
  }
  if (!result.provider && !result.apiKey) {
    return undefined;
  }

  const resolved: ResolvedAIProviderConfig = {
    ...result,
    sources,
    toJSON: () => describeAIProviderConfig(resolved),
  };
  // Keep `toJSON` out of enumeration so spreads and Object.keys stay clean.
  Object.defineProperty(resolved, 'toJSON', { enumerable: false });
  return resolved;
}

/** Resolve or throw {@link AIProviderNotConfiguredError}. */
export function resolveAIProviderConfig(
  options: ResolveAIProviderOptions = {},
): ResolvedAIProviderConfig {
  const resolved = tryResolveAIProviderConfig(options);
  if (resolved) return resolved;
  const prefixes = options.prefixes ?? DEFAULT_AI_ENV_PREFIXES;
  const envNames = prefixes.map((p) => `${p}_PROVIDER`).join(', ');
  const keyNames = Object.values(AI_PROVIDER_KEY_ENV).join(', ');
  throw new AIProviderNotConfiguredError(
    'No AI provider is configured. Set the `ai` block in smrt.config.ts ' +
      `(provider, model, apiKeyEnv), or set ${envNames}` +
      (options.autoDetect === false
        ? '.'
        : `, or one of ${keyNames} to auto-detect the provider.`),
  );
}

/** Redacted description: presence flags and source names, never secrets. */
export function describeAIProviderConfig(
  resolved: Pick<
    ResolvedAIProviderConfig,
    'provider' | 'apiKey' | 'baseUrl' | 'model' | 'sources'
  >,
): Record<string, unknown> {
  return {
    provider: resolved.provider,
    model: resolved.model,
    baseUrl: redactBaseUrl(resolved.baseUrl),
    apiKey: resolved.apiKey ? '[redacted]' : undefined,
    sources: { ...resolved.sources },
  };
}

/** Convert a resolved config into `getAI()` options, omitting unset fields. */
export function toAIClientOptions(
  resolved: Pick<
    ResolvedAIProviderConfig,
    'provider' | 'apiKey' | 'baseUrl' | 'model'
  >,
): AIProviderClientOptions {
  const out: AIProviderClientOptions = {};
  if (resolved.provider) {
    out.type = resolved.provider;
    out.provider = resolved.provider;
  }
  if (resolved.apiKey) out.apiKey = resolved.apiKey;
  if (resolved.baseUrl) out.baseUrl = resolved.baseUrl;
  if (resolved.model) out.defaultModel = resolved.model;
  return out;
}
