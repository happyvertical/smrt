// The `chatgpt` engine (Sign in with ChatGPT, a preview): driven with a stubbed
// `chatgpt-plan` client, so nothing reaches a network and no one signs in.
//
// What these hold: the engine sends none of what the plan refuses, runs the
// tool loop through `chat()` + `onProgress`, keeps the Approval gate, names
// each failure in words (with "Sign in again" where it applies), and runs ONLY
// on a target the owner's sign-in resolver produced: never on an API key, never
// on `claude-cli`, never on a `chatgpt-plan` that came from anywhere else.
import {
  type ChatGPTPlanConnection,
  createChatGPTPlanResolver,
} from '@happyvertical/smrt-inference/server';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { TurnEvent } from '../../assistant/events.ts';
import {
  CHATGPT_ASSISTANT_CLASS,
  CHATGPT_SETTINGS_HREF,
  CHATGPT_TOOL_NAMESPACE,
  setChatGPTConnection,
} from '../chatgpt.ts';
import { getHost } from '../host.ts';
import { callTool } from '../policy.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import {
  assertApiKeyProvider,
  ChatGPTSignedOutError,
  resolveAssistantOptions,
  SubscriptionProviderError,
  unavailableBody,
} from './config.ts';
import { statusFor } from './engine.ts';
import { createAiModelFactory } from './model.ts';
import { drive } from './test-helpers.ts';

const SECRET = 'SECRET-ACCESS-TOKEN-do-not-leak';

// The stub provider: records how `getAI` and `chat` were called.
const created: Record<string, unknown>[] = [];
const chatCalls: { messages: unknown[]; options: Record<string, unknown> }[] =
  [];
let script: Array<(options: Record<string, unknown>) => unknown> = [];

vi.mock('@happyvertical/ai', () => ({
  getAI: async (options: Record<string, unknown>) => {
    created.push(options);
    return {
      async chat(messages: unknown[], chatOptions: Record<string, unknown>) {
        chatCalls.push({ messages, options: chatOptions });
        const step = script[Math.min(chatCalls.length - 1, script.length - 1)];
        return step(chatOptions);
      },
    };
  },
}));

let h: ShellHarness;
let signedIn = true;

function fakeConnection(): ChatGPTPlanConnection {
  return {
    start: async () => ({ authorizationUrl: 'https://auth.openai.com/x' }),
    status: async () => ({
      signedIn,
      signingIn: false,
      ...(signedIn ? { account: { label: 'owner@example.com' } } : {}),
    }),
    cancel: vi.fn(async () => undefined),
    signOut: async () => ({ remoteRevocationConfirmed: true }),
    models: async () => [{ id: 'gpt-x', label: 'GPT X' }],
    defaultModel: async () => 'gpt-x',
    clientOptions: async (extra = {}) => {
      if (!signedIn) throw new ChatGPTSignedOutError();
      return {
        type: 'chatgpt-plan',
        clientId: 'client-1',
        // The provider gets a handle that can only mint a token.
        sessionManager: { accessToken: async () => SECRET },
        ...(extra.model ? { defaultModel: extra.model } : {}),
        ...(extra.toolNamespace ? { toolNamespace: extra.toolNamespace } : {}),
      };
    },
  };
}

/** The resolver the shell composes, over the fake connection. */
const resolver = () =>
  createChatGPTPlanResolver({
    connection: fakeConnection(),
    appliesTo: (request) => request.className === CHATGPT_ASSISTANT_CLASS,
  });

const reply = (content: string, toolCalls?: unknown[]) => () => ({
  content,
  model: 'gpt-x',
  finishReason: toolCalls?.length ? 'tool_calls' : 'stop',
  usage: { totalTokens: 10 },
  ...(toolCalls ? { toolCalls } : {}),
});
const toolCall = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});
const failing = (name: string, code?: string) => () => {
  throw Object.assign(new Error(`${name} detail with ${SECRET}`), {
    name,
    code,
  });
};

beforeAll(async () => {
  h = await openShell();
  setChatGPTConnection(fakeConnection());
  await callTool(h.owner, 'app_definemodel', {
    name: 'Chore',
    fields: { title: { type: 'text' } },
  });
});
afterAll(async () => {
  setChatGPTConnection(undefined);
  await h.close();
});
beforeEach(() => {
  signedIn = true;
  created.length = 0;
  chatCalls.length = 0;
  script = [reply('hello')];
});

