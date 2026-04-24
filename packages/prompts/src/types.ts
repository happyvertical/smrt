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
  ai?: PromptAIInput;
  editable?: Partial<PromptEditableConfig>;
}

export interface PromptDefinition {
  key: string;
  template: string;
  ai: NormalizedPromptAI;
  editable: PromptEditableConfig;
}

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
