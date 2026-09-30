import type { McpAppBridge } from '@happyvertical/smrt-mcp-apps';
import { describe, expect, it, vi } from 'vitest';
import {
  hasOpenAiMessage,
  openAiMessage,
  sendOpenAiMessage,
} from './messages.js';

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

describe('exported message destination helper', () => {
  it.each([
    'absent',
    'unknown',
    'missing-callback',
  ])('rejects new target before dispatch when %s', async (mode) => {
    const sendMessage = vi.fn(async () => {});
    const native = vi.fn(async () => {});
    const capabilities =
      mode === 'absent'
        ? {}
        : {
            experimental: {
              'openai/message': mode === 'unknown' ? 'future' : {},
            },
          };
    const bridge = {
      snapshot: { rawHostCapabilities: capabilities },
      sendMessage,
    } as unknown as McpAppBridge;
    await expect(
      sendOpenAiMessage({
        bridge,
        value: { target: 'new', text: { text: 'Private message' } },
        native: mode === 'missing-callback' ? undefined : native,
      }),
    ).rejects.toThrow('New-conversation messages require native support');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
  });
  it('sends active fallback and negotiated new messages to their exact destinations', async () => {
    const sendMessage = vi.fn(async () => {});
    const bridge = {
      snapshot: { rawHostCapabilities: {} },
      sendMessage,
    } as unknown as McpAppBridge;
    await expect(
      sendOpenAiMessage({
        bridge,
        value: { target: 'active', text: { text: 'Active' } },
      }),
    ).resolves.toBe('portable');
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith('Active', undefined);
    const native = vi.fn(async () => {});
    const negotiated = {
      snapshot: {
        rawHostCapabilities: { experimental: { 'openai/message': {} } },
      },
      sendMessage,
    } as unknown as McpAppBridge;
    await expect(
      sendOpenAiMessage({
        bridge: negotiated,
        value: { target: 'new', text: { text: 'New' } },
        native,
      }),
    ).resolves.toBe('native');
    expect(native).toHaveBeenCalledExactlyOnceWith(
      {
        role: 'user',
        content: [{ type: 'text', text: 'New' }],
        _meta: { 'openai/message': { target: 'new', send: true } },
      },
      undefined,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