const modelFor = async (config = { resolver: resolver() }) =>
  createAiModelFactory(config)({ principal: h.owner, engine: 'chatgpt' });

describe('what the engine sends', () => {
  it('builds the client from the sign-in only and describes the shell tools', async () => {
    await modelFor();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'chatgpt-plan',
      clientId: 'client-1',
      defaultModel: 'gpt-x',
      toolNamespace: CHATGPT_TOOL_NAMESPACE,
    });
    // No key, endpoint, provider alias or environment value rides along.
    for (const key of ['apiKey', 'baseUrl', 'provider', 'model'])
      expect(created[0]).not.toHaveProperty(key);
  });

  it('calls chat() with tools and onProgress, and none of the rejected options', async () => {
    const model = await modelFor();
    const progress: string[] = [];
    script = [
      (options) => {
        (options.onProgress as (d: string) => void)('hi');
        return reply('hi')();
      },
    ];
    const out = await model.complete({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
      maxTokens: 2048, // the loop's limit: must NOT reach this provider
      signal: new AbortController().signal,
      onText: (d) => progress.push(d),
    });
    expect(out.text).toBe('hi');
    expect(progress).toEqual(['hi']);
    const sent = Object.keys(chatCalls[0].options).sort();
    expect(sent).toEqual(['onProgress', 'signal', 'tools']);
    for (const rejected of [
      'maxTokens',
      'temperature',
      'topP',
      'user',
      'responseFormat',
      'responseSchema',
      'reasoning',
      'thinkingLevel',
      'stream',
      'seed',
    ])
      expect(chatCalls[0].options).not.toHaveProperty(rejected);
    // Forced single-function choice is rejected; "auto" is simply the default.
    expect(chatCalls[0].options.toolChoice).toBeUndefined();
  });
});

describe('a turn on the plan', () => {
  it('runs a tool call through the approval hold and returns the outcome to the model', async () => {
    const host = await getHost();
    const id = (await host.create('Chore', { title: 'keep' })).id as string;
    script = [
      reply('Removing it.', [toolCall('c1', 'chore_delete', { id })]),
      reply('Understood, it was not removed.'),
    ];
    const held: string[] = [];
    const { events, stop } = await drive({
      principal: h.owner,
      model: await modelFor(),
      hold: (async (approvalId: string) => {
        held.push(approvalId);
        return { status: 'denied' };
      }) as never,
    });
    const ask = events.find((e) => e.type === 'approval_required') as Extract<
      TurnEvent,
      { type: 'approval_required' }
    >;
    expect(ask).toBeTruthy();
    expect(held).toEqual([ask.approvalId]);
    expect(stop).toBe('complete');
    expect((await host.get('Chore', id)).id).toBe(id); // nothing deleted
    // The second call replays the assistant's tool call and the tool result.
    const replay = JSON.stringify(chatCalls[1].messages);
    expect(replay).toContain('"tool_calls"');
    expect(replay).toContain('"role":"tool"');
    expect(replay).toContain('denied');
    // Every call, including the replay, stayed inside the plan's limits.
    for (const call of chatCalls)
      expect(Object.keys(call.options).sort()).toEqual([
        'onProgress',
        'signal',
        'tools',
      ]);
  });
});

