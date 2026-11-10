// The non-secret `assistant` preference: engines (the ChatGPT one included)
// and the chosen ChatGPT model. It refuses anything else, so a token or key
// cannot be stored here.
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ENGINES,
  isAssistantEngine,
  validateAssistantPreferences,
} from './settings.ts';

describe('assistant preferences', () => {
  it('knows the ChatGPT engine alongside the others', () => {
    expect([...ASSISTANT_ENGINES]).toEqual([
      'api',
      'claude-code',
      'codex',
      'chatgpt',
    ]);
    expect(isAssistantEngine('chatgpt')).toBe(true);
    expect(isAssistantEngine('chatgpt-plan')).toBe(false);
    expect(isAssistantEngine('claude-cli')).toBe(false);
  });

  it('accepts an engine and a model id, nothing else', () => {
    expect(
      validateAssistantPreferences({
        engine: 'chatgpt',
        chatgptModel: 'gpt-5.1',
      }),
    ).toMatchObject({
      ok: true,
      canonical: { engine: 'chatgpt', chatgptModel: 'gpt-5.1' },
    });
    for (const bad of [
      { chatgptModel: 'has space' },
      { chatgptModel: 'x'.repeat(200) },
      { chatgptModel: 42 },
      { engine: 'claude-cli' },
      { accessToken: 'secret' },
      { apiKey: 'sk-secret' },
    ])
      expect(validateAssistantPreferences(bad).ok).toBe(false);
  });

  it('keeps the owner’s view choice (live or draft) and nothing else in that member', () => {
    expect(validateAssistantPreferences({ view: 'draft' })).toMatchObject({
      ok: true,
      canonical: { view: 'draft' },
    });
    expect(validateAssistantPreferences({ view: 'live' }).ok).toBe(true);
    for (const bad of [{ view: 'both' }, { view: 1 }, { view: 'Draft' }])
      expect(validateAssistantPreferences(bad).ok).toBe(false);
  });

  it('an empty model clears the choice', () => {
    expect(validateAssistantPreferences({ chatgptModel: '' })).toMatchObject({
      ok: true,
      canonical: null,
    });
  });
});
