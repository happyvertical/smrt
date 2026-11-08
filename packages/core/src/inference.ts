/**
 * Inference tiers and the binding resolver seam (#4750, epic #4749).
 *
 * Callers ask for a quality tier (`cheap < good < great < best`, or `auto`)
 * instead of a provider and model. A binding maps each tier to an
 * {@link InferenceTarget}. Core owns the vocabulary, the config block, and the
 * seam; behavior such as alias chains, fusions, and layered per-user/tenant
 * bindings is registered into the seam by a later package through
 * {@link setInferenceResolver}, so core never imports it.
 *
 * With no `inference` configuration and no registered resolver every tier
 * resolves to an empty target with `via: 'default'`, which `getAiClient(tier)`
 * maps to the instance's existing AI client. Unconfigured apps see no change.
 *
 * This module is browser-safe and imports nothing from `@happyvertical/ai`.
 */

import { getSmrtModuleConfig } from './config/global-config.js';
import { config as globalSignalConfig } from './config.js';

/** Ordered quality tiers, cheapest first. `fast` is deliberately not a tier. */
export const INFERENCE_TIERS = ['cheap', 'good', 'great', 'best'] as const;

/** One of the ordered quality tiers. */
export type InferenceTier = (typeof INFERENCE_TIERS)[number];

/** A tier request: a concrete tier, or `auto` to use the app default. */
export type InferenceTierRequest = InferenceTier | 'auto';

/**
 * Latency hint, independent of quality. A binding may honor it; core only
 * forwards it.
 */
export type InferenceLatency = 'interactive' | 'background';

/** The tier `auto` resolves to when no `inference.defaultTier` is configured. */
export const DEFAULT_INFERENCE_TIER: InferenceTier = 'good';

/**
 * A tier's binding target.
 *
 * v1 is a single `AIConfig`-shaped target: every field is optional, and a
 * field that is absent inherits from the instance's configured AI client. An
 * empty target means "the configured client".
 *
 * Extension point: later children of #4749 add alias chains (`alias`), ordered
 * fallback `candidates`, and consumer-defined `fusion` keys by extending this
 * interface with new optional members (selected by an optional `kind`
 * discriminator that defaults to `'single'`). Code that consumes a target must
 * therefore ignore members it does not understand rather than reject them.
 */
export interface InferenceTarget {
  /**
   * Target shape. Only `'single'` exists in v1 and it is the default when
   * omitted; later children add further kinds.
   */
  kind?: 'single';
  /** Provider name (`openai`, `anthropic`, ...). Absent: the configured one. */
  provider?: string;
  /** Model id. Absent: the provider's configured default model. */
  model?: string;
  /** Provider base URL, for OpenAI-compatible endpoints. */
  baseUrl?: string;
  /**
   * Credential for this target. Never logged or tagged. Endpoint and key
   * travel as an explicit pair and an unbound pair fails closed: a target
   * naming its own `baseUrl` must carry its own key (a placeholder such as
   * `'smrt-local'` for keyless local servers), and a target with its own key
   * must name its `baseUrl`. A target on another provider with neither uses
   * that provider's default endpoint and own key variable
   * (`OPENAI_API_KEY`, ...), and is refused while the SDK-wide
   * `HAVE_AI_BASE_URL` / `HAVE_AI_API_KEY` fallbacks are set.
   */
  apiKey?: string;
  /** Per-call defaults (temperature, maxTokens, ...); caller options win. */
  params?: Record<string, unknown>;
  /** The latency class this target serves, if the binding declares one. */
  latency?: InferenceLatency;
}

/** `SmrtConfig.inference`: the app's tier bindings. */
export interface InferenceConfig {
  /** The tier `auto` resolves to. Default `good`. */
  defaultTier?: InferenceTier;
  /** Tier bindings. A tier without a binding uses the configured client. */
  tiers?: Partial<Record<InferenceTier, InferenceTarget>>;
}

/** Input to an {@link InferenceResolver}. */
export interface InferenceRequest {
  tier: InferenceTierRequest;
  latency?: InferenceLatency;
  tenantId?: string | null;
  userId?: string | null;
  className?: string;
  promptKey?: string;
}

/** Where a binding came from. */
export type InferenceResolutionSource = 'default' | 'config' | 'resolver';

/** Output of an {@link InferenceResolver}. */
export interface InferenceResolution {
  /** The concrete tier that answers (`auto` is resolved). */
  tierResolved: InferenceTier;
  /** The target for that tier. An empty target means the configured client. */
  target: InferenceTarget;
  via: InferenceResolutionSource;
}

/** Context handed to a registered resolver. */
export interface InferenceResolverContext {
  /** The merged inference config (instance > env > `config()` > smrt.config). */
  config: InferenceConfig | undefined;
  /** The built-in config resolution, for resolvers that layer over it. */
  resolveFromConfig(request: InferenceRequest): InferenceResolution;
}

