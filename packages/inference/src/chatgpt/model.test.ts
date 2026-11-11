import type { AIMessage, AITool } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import { EngineModelFailure } from '../engine-model.js';
import { ChatGPTSignedOutError } from './connection.js';
import { createChatGPTModel } from './model.js';

const namespace = { name: 'app_tools', description: 'Owner tools' };
const request = () => ({
  messages: [{ role: 'user', content: 'hello' }] as AIMessage[],
  tools: [
    { type: 'function', function: { name: 'list', parameters: {} } },
  ] as AITool[],
  signal: new AbortController().signal,
  maxTokens: 4096,
  onText: vi.fn(),
});

describe('ChatGPT model-round adapter', () => {
  it('uses only connection options and chat + onProgress, preserving raw calls for host replay', async () => {
    const raw = [
      {
        id: 'c1',
        type: 'function' as const,
        function: { name: 'list', arguments: '{}' },
      },
    ];
    const input = request();
    const chat = vi.fn(async (_messages, options) => {
      options.onProgress('hello');
      return { content: 'hello', toolCalls: raw, usage: { totalTokens: 12 } };
    });
    const clientOptions = vi.fn(async () => ({
      type: 'chatgpt-plan',
      sessionManager: { accessToken: async () => 'fake-secret' },
    }));
    const createClient = vi.fn(async () => ({ chat }));
    const model = await createChatGPTModel({
      connection: { clientOptions },
      model: 'gpt-test',
      toolNamespace: namespace,
      createClient,
    });
    expect(clientOptions).toHaveBeenCalledWith({
      model: 'gpt-test',
      toolNamespace: namespace,
    });
    expect(createClient).toHaveBeenCalledWith(
      await clientOptions.mock.results[0].value,
    );
    const result = await model.complete(input);
    expect(chat).toHaveBeenCalledWith(input.messages, {
      tools: input.tools,
      signal: input.signal,
      onProgress: input.onText,
    });
    expect(Object.keys(chat.mock.calls[0][1]).sort()).toEqual([
      'onProgress',
      'signal',
      'tools',
    ]);
    expect(result).toEqual({
      text: 'hello',
      toolCalls: [{ id: 'c1', name: 'list', arguments: '{}' }],
      raw,
      totalTokens: 12,
    });
    expect(result.raw).toBe(raw);
    expect(input.onText).toHaveBeenCalledWith('hello');
  });

  it('omits an unselected model and accepts absent optional response fields', async () => {
    const clientOptions = vi.fn(async () => ({ type: 'chatgpt-plan' }));
    const model = await createChatGPTModel({
      connection: { clientOptions },
      toolNamespace: namespace,
      createClient: async () => ({ chat: async () => ({}) }),
    });
    expect(clientOptions).toHaveBeenCalledWith({ toolNamespace: namespace });
    expect(await model.complete(request())).toEqual({
      text: '',
      toolCalls: [],
    });
  });

  it('signed out never constructs a client or falls back to a provider key', async () => {
    const createClient = vi.fn();
    await expect(
      createChatGPTModel({
        connection: {
          clientOptions: async () => {
            throw new ChatGPTSignedOutError();
          },
        },
        toolNamespace: namespace,
        createClient,
      }),
    ).rejects.toBeInstanceOf(ChatGPTSignedOutError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    ['ChatGPTPlanSessionRevokedError', 'chatgpt_session_revoked', true],
    ['ChatGPTPlanWorkspaceError', 'chatgpt_workspace', true],
    ['ChatGPTPlanUsageLimitError', 'chatgpt_usage_limit', false],
    ['ChatGPTPlanUsageUnavailableError', 'chatgpt_unavailable', false],
  ])('classifies %s without exposing provider text', async (name, code, actionable) => {
    const cause = Object.assign(new Error('fake-secret'), { name });
    const model = await createChatGPTModel({
      connection: { clientOptions: async () => ({ type: 'chatgpt-plan' }) },
      toolNamespace: namespace,
      settingsHref: '/connect',
      createClient: async () => ({
        chat: async () => {
          throw cause;
        },
      }),
    });
    const error = await model.complete(request()).catch((e) => e);
    expect(error).toBeInstanceOf(EngineModelFailure);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain('fake-secret');
    expect(error.action).toEqual(
      actionable ? { label: 'Sign in again', href: '/connect' } : undefined,
    );
    expect(error.cause).toBe(cause);
  });

  it('lets unknown failures reach the host generic error handler', async () => {
    const cause = new Error('provider error');
    const model = await createChatGPTModel({
      connection: { clientOptions: async () => ({ type: 'chatgpt-plan' }) },
      toolNamespace: namespace,
      createClient: async () => ({
        chat: async () => {
          throw cause;
        },
      }),
    });
    await expect(model.complete(request())).rejects.toBe(cause);
  });
});
