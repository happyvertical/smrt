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

it('executes one plan fallback and records actual model without unsupported effort options', async () => {
  const recordExecution = vi.fn();
  const notify = vi.fn();
  const store = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => {}),
  };
  const calls: Record<string, unknown>[] = [];
  const model = await createChatGPTModel({
    connection: {
      clientOptions: async (options) => ({
        type: 'chatgpt-plan',
        defaultModel: options?.model,
      }),
    },
    profile: 'design',
    catalog: [
      { id: 'fast', intelligenceRank: 1 },
      { id: 'strong', intelligenceRank: 2 },
    ],
    toolNamespace: namespace,
    recordExecution,
    fallback: {
      ownerId: 'owner',
      connectionKey: 'account-v1',
      nextModel: 'fast',
      store,
      notify,
    },
    createClient: async (options) => ({
      chat: async (_messages, chatOptions) => {
        calls.push(chatOptions);
        if (options.defaultModel === 'strong')
          throw { code: 'model_access_denied' };
        return {
          model: 'native-fast',
          content: 'done',
          usage: { totalTokens: 42 },
        };
      },
    }),
  });
  expect((await model.complete(request())).text).toBe('done');
  expect(recordExecution).toHaveBeenCalledWith(
    expect.objectContaining({
      profile: 'design',
      model: 'native-fast',
      requestedModel: 'fast',
      tokens: 42,
      fallback: { from: 'strong', to: 'fast', reason: 'plan-model-refused' },
    }),
  );
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => !('reasoning' in call))).toBe(true);
  expect(notify).toHaveBeenCalledOnce();
});

it('never retries a plan refusal after streaming text', async () => {
  const chat = vi.fn(async (_messages, options) => {
    options.onProgress('started');
    throw { code: 'MODEL_ACCESS_DENIED' };
  });
  const model = await createChatGPTModel({
    connection: { clientOptions: async () => ({}) },
    profile: 'assist',
    model: 'strong',
    toolNamespace: namespace,
    fallback: {
      ownerId: 'owner',
      connectionKey: 'v1',
      nextModel: 'fast',
      store: { read: async () => undefined, write: async () => {} },
      notify: vi.fn(),
    },
    createClient: async () => ({ chat }),
  });
  await expect(model.complete(request())).rejects.toMatchObject({
    code: 'MODEL_ACCESS_DENIED',
  });
  expect(chat).toHaveBeenCalledOnce();
});

it('discovers ranked account choices for design and derives the single fallback while publishing shared wording', async () => {
  const calls: string[] = [];
  const onText = vi.fn();
  const model = await createChatGPTModel({
    connection: {
      models: async () => [
        { id: 'small', label: 'Small', intelligenceRank: 1 },
        { id: 'strong', label: 'Strong', intelligenceRank: 3 },
      ],
      clientOptions: async (o) => ({ defaultModel: o?.model }),
    },
    profile: 'design',
    toolNamespace: namespace,
    fallback: {
      ownerId: 'owner',
      connectionKey: 'account:catalog:1',
      store: { read: async () => undefined, write: vi.fn(async () => {}) },
    },
    createClient: async (options) => ({
      chat: async () => {
        calls.push(options.defaultModel as string);
        if (options.defaultModel === 'strong')
          throw { code: 'MODEL_ACCESS_DENIED' };
        return { content: 'done', model: 'reported-small' };
      },
    }),
  });
  expect((await model.complete({ ...request(), onText })).text).toBe('done');
  expect(calls).toEqual(['strong', 'small']);
  expect(onText).toHaveBeenCalledWith(
    expect.stringContaining('next strongest model on the same connection'),
  );
});
