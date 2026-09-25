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

export interface ResolvedPromptAI extends PromptParams {
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
  ai: ResolvedPromptAI;
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
  ai: NormalizedPromptAI;
}
