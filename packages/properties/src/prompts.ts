/**
 * Prompt registrations for the @happyvertical/smrt-properties package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-profiles` (see
 * `prompts.ts`) and `@happyvertical/smrt-content` (see `content-prompts.ts`).
 */

import {
  definePrompt,
  type ResolvedPromptAI,
} from '@happyvertical/smrt-prompts';

// Property summarization only uses non-PII property fields
// (name, domain, description, status) plus aggregate zone information.
// Internal/foreign-key fields like ownerId, repositoryId, tenantId, and the
// extensible `metadata` blob are intentionally NOT passed to the AI
// provider — they may link to identifying records or contain analytics IDs
// and other configuration secrets. If a downstream tenant needs richer
// context they can override the template via PromptOverride.
export const smrtPropertiesSummarizePrompt = definePrompt({
  key: 'smrtProperties.property.summarize',
  template: `Summarize this digital property:
Name: {propertyName}
Domain: {propertyDomain}
Description: {propertyDescription}
Status: {propertyStatus}
Total zones: {totalZones}
Top-level zones: {topLevelZones}`,
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

export function promptMessageOptions(ai: ResolvedPromptAI) {
  return {
    ...(ai.params || {}),
    ...(ai.model ? { model: ai.model } : {}),
    ...(typeof ai.temperature === 'number'
      ? { temperature: ai.temperature }
      : {}),
    ...(typeof ai.maxTokens === 'number' ? { maxTokens: ai.maxTokens } : {}),
  };
}
