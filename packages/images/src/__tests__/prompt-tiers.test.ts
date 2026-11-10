/**
 * Inference tiers declared by smrt-images prompts (#4755). Pins the resolved tag
 * set only; with no `inference` config every tier runs on the configured
 * client (#4750).
 */
import { clearPromptCache, resolvePrompt } from '@happyvertical/smrt-prompts';
import { beforeEach, describe, expect, it } from 'vitest';
import { promptMessageOptions } from '../prompts.js';

const TIERS = {
  'smrtImages.image.generateAltText': 'good',
} as const;

describe('smrt-images prompt tiers', () => {
  beforeEach(() => clearPromptCache());

  it.each(Object.entries(TIERS))('%s declares %s', async (key, tier) => {
    const { ai } = await resolvePrompt(key, { tenantId: null });
    expect(ai.tier).toBe(tier);
    expect(promptMessageOptions(ai)).toMatchObject({ tier, promptKey: key });
  });
});
