/**
 * `trackedPromptCall()` (#5005): a resolved prompt becomes the input of
 * core's tracked client, so every tracked call carries the key and hash the
 * resolver produced.
 */
import { clearCache } from '@happyvertical/smrt-config';
import { createTrackedAiClient } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPromptCache } from './cache.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt } from './prompt-resolver.js';
import { trackedPromptCall } from './utils.js';

describe('trackedPromptCall (#5005)', () => {
  beforeEach(() => {
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
  });
  afterEach(() => {
    PromptRegistry.clear();
    clearPromptCache();
  });

  it('carries the key, template hash and tier of the resolution', async () => {
    definePrompt({
      key: 'test.tracked.tiered',
      template: 'Summarise {{text}}.',
      ai: { profile: 'good', latency: 'interactive' },
    });
    const resolved = await resolvePrompt('test.tracked.tiered', {
      variables: { text: 'x' },
    });
    const call = trackedPromptCall(resolved);
    expect(call).toMatchObject({
      promptKey: 'test.tracked.tiered',
      templateHash: resolved.ai.usageTags.templateHash,
      tier: 'good',
      latency: 'interactive',
    });
    expect(call.usageTags).toMatchObject({ promptLayer: 'default' });
    expect(call.usageTags).not.toHaveProperty('promptKey');
  });

  it('is what the tracked client accepts, and nothing without a key is', async () => {
    definePrompt({ key: 'test.tracked.plain', template: 'Hello.' });
    const resolved = await resolvePrompt('test.tracked.plain');
    const call = trackedPromptCall(resolved);
    expect(call.tier).toBeUndefined();
    expect(call.promptKey).toBe('test.tracked.plain');
    // The shape is core's: a client can be made from it.
    expect(typeof createTrackedAiClient).toBe('function');
  });
});
