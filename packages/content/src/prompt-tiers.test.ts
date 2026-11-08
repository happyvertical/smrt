/**
 * Inference tiers declared by smrt-content prompts (#4755). Pins the resolved
 * tag set only; with no `inference` config every tier runs on the configured
 * client (#4750). The editor session prompt (a system prompt, no call) and the
 * thumbnail prompt (image generation) declare no tier.
 */
import {
  clearPromptCache,
  promptMessageOptions,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import { beforeEach, describe, expect, it } from 'vitest';
import './content-chat-prompts.js';
import './content-prompts.js';

const TIERS = {
  'smrtContent.review': { tier: 'great' },
  'smrtContent.applyCorrection': { tier: 'great' },
  'content.chat.contentEditorInteraction': {
    tier: 'great',
    latency: 'interactive',
  },
} as const;

const UNTIERED = [
  'content.chat.contentEditorSession',
  'smrtContent.thumbnail.aiGenerate',
];

describe('smrt-content prompt tiers', () => {
  beforeEach(() => clearPromptCache());

  it.each(Object.entries(TIERS))('%s declares %o', async (key, expected) => {
    const { ai } = await resolvePrompt(key, { tenantId: null });
    expect(ai.tier).toBe(expected.tier);
    expect(ai.latency).toBe(
      'latency' in expected ? expected.latency : undefined,
    );
    expect(promptMessageOptions(ai)).toMatchObject({
      ...expected,
      promptKey: key,
    });
  });

  it.each(UNTIERED)('%s declares no tier', async (key) => {
    const { ai } = await resolvePrompt(key, { tenantId: null });
    expect(ai.tier).toBeUndefined();
  });
});
