/**
 * Prompt registrations for the @happyvertical/smrt-profiles package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-content` (see
 * `content-prompts.ts`) and `@happyvertical/smrt-facts` (see `prompts.ts`).
 */

import {
  definePrompt,
  type ResolvedPromptAI,
} from '@happyvertical/smrt-prompts';

export const smrtProfilesGenerateBioPrompt = definePrompt({
  key: 'smrtProfiles.profile.generateBio',
  template: `Write a short, professional bio for this person.

Profile name: {profileName}
Profile email: {profileEmail}
Profile description: {profileDescription}

Return only the bio text, with no commentary or surrounding quotation marks.`,
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