describe('failures in words', () => {
  const run = async () => {
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      logs.push(a);
    });
    try {
      const out = await drive({ principal: h.owner, model: await modelFor() });
      return { ...out, logs };
    } finally {
      spy.mockRestore();
    }
  };
  const errorOf = (events: TurnEvent[]) =>
    events.find((e) => e.type === 'error') as Extract<
      TurnEvent,
      { type: 'error' }
    >;

  it('a revoked session says so and offers "Sign in again"', async () => {
    script = [failing('ChatGPTPlanSessionRevokedError', 'session_invalidated')];
    const { events, stop, logs } = await run();
    expect(stop).toBe('error');
    expect(errorOf(events)).toMatchObject({
      code: 'chatgpt_session_revoked',
      action: { label: 'Sign in again', href: CHATGPT_SETTINGS_HREF },
    });
    // The provider's text (which can echo a token) reaches neither log nor browser.
    expect(JSON.stringify([events, logs])).not.toContain(SECRET);
  });

  it('a usage limit says the plan is used up, with no sign-in prompt', async () => {
    script = [failing('ChatGPTPlanUsageLimitError')];
    const { events } = await run();
    const e = errorOf(events);
    expect(e.code).toBe('chatgpt_usage_limit');
    expect(e.message).toMatch(/usage limit/i);
    expect(e.action).toBeUndefined();
  });

  it('a workspace refusal offers another account', async () => {
    script = [failing('ChatGPTPlanWorkspaceError', 'workspace_restricted')];
    const e = errorOf((await run()).events);
    expect(e.code).toBe('chatgpt_workspace');
    expect(e.action?.label).toBe('Sign in again');
  });

  it('"unavailable" keeps the session and says to try again', async () => {
    script = [failing('ChatGPTPlanUsageUnavailableError')];
    const e = errorOf((await run()).events);
    expect(e.code).toBe('chatgpt_unavailable');
    expect(e.message).toMatch(/still signed in/i);
  });

  it('an unsupported-capability refusal is reported as the app’s fault', async () => {
    script = [
      failing(
        'ChatGPTPlanError',
        'subscription_sharing_unsupported_capability',
      ),
    ];
    const e = errorOf((await run()).events);
    expect(e.code).toBe('chatgpt_unsupported');
    expect(e.message).toMatch(/fault in the app/i);
  });

  it('any other failure stays generic', async () => {
    script = [failing('Error')];
    expect(errorOf((await run()).events).code).toBe('model_error');
  });
});

describe('only the owner’s sign-in, never anything else', () => {
  it('signed out: unavailable with a sign-in action, and no client is built', async () => {
    signedIn = false;
    let caught: unknown;
    try {
      await modelFor();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChatGPTSignedOutError);
    expect(unavailableBody(caught)).toMatchObject({
      code: 'chatgpt_signed_out',
      action: { href: CHATGPT_SETTINGS_HREF },
    });
    expect(created).toHaveLength(0);
    expect(
      await statusFor('chatgpt', h.owner, {
        config: {},
        cliStatus: vi.fn() as never,
      }),
    ).toMatchObject({
      configured: false,
      code: 'chatgpt_signed_out',
    });
  });

  it('does not fall back to an API key when the resolver is not the sign-in one', async () => {
    const elsewhere = {
      resolve: async () => ({
        tierResolved: 'good' as const,
        target: { provider: 'anthropic', source: 'app' as const },
        via: 'resolver' as const,
      }),
    };
    await expect(
      modelFor({ resolver: elsewhere } as never),
    ).rejects.toBeInstanceOf(ChatGPTSignedOutError);
    // Even a chatgpt-plan target that did not come from the sign-in resolver.
    const forged = {
      resolve: async () => ({
        tierResolved: 'good' as const,
        target: {
          provider: 'chatgpt-plan',
          model: 'gpt-x',
          source: 'app' as const,
        },
        via: 'resolver' as const,
      }),
    };
    await expect(
      modelFor({ resolver: forged } as never),
    ).rejects.toBeInstanceOf(ChatGPTSignedOutError);
    expect(created).toHaveLength(0);
  });

  it('the plan only answers the chatgpt engine’s own request', async () => {
    const r = resolver();
    const other = await r.resolve(
      { tier: 'good', className: 'SomethingElse' },
      {
        config: undefined,
        resolveFromConfig: () => ({
          tierResolved: 'good',
          target: {},
          via: 'default',
        }),
      },
    );
    expect(other).toBeUndefined();
  });

  it('the API engine and everything else still refuse claude-cli and chatgpt-plan', async () => {
    for (const id of ['claude-cli', 'claude_cli', 'chatgpt-plan'])
      expect(() => assertApiKeyProvider(id)).toThrow(SubscriptionProviderError);
    await expect(
      resolveAssistantOptions(h.owner, {
        env: { SMRT_AI_PROVIDER: 'claude-cli' },
      }),
    ).rejects.toBeInstanceOf(SubscriptionProviderError);
    await expect(
      resolveAssistantOptions(h.owner, {
        env: { SMRT_AI_PROVIDER: 'chatgpt-plan', SMRT_AI_API_KEY: 'k' },
      }),
    ).rejects.toBeInstanceOf(SubscriptionProviderError);
    // The default (API) engine, even handed the sign-in resolver, never builds it.
    await expect(
      createAiModelFactory({ env: { SMRT_AI_PROVIDER: 'claude-cli' } })({
        principal: h.owner,
      }),
    ).rejects.toBeInstanceOf(SubscriptionProviderError);
    expect(created).toHaveLength(0);
  });
});
