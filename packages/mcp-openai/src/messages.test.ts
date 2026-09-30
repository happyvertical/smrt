import { describe, expect, it } from 'vitest';
import { hasOpenAiMessage, openAiMessage } from './messages.js';

describe('OpenAI messages', () => {
  it('uses the active-send default and the exact new-conversation metadata', () => {
    expect(openAiMessage({ text: { text: 'Hello' } })).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
    });
    expect(
      openAiMessage({
        text: { text: 'Hello', title: 'Greeting' },
        target: 'new',
      }),
    ).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello', _meta: { 'openai/title': 'Greeting' } },
      ],
      _meta: { 'openai/message': { target: 'new', send: true } },
    });
  });
  it('does not let unknown capability or invented send fields enable native messages', () => {
    expect(hasOpenAiMessage({ experimental: { 'openai/message': {} } })).toBe(
      true,
    );
    expect(hasOpenAiMessage({ experimental: { 'openai/message': [] } })).toBe(
      false,
    );
    expect(() =>
      openAiMessage({ text: { text: 'x' }, target: 'other' as never }),
    ).toThrow();
    expect(() =>
      openAiMessage({ text: { text: 'x' }, send: false } as never),
    ).toThrow();
  });
});
