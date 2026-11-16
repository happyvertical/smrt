import { describe, expect, it } from 'vitest';
import {
  CHAT_ASSISTANT_PROMPT_KEY,
  resolveChatAssistantPrompt,
  resolveChatAssistantTier,
} from './turn-tracking.js';

describe('the chat assistant prompt tier (#5005)', () => {
  it('declares the best tier itself', async () => {
    const prompt = await resolveChatAssistantPrompt({ tenantId: null });
    expect(prompt.ai.usageTags.promptKey).toBe(CHAT_ASSISTANT_PROMPT_KEY);
    expect(prompt.ai.tier).toBe('best');
  });

  it('reads the tier a host binds the turn at from the prompt', async () => {
    await expect(resolveChatAssistantTier({ tenantId: null })).resolves.toBe(
      'best',
    );
  });
});
