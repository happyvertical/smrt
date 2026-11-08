/**
 * Prompt registrations for the @happyvertical/smrt-images package.
 *
 * Prompts are registered at module-load time via `definePrompt()` so that
 * tenant-aware overrides can be applied at call time via `resolvePrompt()`.
 *
 * Mirrors the pattern used by `@happyvertical/smrt-profiles` (see
 * `prompts.ts`) and `@happyvertical/smrt-properties` (see `prompts.ts`).
 */

import { definePrompt } from '@happyvertical/smrt-prompts';

// Alt text generation only uses non-PII metadata describing the image
// itself (name and description). Source URIs, internal foreign-key
// fields (e.g. sourceAssetId), and the extensible `metadata` blob are
// intentionally NOT passed to the AI provider — source URIs may embed
// signed/private bucket paths, and metadata may contain EXIF GPS data
// or tenant-private configuration. If a downstream tenant needs richer
// context they can override the template via PromptOverride.
export const smrtImagesGenerateAltTextPrompt = definePrompt({
  key: 'smrtImages.image.generateAltText',
  template: `Generate concise accessibility alt text for this image.
Consider: subject matter, key visual elements, context.
Keep it under 125 characters for screen reader compatibility.

Image name: {imageName}
Image description: {imageDescription}

Return only the alt text, with no commentary or surrounding quotation marks.`,
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
