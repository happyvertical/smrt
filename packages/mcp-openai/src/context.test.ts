import { describe, expect, it } from 'vitest';
import {
  hasOpenAiModelContext,
  openAiContextText,
  openAiModelContextUpdate,
} from './context.js';

describe('OpenAI model context', () => {
  it('preserves title and thumbnail metadata while making background visibility explicit', () => {
    expect(
      openAiContextText({
        text: 'Selected item',
        title: 'Item',
        thumbnail: { src: 'https://assets.test/item.png' },
        background: true,
      }),
    ).toEqual({
      type: 'text',
      text: 'Selected item',
      _meta: {
        'openai/title': 'Item',
        'openai/thumbnail': { src: 'https://assets.test/item.png' },
      },
      annotations: { audience: ['assistant'] },
    });
  });
  it('rejects malformed, unknown and oversized provider-bound content', () => {
    for (const value of [
      { text: 'x', private: true },
      { text: 'x'.repeat(16385) },
      { text: 'x', thumbnail: { src: 'x', extra: true } },
      { text: 'x', background: 'yes' },
    ])
      expect(() => openAiContextText(value as never)).toThrow();
  });
  it('requires a bounded replacement payload and fails closed on unknown capability', () => {
    expect(openAiModelContextUpdate({ text: { text: 'safe' } })).toEqual({
      content: [{ type: 'text', text: 'safe' }],
    });
    expect(() => openAiModelContextUpdate({})).toThrow();
    expect(
      hasOpenAiModelContext({ experimental: { 'openai/modelContext': {} } }),
    ).toBe(true);
    expect(
      hasOpenAiModelContext({
        experimental: { 'openai/modelContext': 'future' },
      }),
    ).toBe(false);
  });
});