/**
 * Replaceable tier binding resolution.
 *
 * Return a resolution to bind the request, or `undefined` to defer to the
 * built-in config resolution. A resolver must not call a model to decide.
 *
 * The per-user resolver planned in #4666 should be implemented as an
 * `InferenceResolver` that returns a tier → target binding map (one
 * {@link InferenceTarget} per tier, selected here by `request.tier`), not as
 * a single `AIClientOptions` replacement for the configured client.
 */
export interface InferenceResolver {
  resolve(
    request: InferenceRequest,
    context: InferenceResolverContext,
  ): InferenceResolution | undefined | Promise<InferenceResolution | undefined>;
}

const RESOLVER_KEY = Symbol.for('smrt.inference.resolver');

type ResolverHolder = { [RESOLVER_KEY]?: InferenceResolver };

/**
 * Register the process-wide inference resolver. Pass `undefined` to restore
 * the built-in config resolution. Stored on `globalThis` so the registration
 * survives HMR and duplicate core copies, like the object registry.
 */
export function setInferenceResolver(
  resolver: InferenceResolver | undefined,
): void {
  if (
    resolver !== undefined &&
    (resolver === null ||
      typeof (resolver as Partial<InferenceResolver>).resolve !== 'function')
  ) {
    throw new Error('An inference resolver must implement resolve().');
  }
  const holder = globalThis as ResolverHolder;
  if (resolver === undefined) delete holder[RESOLVER_KEY];
  else holder[RESOLVER_KEY] = resolver;
}

/**
 * The active process-wide resolver: the registered one, or the built-in
 * resolver that reads the merged `inference` config.
 */
export function getInferenceResolver(): InferenceResolver {
  return (
    (globalThis as ResolverHolder)[RESOLVER_KEY] ?? builtInInferenceResolver
  );
}

/** Built-in resolution over the merged config; never calls a model. */
export const builtInInferenceResolver: InferenceResolver = {
  resolve: (request, context) => context.resolveFromConfig(request),
};

export function isInferenceTier(value: unknown): value is InferenceTier {
  return (
    typeof value === 'string' &&
    (INFERENCE_TIERS as readonly string[]).includes(value)
  );
}

export function isInferenceTierRequest(
  value: unknown,
): value is InferenceTierRequest {
  return value === 'auto' || isInferenceTier(value);
}

/** Negative when `a` is cheaper than `b`, zero when equal, positive above. */
export function compareInferenceTiers(
  a: InferenceTier,
  b: InferenceTier,
): number {
  return INFERENCE_TIERS.indexOf(a) - INFERENCE_TIERS.indexOf(b);
}

