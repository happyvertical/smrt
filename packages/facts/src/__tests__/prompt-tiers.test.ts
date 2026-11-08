/**
 * Inference tiers declared by smrt-facts prompts (#4755). Pins the resolved tag
 * set only; with no `inference` config every tier runs on the configured
 * client (#4750).
 */
import {
  clearPromptCache,
  promptMessageOptions,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import { beforeEach, describe, expect, it } from 'vitest';
import '../prompts.js';

const TIERS = {
  'smrtFacts.extractCandidates': 'great',
  'smrtFacts.reconcile': 'great',
  'smrtFacts.extractArticleClaims': 'great',
  'smrtFacts.assessClaimSupport': 'cheap',
} as const;

describe('smrt-facts prompt tiers', () => {
  beforeEach(() => clearPromptCache());

  it.each(Object.entries(TIERS))('%s declares %s', async (key, tier) => {
    const { ai } = await resolvePrompt(key, { tenantId: null });
    expect(ai.tier).toBe(tier);
    expect(promptMessageOptions(ai)).toMatchObject({ tier, promptKey: key });
  });
});
