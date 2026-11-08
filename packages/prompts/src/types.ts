import type {
  InferenceLatency,
  InferenceTier,
  InferenceTierRequest,
  SmrtClassOptions,
} from '@happyvertical/smrt-core';

export type PromptParams = Record<string, unknown>;

export interface PromptEditableConfig {
  template: boolean;
  profile: boolean;
  model: boolean;
  params: boolean;
}

export interface PromptAIInput {
  /**
   * A configured profile name or an inference tier (`cheap`…`best`, `auto`;
   * #4750). Framework prompts declare a tier by the #4755 sweep rule.
   */
  profile?: string | null;
  /**
   * Latency hint for a tier binding (`interactive` on request paths,
   * `background` for jobs; #4755). Declared by the code default only: it is
   * a property of the call site, so config and overrides cannot change it.
   */
  latency?: InferenceLatency;
  model?: string | null;
  params?: PromptParams | null;
  temperature?: number;
  maxTokens?: number;
  /**
   * Lowest tier a tier-profile prompt may degrade to when its tier's chain
   * fails (#4752). Code default only: config and stored overrides cannot
   * lower it.
   */
  minimumTier?: InferenceTier;
  [key: string]: unknown;
}

export interface PromptDefinitionInput {
  key: string;
  template: string;
  /** Human-readable description shown by a management screen; defaults to `''`. */
  description?: string;
  ai?: PromptAIInput;
  editable?: Partial<PromptEditableConfig>;
}

export interface PromptDefinition {
  key: string;
  template: string;
  description: string;
  ai: NormalizedPromptAI;
  editable: PromptEditableConfig;
}

/**
 * The two scopes a stored {@link PromptOverride} row may target: the
 * app-wide default (`tenantId` is `null`) or one tenant.
 */
export type PromptOverrideScopeType = 'app' | 'tenant';

/**
 * Canonical scope id for the app-wide override scope, mirroring
 * `GLOBAL_FEATURE_SCOPE_ID` in `@happyvertical/smrt-features` (#3013). The
 * resolver and the write-authorization path both key off this exact value —
 * `PromptOverride` itself stores the app scope as `tenantId: null`, not this
 * string, so this constant only ever appears at the scope-request boundary
 * (`PromptOverrideService`, `PromptSettingsService`).
 */
export const APP_PROMPT_SCOPE_ID = '__app__';

export interface PromptProfileConfig {
  provider: string;
  model: string;
  params?: PromptParams | null;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PromptConfigOverrideInput {
  template?: string | null;
  profile?: string | null;
  model?: string | null;
  params?: PromptParams | null;
  ai?: PromptAIInput | null;
  temperature?: number;
  maxTokens?: number;
  [key: string]: unknown;
}

export interface PromptPackageConfig {
  profiles?: Record<string, PromptProfileConfig>;
  prompts?: Record<string, PromptConfigOverrideInput>;
  allowedProfileNames?: string[];
  allowedModels?: string[];
  [key: string]: unknown;
}

export interface PromptLayer {
  template?: string | null;
  profile?: string | null;
  model?: string | null;
  params?: PromptParams | null;
}

export interface NormalizedPromptAI {
  profile?: string;
  model?: string;
  /** Code-declared latency hint; only a registered definition carries it. */
  latency?: InferenceLatency;
  /** From the code default only (#4752). */
  minimumTier?: InferenceTier;
  params: PromptParams;
}

/**
 * The resolution layer that supplied a prompt's effective template, lowest to
 * highest priority. Recorded on every AI call as the `promptLayer` usage tag.
 */
export type PromptSourceLayer =
  | 'default'
  | 'config'
  | 'app'
  | 'tenant'
  | 'runtime';

/**
 * Usage tags `resolvePrompt()` attaches to a resolution. They reach
 * `_smrt_ai_usage` through the AI SDK's per-call `usageTags`; `promptKey` is
 * also lifted into the indexed `prompt_key` column (#4751).
 */
export interface PromptUsageTags {
  /** The registered prompt key, e.g. `content.summarize.headline`. */
  promptKey: string;
  /** The highest layer that supplied the effective template. */
  promptLayer: PromptSourceLayer;
  /** First 12 hex chars of the SHA-256 of the effective (unrendered) template. */
  templateHash: string;
  [key: string]: string;
}

export interface ResolvedPromptAI extends PromptParams {
  /**
   * Prompt-run observability tags (#4751). Always set by `resolvePrompt()`;
   * optional here so hand-built AI option objects stay assignable.
   */
  usageTags?: PromptUsageTags;
  profile?: string;
  provider?: string;
  model?: string;
  /**
   * Set when the effective profile is an inference tier name (or `auto`) with
   * no same-named entry in `PromptPackageConfig.profiles` (#4750). The tier
   * binds at call time through the core seam: forward `tier` and `promptKey`
   * to object AI operations (`prepareAiOperation()`), which pick the tier
   * client. `provider`/`model` stay unset unless the prompt names a model.
   */
  tier?: InferenceTierRequest;
  /** The prompt key, set with `tier` for the call-time resolver request. */
  promptKey?: string;
  /** Set with `tier`: the code default's latency hint (#4755). */
  latency?: InferenceLatency;
  /** The definition's `ai.minimumTier`, set with `tier` (#4752). */
  minimumTier?: InferenceTier;
  allowedModels?: string[];
  params: PromptParams;
  temperature?: number;
  maxTokens?: number;
}

export interface ResolvedPrompt {
  key: string;
  template: string;
  text: string;
  ai: ResolvedPromptAI & { usageTags: PromptUsageTags };
}

export interface ResolvePromptOptions {
  db?: SmrtClassOptions['db'];
  tenantId?: string | null;
  variables?: Record<string, unknown>;
  override?: PromptConfigOverrideInput;
}

export interface PromptCacheValue {
  key: string;
  template: string;
  /** The highest stored/config layer that supplied `template`. */
  templateLayer: Exclude<PromptSourceLayer, 'runtime'>;
  /**
   * The highest stored/config layer that supplied `ai.profile`. Only a
   * profile the code default supplied is exempt from `allowedProfileNames`
   * (#4755).
   */
  profileLayer: Exclude<PromptSourceLayer, 'runtime'>;
  ai: NormalizedPromptAI;
}
