import type { SmrtClassOptions } from '@happyvertical/smrt-core';

export type PromptParams = Record<string, unknown>;

export interface PromptEditableConfig {
  template: boolean;
  profile: boolean;
  model: boolean;
  params: boolean;
}

export interface PromptAIInput {
  profile?: string | null;
  model?: string | null;
  params?: PromptParams | null;
  temperature?: number;
  maxTokens?: number;
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
  ai: NormalizedPromptAI;
}
