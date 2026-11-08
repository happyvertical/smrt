/**
 * Inference tier declared by the smrt-languages translation prompt (#4755).
 * Pins the resolved tag set only; with no `inference` config every tier runs
 * on the configured client (#4750).
 */
import {
  clearPromptCache,
  promptMessageOptions,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import { beforeEach, describe, expect, it } from 'vitest';
import { TRANSLATION_PROMPT_KEY } from './jobs/translation-job.js';

describe('smrt-languages prompt tiers', () => {
  beforeEach(() => clearPromptCache());

  it('the translation prompt declares good / background', async () => {
    const { ai } = await resolvePrompt(TRANSLATION_PROMPT_KEY, {
      tenantId: null,
    });
    expect(ai.tier).toBe('good');
    expect(ai.latency).toBe('background');
    expect(promptMessageOptions(ai)).toMatchObject({
      tier: 'good',
      latency: 'background',
      promptKey: TRANSLATION_PROMPT_KEY,
    });
  });
});
