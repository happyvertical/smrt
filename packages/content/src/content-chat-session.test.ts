import { describe, expect, it } from 'vitest';
import { inferProviderFromModel } from './content-chat-session';

describe('content chat session helpers', () => {
  it('honors provider-prefixed model ids before keyword inference', () => {
    expect(inferProviderFromModel('openrouter/anthropic/sonnet-4')).toBe(
      'openrouter',
    );
    expect(inferProviderFromModel('anthropic/sonnet-4')).toBe('anthropic');
    expect(inferProviderFromModel('google/gemini-2.5-pro')).toBe('gemini');
  });

  it('uses whole-token model family inference for unprefixed model ids', () => {
    expect(inferProviderFromModel('claude-3-5-haiku-latest')).toBe('anthropic');
    expect(inferProviderFromModel('gemini-2.5-flash')).toBe('gemini');
    expect(inferProviderFromModel('notahaiku-model')).toBe('openai');
  });
});
