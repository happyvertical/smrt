/**
 * @happyvertical/smrt-prompts
 *
 * Code-first prompts with config overrides, stored app/tenant overrides,
 * and runtime resolution helpers for SMRT applications.
 *
 * @packageDocumentation
 */

export { clearPromptCache, getPromptCacheTtlMs } from './cache.js';
export { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
export {
  PromptOverride,
  type PromptOverrideOptions,
} from './models/PromptOverride.js';
export { definePrompt, PromptRegistry } from './prompt-registry.js';
export { resolvePrompt } from './prompt-resolver.js';
export type {
  NormalizedPromptAI,
  PromptAIInput,
  PromptConfigOverrideInput,
  PromptDefinition,
  PromptDefinitionInput,
  PromptEditableConfig,
  PromptLayer,
  PromptPackageConfig,
  PromptParams,
  PromptProfileConfig,
  ResolvedPrompt,
  ResolvedPromptAI,
  ResolvePromptOptions,
} from './types.js';

/** @internal */
export const PACKAGE_VERSION_INITIALIZED = true;