function assertTierRequest(
  value: unknown,
): asserts value is InferenceTierRequest {
  if (!isInferenceTierRequest(value)) {
    throw new Error(
      `Unknown inference tier "${String(value)}"; expected one of auto, ${INFERENCE_TIERS.join(', ')}.`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readEnv(name: string): string | undefined {
  const env =
    typeof process !== 'undefined' && process?.env ? process.env : undefined;
  const value = env?.[name];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * Environment layer: `SMRT_INFERENCE_DEFAULT_TIER` and, per tier,
 * `SMRT_INFERENCE_<TIER>_PROVIDER` / `SMRT_INFERENCE_<TIER>_MODEL`.
 */
function inferenceConfigFromEnv(): InferenceConfig | undefined {
  const out: InferenceConfig = {};
  const defaultTier = readEnv('SMRT_INFERENCE_DEFAULT_TIER');
  if (defaultTier) out.defaultTier = defaultTier as InferenceTier;
  for (const tier of INFERENCE_TIERS) {
    const upper = tier.toUpperCase();
    const provider = readEnv(`SMRT_INFERENCE_${upper}_PROVIDER`);
    const model = readEnv(`SMRT_INFERENCE_${upper}_MODEL`);
    if (provider || model) {
      out.tiers ??= {};
      out.tiers[tier] = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      };
    }
  }
  return out.defaultTier || out.tiers ? out : undefined;
}

/**
 * Merge inference config layers, lowest priority first. `defaultTier` takes
 * the highest layer that sets it; each tier's target is replaced whole by the
 * highest layer that binds it (targets are never field-merged across layers,
 * so a credential cannot leak to another layer's provider).
 */
export function mergeInferenceConfigs(
  ...layers: Array<InferenceConfig | undefined | null>
): InferenceConfig | undefined {
  let merged: InferenceConfig | undefined;
  for (const layer of layers) {
    const record = asRecord(layer);
    if (!record) continue;
    merged ??= {};
    if (record.defaultTier !== undefined) {
      merged.defaultTier = record.defaultTier as InferenceTier;
    }
    const tiers = asRecord(record.tiers);
    if (tiers) {
      for (const [tier, target] of Object.entries(tiers)) {
        if (target === undefined) continue;
        merged.tiers ??= {};
        merged.tiers[tier as InferenceTier] = target as InferenceTarget;
      }
    }
  }
  return merged;
}

/**
 * The process-level inference config: smrt.config `smrt.inference` <
 * `config({ inference })` < environment. Instance options layer on top in
 * `SmrtClass`.
 */
export function getInferenceConfig(): InferenceConfig | undefined {
  const project = getSmrtModuleConfig<Record<string, unknown>>('smrt', {})
    .inference as InferenceConfig | undefined;
  const global = globalSignalConfig.toJSON().inference;
  return mergeInferenceConfigs(project, global, inferenceConfigFromEnv());
}

/** Validate a config block, failing loudly on unknown tiers. */
export function assertInferenceConfig(
  value: InferenceConfig | undefined,
): void {
  if (!value) return;
  if (value.defaultTier !== undefined && !isInferenceTier(value.defaultTier)) {
    throw new Error(
      `inference.defaultTier must be one of ${INFERENCE_TIERS.join(', ')}; got "${String(value.defaultTier)}".`,
    );
  }
  for (const [tier, target] of Object.entries(value.tiers ?? {})) {
    if (!isInferenceTier(tier)) {
      throw new Error(
        `inference.tiers has unknown tier "${tier}"; expected ${INFERENCE_TIERS.join(', ')}.`,
      );
    }
    if (!asRecord(target)) {
      throw new Error(`inference.tiers.${tier} must be an object.`);
    }
  }
}

/** The tier `auto` resolves to under a config. */
export function resolveAutoTier(
  inference: InferenceConfig | undefined,
): InferenceTier {
  return inference?.defaultTier ?? DEFAULT_INFERENCE_TIER;
}

/**
 * Built-in resolution: `auto` becomes `defaultTier` (else `good`); a bound
 * tier returns its target with `via: 'config'`; an unbound tier returns an
 * empty target with `via: 'default'` (the configured client).
 */
export function resolveInferenceFromConfig(
  request: InferenceRequest,
  inference: InferenceConfig | undefined,
): InferenceResolution {
  assertTierRequest(request.tier);
  assertInferenceConfig(inference);
  const tierResolved =
    request.tier === 'auto' ? resolveAutoTier(inference) : request.tier;
  const bound = inference?.tiers?.[tierResolved];
  if (bound && Object.keys(bound).length > 0) {
    return { tierResolved, target: { ...bound }, via: 'config' };
  }
  return { tierResolved, target: {}, via: 'default' };
}

function assertResolution(
  value: unknown,
): asserts value is InferenceResolution {
  const record = asRecord(value);
  if (
    !record ||
    !isInferenceTier(record.tierResolved) ||
    !asRecord(record.target) ||
    (record.via !== 'default' &&
      record.via !== 'config' &&
      record.via !== 'resolver')
  ) {
    throw new Error(
      'Inference resolver returned an invalid resolution; expected { tierResolved, target, via }.',
    );
  }
}

/** Options for {@link resolveInference}. */
export interface ResolveInferenceOptions {
  /** Resolver to use instead of the process-wide one. */
  resolver?: InferenceResolver;
  /** Config to use instead of {@link getInferenceConfig}. */
  config?: InferenceConfig;
}

/**
 * Resolve a tier request through the seam: the given (or registered) resolver
 * first, then the built-in config resolution when it defers. Never calls a
 * model.
 */
export async function resolveInference(
  request: InferenceRequest,
  options: ResolveInferenceOptions = {},
): Promise<InferenceResolution> {
  assertTierRequest(request.tier);
  const inference = 'config' in options ? options.config : getInferenceConfig();
  const context: InferenceResolverContext = {
    config: inference,
    resolveFromConfig: (next) => resolveInferenceFromConfig(next, inference),
  };
  const resolver = options.resolver ?? getInferenceResolver();
  const resolved = await resolver.resolve({ ...request }, context);
  if (resolved === undefined) {
    return context.resolveFromConfig(request);
  }
  assertResolution(resolved);
  if (request.tier !== 'auto' && resolved.tierResolved !== request.tier) {
    // A concrete tier request answered by another tier is a substitution,
    // which v1 does not support silently (#4749: degradation is reported).
    throw new Error(
      `Inference resolver answered tier "${request.tier}" with "${resolved.tierResolved}"; substitutions are not supported in this version.`,
    );
  }
  return resolved;
}

/** `usageTags` recorded for a call through the tier path. */
export function inferenceUsageTags(
  tierRequested: InferenceTierRequest,
  resolution: InferenceResolution,
): Record<string, string> {
  return { tierRequested, tierResolved: resolution.tierResolved };
}
