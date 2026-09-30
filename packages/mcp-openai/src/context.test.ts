import type { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { describe, expect, it, vi } from 'vitest';
import {
  hasOpenAiModelContext,
  openAiContextText,
  openAiModelContextUpdate,
  updateOpenAiModelContext,
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

describe('exported context transport helper', () => {
  it('replaces context through the portable bridge after a native failure', async () => {
    const updateModelContext = vi.fn(async () => {});
    const bridge = {
      snapshot: {
        rawHostCapabilities: { experimental: { 'openai/modelContext': {} } },
      },
      updateModelContext,
    } as unknown as McpAppBridge;
    const native = vi.fn(async () => {
      throw new Error('native unavailable');
    });
    const value = {
      text: { text: 'Replacement', title: 'Native title', background: true },
      structuredContent: { selected: 'new' },
    };
    await expect(
      updateOpenAiModelContext({ bridge, value, native }),
    ).resolves.toBe('portable');
    expect(native).toHaveBeenCalledOnce();
    expect(updateModelContext).toHaveBeenCalledExactlyOnceWith(
      { text: 'Replacement', structuredContent: { selected: 'new' } },
      undefined,
    );
  });
  it('does not revive an aborted native context operation', async () => {
    const controller = new AbortController();
    const updateModelContext = vi.fn(async () => {});
    const bridge = {
      snapshot: {
        rawHostCapabilities: { experimental: { 'openai/modelContext': {} } },
      },
      updateModelContext,
    } as unknown as McpAppBridge;
    const failure = new Error('aborted native');
    await expect(
      updateOpenAiModelContext({
        bridge,
        value: { text: { text: 'Replacement' } },
        signal: controller.signal,
        native: async () => {
          controller.abort();
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(updateModelContext).not.toHaveBeenCalled();
  });
});
