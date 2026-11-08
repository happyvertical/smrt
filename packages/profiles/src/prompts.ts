/**
 * Prompt registrations for the @happyvertical/smrt-profiles package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-content` (see
 * `content-prompts.ts`) and `@happyvertical/smrt-facts` (see `prompts.ts`).
 */

import { definePrompt } from '@happyvertical/smrt-prompts';

// Bio generation only uses non-PII profile fields (name + description).
// Email is intentionally NOT passed to the AI provider — see review on PR
// #1209 — to minimize PII exposure. If a downstream tenant needs email in
// the bio, they can override the template via PromptOverride.
export const smrtProfilesGenerateBioPrompt = definePrompt({
  key: 'smrtProfiles.profile.generateBio',
  template: `Write a short, professional bio for this person.

Profile name: {profileName}
Profile description: {profileDescription}

Return only the bio text, with no commentary or surrounding quotation marks.`,
  ai: { profile: 'good' },
  editable: {
    template: true,
    profile: true,
    model: true,
    params: true,
  },
});

/**
 * Canonical helper lives in `@happyvertical/smrt-prompts` (#4751): it also
 * forwards the resolution's `usageTags` (`promptKey`, `promptLayer`,
 * `templateHash`). Re-exported here for existing importers.
 */
export { promptMessageOptions } from '@happyvertical/smrt-prompts';
