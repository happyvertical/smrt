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
import type { DecisionRequest, DecisionResult } from './decisions.js';
import {
  type InferenceMode,
  type InferenceUnavailableReason,
  isInferenceMode,
  isInferenceUnavailableReason,
} from './inference-availability.js';
import type { InferenceCapabilities } from './inference-capabilities.js';
import { SmrtError } from './smrt-error.js';

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
 * Target shapes. `single` (the default when `kind` is omitted) is one
 * provider and model. `alias` names an entry of `inference.aliases`, and
 * `candidates` is an inline ordered chain; both are run by the registered
 * {@link InferenceExecutor} (`@happyvertical/smrt-inference`, #4752).
 * `fusion` names a consumer-defined fusion (#4753) run by the same executor.
 */
export type InferenceTargetKind = 'single' | 'alias' | 'candidates' | 'fusion';

/**
 * Fusion modes (#4753). Modes are code, fusions are config: v1 ships exactly
 * these three, each with a fixed, documented number of model calls.
 *
 * - `single`: one seat (1 call).
 * - `pair`: the first two seats in parallel, then the third seat merges both
 *   outputs, labelled by seat and model (3 calls).
 * - `handoff`: the first seat drafts, the second receives the draft and
 *   answers (2 calls).
 */
export const INFERENCE_FUSION_MODES = ['single', 'pair', 'handoff'] as const;

export type InferenceFusionMode = (typeof INFERENCE_FUSION_MODES)[number];

/** One seat of a fusion: a registered prompt key run on a target. */
export interface InferenceFusionSeat {
  /**
   * Seat name, recorded as the `seat` usage tag and the run record's persona.
   * Default: the prompt key. Unique within a fusion.
   */
  name?: string;
  /**
   * A prompt key registered with smrt-prompts `definePrompt()`. Its resolved
   * template (code default, config, app and tenant overrides) is the seat's
   * instructions, so tenant overrides of a seat need no new mechanism.
   */
  prompt: string;
  /**
   * A tier name (resolved through the same resolver, so per-user bindings
   * apply), or a target: `{ alias }`, `{ candidates }` or an inline
   * `{ provider, model }`. Never another fusion.
   */
  target: InferenceTierRequest | InferenceTarget;
  temperature?: number;
  /** `json` asks for a JSON object and parses it; default `text`. */
  output?: 'text' | 'json';
}

/**
 * A decision gate (#4753) evaluated through the instance's typed-decision
 * client (the `evaluate()` path). When the answer is `sufficientWhen.choice`
 * with at least `minConfidence`, the remaining stage is skipped and recorded
 * as `skipped`.
 */
export interface InferenceFusionGate {
  /** What the outputs so far must satisfy for the remaining stage to be skipped. */
  criteria: string;
  sufficientWhen: { choice: string; minConfidence: number };
}

/** A consumer-defined fusion (`inference.fusions.<key>` or `defineFusion()`). */
export interface InferenceFusionDefinition {
  mode: InferenceFusionMode;
  seats: InferenceFusionSeat[];
  /** `pair` and `handoff` only. */
  gate?: InferenceFusionGate;
  description?: string;
}

/**
 * One entry of an ordered fallback chain (#4752).
 *
 * A candidate is exactly one of: a provider and model (`provider`, `model`,
 * optional `baseUrl` with `apiKeyEnv` or `apiKey`), a #4674 preset with a
 * model (`preset`, `model`, optional `apiKeyEnv`), or a nested alias
 * reference (`alias`), expanded in place. Keys are read from the environment
 * variable named by `apiKeyEnv` at call time and never logged or tagged; a
 * key travels only with its own `baseUrl` (the pair rule on
 * {@link InferenceTarget.apiKey}).
 */
export interface InferenceCandidate {
  /** Provider name (`openai`, `anthropic`, ...). */
  provider?: string;
  /** Model id. */
  model?: string;
  /** Provider base URL; required with `apiKeyEnv` / `apiKey`. */
  baseUrl?: string;
  /** Environment variable holding this candidate's key. */
  apiKeyEnv?: string;
  /** Literal key (resolvers only; never put keys in config files). */
  apiKey?: string;
  /** A #4674 preset id (`openrouter`, `lemonade`, `llama.cpp`, `lm-studio`). */
  preset?: string;
  /** Another alias, expanded in place. */
  alias?: string;
  /** Per-call defaults for this candidate; caller options win. */
  params?: Record<string, unknown>;
}

/** `inference.aliases.<name>`: a version-free name for an ordered chain. */
export interface InferenceAlias {
  /** Tried in order; the first that answers wins. */
  candidates: InferenceCandidate[];
  /** Free text for settings screens and `smrt doctor --ai`. */
  description?: string;
}

/**
 * A tier's binding target.
 *
 * The default `single` kind is an `AIConfig`-shaped target: every field is
 * optional, and a field that is absent inherits from the instance's
 * configured AI client. An empty target means "the configured client".
 *
 * Extension point: `kind` selects the shape. `alias` (`{ alias }`) and
 * `candidates` (`{ candidates }`) are chains run by the registered
 * {@link InferenceExecutor} (#4752); a later child adds `fusion`. A target
 * with `alias` or `candidates` and no `kind` is read as that kind (see
 * {@link inferenceTargetKind}). Code that consumes a target must ignore
 * members it does not understand rather than reject them.
 */
export interface InferenceTarget {
  /** Target shape; see {@link inferenceTargetKind} for the default. */
  kind?: InferenceTargetKind;
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
  /** `kind: 'alias'`: the `inference.aliases` entry to run. */
  alias?: string;
  /** `kind: 'candidates'`: an inline ordered chain. */
  candidates?: InferenceCandidate[];
  /** `kind: 'fusion'`: the fusion key to run (#4753). */
  fusion?: string;
  /**
   * Where the binding came from, for usage visibility (#4756): a user's own
   * key (`byo`), a local server (`local`), managed inference (`hosted`), or
   * the app's configuration (`app`). Recorded as the `source` usage tag;
   * never part of the client identity.
   */
  source?: InferenceTargetSource;
  /**
   * Non-secret tags the binding adds to every usage row it answers, such as
   * hosted inference's `gatewayKeyAlias` (#4759). Never identity, never a
   * credential; the tier keys (`tierRequested`, `tierResolved`, `source`)
   * always win over a same-named entry.
   */
  usageTags?: Record<string, string>;
}

/** Binding origins recorded as the `source` usage tag (#4756). */
export const INFERENCE_TARGET_SOURCES = [
  'byo',
  'local',
  'hosted',
  'app',
] as const;

/** One of {@link INFERENCE_TARGET_SOURCES}. */
export type InferenceTargetSource = (typeof INFERENCE_TARGET_SOURCES)[number];

/** True for a known {@link InferenceTargetSource}. */
export function isInferenceTargetSource(
  value: unknown,
): value is InferenceTargetSource {
  return (
    typeof value === 'string' &&
    (INFERENCE_TARGET_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * The effective kind of a target: its `kind`, else `alias` when it names an
 * alias, else `candidates` when it carries a list, else `single`. Unknown
 * kinds from later children are returned as written.
 */
export function inferenceTargetKind(
  target: InferenceTarget | undefined | null,
): string {
  if (!target || typeof target !== 'object') return 'single';
  const kind: unknown = target.kind;
  if (typeof kind === 'string' && kind !== '') return kind;
  if (typeof target.alias === 'string') return 'alias';
  if (Array.isArray(target.candidates)) return 'candidates';
  if (typeof target.fusion === 'string') return 'fusion';
  return 'single';
}

/** `SmrtConfig.inference`: the app's tier bindings. */
export interface InferenceConfig {
  /** The tier `auto` resolves to. Default `good`. */
  defaultTier?: InferenceTier;
  /** Tier bindings. A tier without a binding uses the configured client. */
  tiers?: Partial<Record<InferenceTier, InferenceTarget>>;
  /**
   * Named ordered chains a tier (or a candidate) can reference by name
   * (#4752). Each alias is replaced whole by the highest layer defining it.
   */
  aliases?: Record<string, InferenceAlias>;
  /**
   * Walk down the tier ladder when every candidate of a chain tier fails
   * (#4752). Default `true`; a call's `minimumTier` stops the walk.
   */
  degrade?: boolean;
  /**
   * Consumer-defined fusions by key (#4753), app-level only. Each fusion is
   * replaced whole by the highest layer defining it. SMRT ships none.
   */
  fusions?: Record<string, InferenceFusionDefinition>;
  /**
   * Opt-in AI call transcripts (#4780), app-level only: read from the
   * process config (smrt.config < `config()` < `SMRT_INFERENCE_TRANSCRIPTS`),
   * never from instance options, resolvers or tenant settings. Off by default.
   */
  transcripts?: InferenceTranscriptsConfig;
}

/** Per-prompt transcript sampling override (#4780). */
export interface InferenceTranscriptPromptConfig {
  /** Capture rate for successful calls of this prompt key, 0..1. */
  sample?: number;
}

/**
 * Transcript capture config (#4780). Scalars take the highest layer that sets
 * them; `prompts` entries are replaced whole per key.
 */
export interface InferenceTranscriptsConfig {
  /** Store transcripts at all. Default `false`. */
  enabled?: boolean;
  /**
   * Capture rate for successful calls, drawn per call, 0..1. Default `0.1`.
   * Failed calls, calls with substitutions, degraded or failed fusion runs
   * and calls passing `transcript: true` are always captured.
   */
  sample?: number;
  /** Per-row byte cap over request + response + tool events. Default 65536. */
  maxBytes?: number;
  /** Sampling overrides by prompt key. */
  prompts?: Record<string, InferenceTranscriptPromptConfig>;
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
  /**
   * What the bound model can do (#4758). Core fills it when it binds a
   * `single` target for an object AI operation (see
   * `inference-capabilities.ts` for the resolution order); a resolver need
   * not set it. Absent for chain targets: the executor checks each
   * candidate instead.
   */
  capabilities?: InferenceCapabilities;
  /**
   * The principal's inference mode (#4757), when the resolver knows it (a
   * stored mode, or the answering binding's source). Absent: derived from
   * the target by {@link inferenceModeForTarget}.
   */
  mode?: InferenceMode;
  /**
   * Set when no call may run for this tier (`off`: the principal chose mode
   * `off`; `unconfigured`: an explicit mode with no binding of its kind;
   * `entitlement` / `capability` are reserved for #4760 / #4758). Core
   * throws `InferenceUnavailableError` before building any client, so
   * nothing runs and nothing is recorded. The target is ignored.
   */
  unavailable?: InferenceUnavailableReason;
}

/** Input to {@link InferenceResolver.mode}: a request without a tier. */
export type InferenceModeRequest = Omit<InferenceRequest, 'tier'>;

/** Output of {@link InferenceResolver.mode}. */
export interface InferenceModeState {
  mode: InferenceMode;
  /** Set when untiered calls must not run (in practice `off`). */
  unavailable?: InferenceUnavailableReason;
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
  /**
   * Optional (#4757): the principal's stored inference mode for calls that
   * name no tier. Untiered calls ask only this: `undefined` (no stored mode)
   * keeps the configured client without consulting {@link resolve};
   * `unavailable` throws `InferenceUnavailableError`; any other mode is the
   * principal's explicit choice and routes the call through `auto`, so it
   * runs on the chosen binding or reports `unconfigured`, never on the app's
   * configured client. Resolvers without it change nothing.
   */
  mode?(
    request: InferenceModeRequest,
  ): InferenceModeState | undefined | Promise<InferenceModeState | undefined>;
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
  // SMRT_INFERENCE_TRANSCRIPTS=1|true|on enables transcripts (#4780);
  // 0|false|off disables them over any config layer.
  const transcripts = readEnv('SMRT_INFERENCE_TRANSCRIPTS')?.toLowerCase();
  if (transcripts !== undefined) {
    if (['1', 'true', 'on', 'yes'].includes(transcripts)) {
      out.transcripts = { enabled: true };
    } else if (['0', 'false', 'off', 'no'].includes(transcripts)) {
      out.transcripts = { enabled: false };
    } else {
      throw new Error(
        `SMRT_INFERENCE_TRANSCRIPTS must be 1/true/on or 0/false/off; got "${transcripts}".`,
      );
    }
  }
  return out.defaultTier || out.tiers || out.transcripts ? out : undefined;
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
    if (record.degrade !== undefined) {
      merged.degrade = record.degrade as boolean;
    }
    const aliases = asRecord(record.aliases);
    if (aliases) {
      for (const [name, alias] of Object.entries(aliases)) {
        if (alias === undefined) continue;
        merged.aliases ??= {};
        merged.aliases[name] = alias as InferenceAlias;
      }
    }
    const fusions = asRecord(record.fusions);
    if (fusions) {
      for (const [name, fusion] of Object.entries(fusions)) {
        if (fusion === undefined) continue;
        merged.fusions ??= {};
        merged.fusions[name] = fusion as InferenceFusionDefinition;
      }
    }
    const transcripts = asRecord(record.transcripts);
    if (transcripts) {
      const next: InferenceTranscriptsConfig = {
        ...(merged.transcripts ?? {}),
      };
      for (const key of ['enabled', 'sample', 'maxBytes'] as const) {
        if (transcripts[key] !== undefined) {
          (next as Record<string, unknown>)[key] = transcripts[key];
        }
      }
      const prompts = asRecord(transcripts.prompts);
      if (prompts) {
        for (const [key, prompt] of Object.entries(prompts)) {
          if (prompt === undefined) continue;
          next.prompts = {
            ...(next.prompts ?? {}),
            [key]: prompt as InferenceTranscriptPromptConfig,
          };
        }
      }
      merged.transcripts = next;
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

/**
 * The process-level `inference.transcripts` block with an app settings layer
 * (#4781) between `config()` and the environment: smrt.config < `config()` <
 * `app` < `SMRT_INFERENCE_TRANSCRIPTS`. `app` is the operator's stored
 * app-level setting (smrt-inference's settings panel), never a tenant value;
 * the environment variable still wins over it.
 */
export function getInferenceTranscriptsConfig(
  app?: InferenceTranscriptsConfig | null,
): InferenceTranscriptsConfig | undefined {
  const project = getSmrtModuleConfig<Record<string, unknown>>('smrt', {})
    .inference as InferenceConfig | undefined;
  const global = globalSignalConfig.toJSON().inference;
  return mergeInferenceConfigs(
    project,
    global,
    app ? { transcripts: app } : undefined,
    inferenceConfigFromEnv(),
  )?.transcripts;
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
  if (value.degrade !== undefined && typeof value.degrade !== 'boolean') {
    throw new Error('inference.degrade must be a boolean.');
  }
  if (value.aliases !== undefined && !asRecord(value.aliases)) {
    throw new Error('inference.aliases must be an object of named chains.');
  }
  for (const [name, alias] of Object.entries(value.aliases ?? {})) {
    if (!asRecord(alias)) {
      throw new Error(`inference.aliases.${name} must be an object.`);
    }
  }
  if (value.fusions !== undefined && !asRecord(value.fusions)) {
    throw new Error('inference.fusions must be an object of named fusions.');
  }
  for (const [name, fusion] of Object.entries(value.fusions ?? {})) {
    if (!asRecord(fusion)) {
      throw new Error(`inference.fusions.${name} must be an object.`);
    }
  }
  assertInferenceTranscriptsConfig(value.transcripts);
}

function assertSampleRate(value: unknown, path: string): void {
  if (
    value !== undefined &&
    (typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1)
  ) {
    throw new Error(`${path} must be a number from 0 to 1.`);
  }
}

/** Minimum `inference.transcripts.maxBytes`: room for a truncation envelope. */
export const MIN_TRANSCRIPT_MAX_BYTES = 1024;

/** Validate `inference.transcripts` (#4780), failing loudly. */
export function assertInferenceTranscriptsConfig(value: unknown): void {
  if (value === undefined) return;
  const record = asRecord(value);
  if (!record) throw new Error('inference.transcripts must be an object.');
  if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
    throw new Error('inference.transcripts.enabled must be a boolean.');
  }
  assertSampleRate(record.sample, 'inference.transcripts.sample');
  if (
    record.maxBytes !== undefined &&
    (typeof record.maxBytes !== 'number' ||
      !Number.isSafeInteger(record.maxBytes) ||
      record.maxBytes < MIN_TRANSCRIPT_MAX_BYTES)
  ) {
    throw new Error(
      `inference.transcripts.maxBytes must be an integer of at least ${MIN_TRANSCRIPT_MAX_BYTES}.`,
    );
  }
  if (record.prompts !== undefined && !asRecord(record.prompts)) {
    throw new Error('inference.transcripts.prompts must be an object.');
  }
  for (const [key, prompt] of Object.entries(asRecord(record.prompts) ?? {})) {
    const entry = asRecord(prompt);
    if (!entry) {
      throw new Error(
        `inference.transcripts.prompts.${key} must be an object.`,
      );
    }
    assertSampleRate(
      entry.sample,
      `inference.transcripts.prompts.${key}.sample`,
    );
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
  if (record.mode !== undefined && !isInferenceMode(record.mode)) {
    throw new Error(
      `Inference resolver returned an unknown mode "${String(record.mode)}".`,
    );
  }
  if (
    record.unavailable !== undefined &&
    !isInferenceUnavailableReason(record.unavailable)
  ) {
    throw new Error(
      `Inference resolver returned an unknown unavailable reason "${String(record.unavailable)}".`,
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
    // A concrete tier request answered by another tier is a silent
    // substitution (#4749: degradation is reported). Resolvers bind; only the
    // executor degrades, and it records every step (#4752).
    throw new Error(
      `Inference resolver answered tier "${request.tier}" with "${resolved.tierResolved}"; a resolver must not substitute tiers.`,
    );
  }
  return resolved;
}

/**
 * The stored mode for an untiered call (#4757): the registered (or given)
 * resolver's optional `mode()`, else `undefined`. The built-in resolver has
 * none, so unconfigured apps never pay for this. Never calls a model.
 */
export async function resolveInferenceMode(
  request: InferenceModeRequest = {},
  options: Pick<ResolveInferenceOptions, 'resolver'> = {},
): Promise<InferenceModeState | undefined> {
  const resolver = options.resolver ?? getInferenceResolver();
  if (typeof resolver.mode !== 'function') return undefined;
  const state = await resolver.mode({ ...request });
  if (state === undefined || state === null) return undefined;
  if (!asRecord(state) || !isInferenceMode(state.mode)) {
    throw new Error(
      'Inference resolver returned an invalid mode; expected { mode, unavailable? }.',
    );
  }
  if (
    state.unavailable !== undefined &&
    !isInferenceUnavailableReason(state.unavailable)
  ) {
    throw new Error(
      `Inference resolver returned an unknown unavailable reason "${String(state.unavailable)}".`,
    );
  }
  return state;
}

function isLoopbackEndpoint(baseUrl: unknown): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '[::1]' ||
      host === '::1' ||
      /^127\.\d+\.\d+\.\d+$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * The mode a working binding reports (#4757): the resolution's own `mode`,
 * else the target's `source` (`byo`, `local`, `hosted`), else, for app
 * configuration and the configured client (`source: 'app'` or none),
 * `local` for Ollama or a loopback endpoint and `hosted` otherwise (the host
 * provides inference; `source` still says `app`). `fallback` is the
 * configured client's options, read when the target names no provider.
 */
export function inferenceModeForTarget(
  resolution: Pick<InferenceResolution, 'mode' | 'target'> | undefined,
  fallback?: Record<string, unknown>,
): Exclude<InferenceMode, 'off'> {
  if (resolution?.mode && resolution.mode !== 'off') return resolution.mode;
  const target = resolution?.target ?? {};
  const source = target.source;
  if (source === 'byo' || source === 'local' || source === 'hosted') {
    return source;
  }
  const named = typeof target.provider === 'string' && target.provider !== '';
  const provider = named ? target.provider : fallback?.provider;
  const baseUrl = named
    ? target.baseUrl
    : (target.baseUrl ?? fallback?.baseUrl);
  if (typeof provider === 'string' && provider.toLowerCase() === 'ollama') {
    return 'local';
  }
  return isLoopbackEndpoint(baseUrl) ? 'local' : 'hosted';
}

/**
 * `usageTags` recorded for a call through the tier path: the target's own
 * string `usageTags` (#4759), then the requested and resolved tier, plus the
 * binding's `source` when the target names one.
 */
export function inferenceUsageTags(
  tierRequested: InferenceTierRequest,
  resolution: InferenceResolution,
): Record<string, string> {
  const source = resolution.target?.source;
  const own = resolution.target?.usageTags;
  return {
    ...(own && typeof own === 'object'
      ? Object.fromEntries(
          Object.entries(own).filter(
            ([key, value]) => typeof value === 'string' && key !== '',
          ),
        )
      : {}),
    tierRequested,
    tierResolved: resolution.tierResolved,
    ...(isInferenceTargetSource(source) ? { source } : {}),
  };
}

/**
 * How an executor may degrade a call for a candidate that lacks a
 * capability (#4758), sent as the `capabilityFallback` call option. Core
 * sets it only on calls to executor-run targets; executors strip it before
 * a provider sees the options.
 *
 * - `json: 'text'`: drop `responseFormat` and let the caller parse text
 *   (core's `is()` / `evaluate()` text verdict, fusion seats' raw recovery).
 * - `tools: 'drop'`: run without `tools` (the caller marked them optional).
 *
 * Without a permitted fallback a missing capability is `missing-capability`
 * and the walk advances to the next candidate without calling the model.
 */
export interface InferenceCapabilityFallbackOption {
  json?: 'text';
  tools?: 'drop';
}

/** Per-call options a chain client receives (the `ai.message()` options). */
export type InferenceCallOptions = Record<string, unknown> & {
  usageTags?: Record<string, string>;
  capabilityFallback?: InferenceCapabilityFallbackOption;
};

/**
 * The client surface an {@link InferenceExecutor} drives and returns: the
 * subset of the AI SDK client it needs. Core passes real SDK clients in and
 * treats the executor's client as one.
 */
export interface InferenceModelClient {
  message(text: string, options?: InferenceCallOptions): Promise<string>;
  [method: string]: unknown;
}

/** A usage row recorded without a model call (a chain that never answered). */
export interface InferenceUsageRecord {
  provider?: string;
  model?: string;
  operation: string;
  /** Wall time spent on the attempts, in ms. */
  duration?: number;
  tags: Record<string, string>;
}

/**
 * A usage event observed for one run (#4753): the normalized event core
 * hands its usage handlers, minus everything but identity and totals.
 */
export interface InferenceUsageObservation {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost?: number;
  duration: number;
  tags: Record<string, string>;
}

/** Outcome of a multi-call run (`_smrt_ai_runs.status`). */
export type InferenceRunStatus = 'ok' | 'degraded' | 'failed';

/**
 * One multi-call run (a fusion, #4753) for `_smrt_ai_runs`. Core adds the
 * instance's tenant and class when it writes the row.
 */
export interface InferenceRunRecord {
  /** The run id every seat's usage row carries as its `runId` tag. */
  id: string;
  fusionKey: string;
  mode: string;
  /** The entry call's prompt key, when the caller sent one. */
  promptKey?: string;
  /** Seats that ran (skipped and never-reached seats excluded). */
  seats: number;
  /** Seats that died or answered through a substitution. */
  degradedSeats: number;
  status: InferenceRunStatus;
  /** Wall time of the run in ms. */
  duration: number;
  /** Per-seat persona, target, model, usage, substitutions; gate result. */
  details: Record<string, unknown>;
}

/** What core hands an {@link InferenceExecutor} for one call. */
export interface InferenceExecutionContext {
  /** The tier request as the caller made it. */
  request: InferenceRequest;
  /** The resolution whose target the executor runs. */
  resolution: InferenceResolution;
  /** The merged inference config (aliases, `degrade`). */
  config: InferenceConfig | undefined;
  /** Floor for ladder degradation (call option or prompt `ai.minimumTier`). */
  minimumTier?: InferenceTier;
  /** Return the text already streamed when a candidate fails mid-stream. */
  allowPartial?: boolean;
  /**
   * A client for one `single` target, built by core with its credential pair
   * rules and wired into the instance's usage pipeline.
   */
  clientFor(target: InferenceTarget): Promise<InferenceModelClient>;
  /**
   * Resolve another tier through the same seam (ladder degradation, fusion
   * seats). `promptKey` replaces the request's for a fusion seat's prompt.
   */
  resolveTier(
    tier: InferenceTier,
    overrides?: { promptKey?: string },
  ): Promise<InferenceResolution>;
  /**
   * Record a zero-token usage row through the instance's existing usage
   * pipeline: the row for a call whose every candidate failed.
   */
  recordUsage(record: InferenceUsageRecord): Promise<void>;
  /**
   * Capabilities of one `single` target (#4758), detected the way core
   * detects them for its own calls (the client's `getCapabilities()`, then
   * presets, then the model heuristic, then assumed). Builds the client;
   * never calls a model. Absent on older cores: treat every candidate as
   * capable.
   */
  capabilitiesFor?(target: InferenceTarget): Promise<InferenceCapabilities>;
  /**
   * The instance database, for executors that read stored state such as
   * app and tenant prompt overrides (fusion seats, #4753). Never written.
   */
  db?: unknown;
  /**
   * Ask the instance's typed-decision client (the `evaluate()` path, #3159)
   * one batch of questions, recording its usage with `usageTags`. Resolves
   * `undefined` when no decision client is configured. Used by fusion gates.
   */
  decide?(
    request: DecisionRequest,
    options?: { usageTags?: Record<string, string>; signal?: AbortSignal },
  ): Promise<DecisionResult | undefined>;
  /**
   * Persist a run record into `_smrt_ai_runs` when usage persistence is on;
   * a no-op otherwise. Never throws for a write failure (logged instead).
   */
  recordRun?(record: InferenceRunRecord): Promise<void>;
  /**
   * Observe the usage events whose `runId` tag is `runId` until the
   * returned function is called (per-seat usage in the run record).
   */
  observeUsage?(
    runId: string,
    listener: (event: InferenceUsageObservation) => void,
  ): () => void;
}

/**
 * Runs targets whose kind core does not (chains, later fusions). Registered
 * by `@happyvertical/smrt-inference` on import; core never imports it.
 */
export interface InferenceExecutor {
  /** Target kinds this executor runs. */
  readonly kinds: readonly string[];
  /** A client whose calls run the target in `context.resolution`. */
  createClient(context: InferenceExecutionContext): InferenceModelClient;
}

const EXECUTOR_KEY = Symbol.for('smrt.inference.executor');

type ExecutorHolder = { [EXECUTOR_KEY]?: InferenceExecutor };

/**
 * Register the process-wide executor for non-`single` target kinds, or pass
 * `undefined` to remove it. Stored on `globalThis` like the resolver.
 */
export function setInferenceExecutor(
  executor: InferenceExecutor | undefined,
): void {
  if (
    executor !== undefined &&
    (executor === null ||
      typeof (executor as Partial<InferenceExecutor>).createClient !==
        'function' ||
      !Array.isArray((executor as Partial<InferenceExecutor>).kinds))
  ) {
    throw new Error(
      'An inference executor must declare kinds and implement createClient().',
    );
  }
  const holder = globalThis as ExecutorHolder;
  if (executor === undefined) delete holder[EXECUTOR_KEY];
  else holder[EXECUTOR_KEY] = executor;
}

/** The registered executor, if any. */
export function getInferenceExecutor(): InferenceExecutor | undefined {
  return (globalThis as ExecutorHolder)[EXECUTOR_KEY];
}

/**
 * The executor for a target's kind. `single` targets return `undefined`
 * (core runs them); any other kind without a registered executor throws, so
 * a chain is never silently replaced by the configured client.
 */
export function inferenceExecutorFor(
  target: InferenceTarget,
): InferenceExecutor | undefined {
  const kind = inferenceTargetKind(target);
  if (kind === 'single') return undefined;
  const executor = getInferenceExecutor();
  if (!executor || !executor.kinds.includes(kind)) {
    throw new Error(
      `Inference target kind "${kind}" needs a registered executor; import @happyvertical/smrt-inference.`,
    );
  }
  return executor;
}

/** Code of {@link InferenceBindingError}. */
export const INFERENCE_TARGET_UNBOUND = 'INFERENCE_TARGET_UNBOUND';

/**
 * A tier target core refuses to bind before any request is sent: an unbound
 * endpoint/key pair, another provider while `HAVE_AI_*` is set, or an
 * injected client asked for a new endpoint. Typed so a chain executor can
 * classify it (as `credential`) without reading the message (#4752).
 */
export class InferenceBindingError extends SmrtError {
  constructor(message: string) {
    super(message, INFERENCE_TARGET_UNBOUND, 'configuration');
  }
}
