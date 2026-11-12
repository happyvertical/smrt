import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import type {
  AgentTool,
  AgentTurnHost,
} from '@happyvertical/smrt-inference/server';
import { nodeDir } from '@happyvertical/smrt-inference/server';
import {
  installStub,
  tempDir,
} from '@happyvertical/smrt-inference/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSidecarEnv } from '../../smrt-desktop/src/sidecar-manifest.js';
import type {
  AssistantTurnDriverCallbacks,
  AssistantTurnDriverContext,
} from './assistant-turn-driver.js';
import {
  type AgentCliChatBinding,
  createAgentCliTurnDriver,
  createChatGPTAssistantAI,
  createInferenceAssistantAdapters,
} from './engines.js';
import type { AssistantRequestContext } from './sveltekit.js';
import { toolSummary } from './tool-summary.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setRuntimeExposureGate(undefined);
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function context(
  text: string,
  signal = new AbortController().signal,
): AssistantTurnDriverContext {
  return {
    principal: {
      runAsUserId: 'owner',
      tenantId: 'tenant',
      allowedTools: ['customers.create'],
    },
    history: [
      { role: 'user', content: 'Prior question' },
      { role: 'assistant', content: 'Prior answer' },
    ],
    userMessage: text,
    systemPrompt: 'Use only the host tools.',
    signal,
    tools: [],
    extraTools: [
      {
        slug: 'customers.create',
        aiTool: {
          type: 'function',
          function: {
            name: 'customers_create',
            description: 'Create',
            parameters: {},
          },
        },
        execute: async () => ({}),
      },
    ],
    requiresApproval: () => false,
  };
}

function callbacks(): AssistantTurnDriverCallbacks {
  return {
    text: vi.fn(),
    toolCall: vi.fn(async () => {}),
    toolResult: vi.fn(async () => {}),
    approvalNeeded: vi.fn(async () => ({ approved: false })),
    done: vi.fn(),
    error: vi.fn(),
  };
}

function setup(
  tool: AgentTool,
  approvals: AgentTurnHost['approvals'] = {
    subscribe: () => () => {},
    get: async () => null,
  },
) {
  const directory = tempDir('chat-engine-');
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const binary = installStub(
    join(directory, 'bin'),
    tool === 'codex' ? 'codex' : 'claude',
  );
  const mint = vi.fn(async () => 'owner-bound-test-token');
  const revoke = vi.fn(async () => {});
  const bind = vi.fn(
    async (): Promise<AgentCliChatBinding> => ({
      mcpUrl: 'http://127.0.0.1:1/mcp',
      deps: {
        locate: async () => ({ path: binary, extraPath: [nodeDir()] }),
        stateDir: async () => directory,
        credentials: { mint, revoke },
        baseEnv: {
          PATH: process.env.PATH,
          HOME: directory,
          OPENAI_API_KEY: 'sk-private',
        },
        limits: { turnTimeoutMs: 5000 },
      },
      allowTool: (name: string) => name === 'customers.create',
      approvals,
    }),
  );
  return {
    driver: createAgentCliTurnDriver({ tool, bind }),
    bind,
    mint,
    revoke,
  };
}

async function mcp(
  onRequest: () => void = () => {},
  observation: unknown = { name: 'Ada' },
) {
  const server = createServer((_request, response) => {
    onRequest();
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify(observation) }],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe.each<AgentTool>([
  'claude-code',
  'codex',
])('%s driver over inference stub', (tool) => {
  it('starts the driver under the exact desktop sidecar environment', async () => {
    const { driver, bind } = setup(tool);
    const bound = await bind();
    const directory = await bound.deps.stateDir();
    bound.deps.baseEnv = buildSidecarEnv(
      {},
      {
        port: 5062,
        dataDirectory: directory,
        ownerLinkSecret: 'test-supervisor-secret',
      },
      {
        ...bound.deps.baseEnv,
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        TMPDIR: directory,
        ANTHROPIC_API_KEY: 'test-provider-key',
        OPENAI_API_KEY: 'test-provider-key',
      },
    );
    bind.mockResolvedValue(bound);
    const cb = callbacks();
    await driver.run(context('say Desktop ready'), cb);
    expect(cb.done).toHaveBeenCalledExactlyOnceWith({ text: 'Desktop ready' });
    expect(cb.error).not.toHaveBeenCalled();
  });

  it('streams text and lets chat author the final answer once; cleans up its token', async () => {
    const { driver, mint, revoke } = setup(tool);
    const cb = callbacks();
    await driver.run(context('say Hello owner'), cb);
    expect(
      vi
        .mocked(cb.text)
        .mock.calls.map(([text]) => text)
        .join(''),
    ).toBe('Hello owner');
    expect(cb.done).toHaveBeenCalledExactlyOnceWith({ text: 'Hello owner' });
    expect(mint).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
    expect(JSON.stringify(cb)).not.toContain('owner-bound-test-token');
  });

  it('preserves full arguments and safe summaries rather than clipped event payloads', async () => {
    const { driver, bind, revoke } = setup(tool);
    const original = await bind();
    original.mcpUrl = await mcp();
    bind.mockResolvedValue(original);
    const args = {
      name: 'Ada',
      _meta_type: '@happyvertical/smrt-profiles:Person',
      notes: 'x'.repeat(900),
    };
    const cb = callbacks();
    await driver.run(
      context(`tool customers.create ${JSON.stringify(args)}`),
      cb,
    );
    expect(cb.toolCall).toHaveBeenCalledExactlyOnceWith({
      id: 'toolu_1',
      name: 'customers.create',
      args,
    });
    expect(cb.toolResult).toHaveBeenCalledExactlyOnceWith({
      id: 'toolu_1',
      ok: true,
      result: '{"summary":"Added customer Ada"}',
    });
    expect(cb.done).toHaveBeenCalledWith({ text: 'All done.' });
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each([
    'approved',
    'denied',
    'aborted',
    'model-disabled',
    'model-unreadable',
  ] as const)('observes a hold until %s without reporting an executed result', async (outcome) => {
    const listeners = new Set<
      Parameters<AgentTurnHost['approvals']['subscribe']>[0]
    >();
    let status = 'pending';
    const approvals: AgentTurnHost['approvals'] = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      get: async (id) =>
        id === 'existing-hold'
          ? { id, status, summary: 'Owner hold', preview: null }
          : null,
    };
    const { driver, bind } = setup(tool, approvals);
    const controller = new AbortController();
    const ctx = context(
      'tool customers.create {"name":"Ada"}',
      controller.signal,
    );
    let enabled = true;
    let readable = true;
    if (outcome.startsWith('model-')) {
      ctx.tools = [
        {
          slug: 'customers.create',
          collection: 'profiles',
          className: 'Profile',
          qualifiedName: '@happyvertical/smrt-profiles:Profile',
          action: 'create',
        },
      ];
      ctx.extraTools = [];
      setRuntimeExposureGate({
        isEnabled(model, principal) {
          expect(model.qualifiedName).toBe(
            '@happyvertical/smrt-profiles:Profile',
          );
          expect(principal.tenantId).toBe('tenant');
          if (!readable) throw new Error('unreadable');
          return enabled;
        },
      });
    }
    const original = await bind();
    original.mcpUrl = await mcp(() => {
      for (const listener of listeners)
        listener({ id: 'existing-hold', status: 'pending' });
    });
    bind.mockResolvedValue(original);
    const cb = callbacks();
    cb.approvalNeeded = vi.fn((request) =>
      driver.waitForApproval!(request, ctx),
    );
    const running = driver.run(ctx, cb);
    await vi.waitFor(() => expect(cb.approvalNeeded).toHaveBeenCalledOnce());
    expect(cb.done).not.toHaveBeenCalled();
    expect(cb.approvalNeeded).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'existing-hold',
        callId: 'toolu_1',
        tool: 'customers.create',
      }),
    );
    if (outcome === 'aborted') controller.abort();
    else {
      enabled = outcome !== 'model-disabled';
      readable = outcome !== 'model-unreadable';
      status = outcome.startsWith('model-') ? 'approved' : outcome;
      for (const listener of listeners)
        listener({ id: 'existing-hold', status });
    }
    await running;
    expect(cb.toolResult).not.toHaveBeenCalled();
    if (outcome === 'aborted') expect(cb.done).not.toHaveBeenCalled();
    else
      expect(cb.done).toHaveBeenCalledWith({
        text:
          outcome === 'approved'
            ? 'Approval recorded. Ask the assistant to continue.'
            : 'That action was not approved.',
      });
    expect(listeners.size).toBe(0);
  });

  it.each([
    ['customers.create', { name: 'Ada', large: 'x'.repeat(14000) }],
    ['customers.update', { name: 'Ada' }],
    ['customers.delete', {}],
    ['invoices.list', [{}, {}, {}]],
    ['custom.unknown', { secret: 'sk-private' }],
  ])('%s uses the shared summary even when the model result is clipped', async (name, observation) => {
    const { driver, bind } = setup(tool);
    const bound = await bind();
    bound.mcpUrl = await mcp(() => {}, observation);
    bound.allowTool = (slug) => slug === name;
    bind.mockResolvedValue(bound);
    const ctx = context(`tool ${name} {}`);
    ctx.extraTools = ctx.extraTools.map((extra) => ({ ...extra, slug: name }));
    ctx.principal.allowedTools = [name];
    const cb = callbacks();
    await driver.run(ctx, cb);
    expect(cb.toolResult).toHaveBeenCalledExactlyOnceWith({
      id: 'toolu_1',
      ok: true,
      result: JSON.stringify({ summary: toolSummary(name, observation) }),
    });
  });

  it('maps MCP wire names to canonical allow-listed slugs without offering aliases', async () => {
    const { driver, bind } = setup(tool);
    const bound = await bind();
    bound.mcpUrl = await mcp();
    bound.canonicalToolName = (name) =>
      name === 'customer_create' ? 'customers.create' : undefined;
    bound.allowTool = (name) => name === 'customer_create';
    bind.mockResolvedValue(bound);
    const cb = callbacks();
    await driver.run(context('tool customer_create {"name":"Ada"}'), cb);
    expect(cb.toolCall).toHaveBeenCalledWith({
      id: 'toolu_1',
      name: 'customers.create',
      args: { name: 'Ada' },
    });
    expect(cb.toolResult).toHaveBeenCalledWith({
      id: 'toolu_1',
      ok: true,
      result: '{"summary":"Added customer Ada"}',
    });
  });

  it('aborts the real subprocess and revokes its token', async () => {
    const { driver, mint, revoke } = setup(tool);
    const controller = new AbortController();
    const cb = callbacks();
    const running = driver.run(context('hang', controller.signal), cb);
    await vi.waitFor(() => expect(mint).toHaveBeenCalled());
    controller.abort();
    await running;
    expect(revoke).toHaveBeenCalledOnce();
    expect(cb.done).not.toHaveBeenCalled();
  });

  it('classifies a CLI failure without stderr or token disclosure', async () => {
    const { driver, revoke } = setup(tool);
    const cb = callbacks();
    await expect(driver.run(context('fail'), cb)).rejects.toMatchObject({
      code: 'agent_cli_failed',
    });
    expect(cb.done).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it.each([
    'disabled',
    'unreadable',
  ] as const)('refuses a CLI manifest call with a %s model before reporting success', async (state) => {
    const { driver, bind, revoke } = setup(tool);
    const bound = await bind();
    bound.mcpUrl = await mcp();
    bind.mockResolvedValue(bound);
    const ctx = context('tool customers.create {"name":"Ada"}');
    ctx.tools = [
      {
        slug: 'customers.create',
        collection: 'profiles',
        className: 'Profile',
        qualifiedName: '@happyvertical/smrt-profiles:Profile',
        action: 'create',
      },
    ];
    ctx.extraTools = [];
    setRuntimeExposureGate({
      isEnabled(model, principal) {
        expect(model.qualifiedName).toBe(
          '@happyvertical/smrt-profiles:Profile',
        );
        expect(principal.tenantId).toBe('tenant');
        if (state === 'unreadable') throw new Error('offline');
        return false;
      },
    });
    const cb = callbacks();
    await expect(driver.run(ctx, cb)).rejects.toMatchObject({
      code: 'agent_tool_blocked',
    });
    expect(cb.toolResult).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('blocks unoffered tools before reporting progress', async () => {
    const { driver, revoke } = setup(tool);
    await expect(
      driver.run(context('forbidden'), callbacks()),
    ).rejects.toMatchObject({ code: 'agent_tool_blocked' });
    expect(revoke).toHaveBeenCalledOnce();
  });
});

describe('ChatGPT chat factory', () => {
  it('reuses the plan model, strips unsupported options and preserves raw calls/progress/usage', async () => {
    const raw = [
      {
        id: 'call',
        type: 'function' as const,
        function: { name: 'customers_create', arguments: '{"name":"Ada"}' },
      },
    ];
    const chat = vi.fn(async (_messages, options) => {
      options.onProgress('Hello');
      return { content: 'Hello', toolCalls: raw, usage: { totalTokens: 11 } };
    });
    const clientOptions = vi.fn(async () => ({
      type: 'chatgpt-plan',
      tokenSource: 'never rendered',
    }));
    const ai = await createChatGPTAssistantAI({
      connection: { clientOptions },
      toolNamespace: { name: 'studio', description: 'Studio tools' },
      createClient: async () => ({ chat }),
    });
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const reply = await ai.chat([{ role: 'user', content: 'hello' }], {
      temperature: 1,
      maxTokens: 42,
      tools: [],
      signal,
      onProgress,
    });
    expect(Object.keys(chat.mock.calls[0][1]).sort()).toEqual([
      'onProgress',
      'signal',
      'tools',
    ]);
    expect(chat.mock.calls[0][1].signal).toBe(signal);
    expect(onProgress).toHaveBeenCalledWith('Hello');
    expect(reply).toMatchObject({
      toolCalls: raw,
      usage: { totalTokens: 11 },
      finishReason: 'tool_calls',
    });
    expect(clientOptions).toHaveBeenCalledWith({
      toolNamespace: { name: 'studio', description: 'Studio tools' },
    });
  });

  it('never falls back when the connection refuses', async () => {
    const createClient = vi.fn();
    await expect(
      createChatGPTAssistantAI({
        connection: {
          clientOptions: async () => {
            throw new Error('signed out');
          },
        },
        toolNamespace: { name: 'app', description: 'Tools' },
        createClient,
      }),
    ).rejects.toMatchObject({
      code: 'chatgpt_unavailable',
      message: 'ChatGPT could not connect. Try again in AI settings.',
    });
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('per-request inference adapters', () => {
  it('refuses a failed startup probe with its precise safe cause and a logged reference', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapters = createInferenceAssistantAdapters({
      binding: async () => 'codex',
      status: async () => ({
        cliStatus: async () => ({
          installed: true,
          signedIn: true,
          ready: false,
          startError: 'working_directory',
        }),
        chatgpt: { status: vi.fn() },
        apiStatus: vi.fn(),
      }),
      cli: vi.fn(),
      chatgpt: vi.fn(),
    });
    const context = {
      event: { request: new Request('http://app.test/send') },
    } as AssistantRequestContext;
    await expect(adapters.resolveTurnDriver!(context)).rejects.toMatchObject({
      code: 'agent_cli_startup',
      message: expect.stringMatching(
        /writable temporary directory.*Reference: [a-f0-9-]{36}/,
      ),
    });
    expect(log).toHaveBeenCalledWith(
      '[smrt-inference] local engine failure',
      expect.objectContaining({
        phase: 'preflight',
        code: 'working_directory',
      }),
    );
  });

  it('uses authenticated bindings and checks once per request across route context copies', async () => {
    const driver = { run: vi.fn() };
    const api = { chat: vi.fn() };
    const binding = vi.fn(async (ctx: AssistantRequestContext) =>
      ctx.principal.userId === 'a' ? ('codex' as const) : ('api' as const),
    );
    const cliStatus = vi.fn(async () => ({
      installed: true,
      signedIn: true,
      ready: true,
    }));
    const apiStatus = vi.fn(async () => ({ configured: true }));
    const cli = vi.fn(() => driver);
    const adapters = createInferenceAssistantAdapters({
      binding,
      status: async () => ({
        cliStatus,
        apiStatus,
        chatgpt: { status: vi.fn() },
      }),
      cli,
      chatgpt: vi.fn(),
      api,
    });
    const ctx = (id: string) =>
      ({
        event: { request: new Request('http://app.test/send') },
        principal: { userId: id },
        requestContext: { engine: 'chatgpt' },
      }) as unknown as AssistantRequestContext;
    const a = ctx('a');
    const b = ctx('b');
    expect(await adapters.resolveTurnDriver!(a)).toBe(driver);
    expect(await adapters.resolveTurnDriver!(b)).toBeUndefined();
    expect(
      await (adapters.ai as (ctx: AssistantRequestContext) => unknown)({
        ...b,
      }),
    ).toBe(api);
    expect(binding).toHaveBeenCalledTimes(2);
    expect(cliStatus).toHaveBeenCalledOnce();
    expect(apiStatus).toHaveBeenCalledOnce();
  });

  it('refuses an unavailable or unknown selected engine without a fallback', async () => {
    const cli = vi.fn();
    const api = { chat: vi.fn() };
    for (const engine of ['codex', 'future-engine']) {
      const adapters = createInferenceAssistantAdapters({
        binding: async () => engine as 'codex',
        status: async () => ({
          cliStatus: async () => ({ installed: false, signedIn: false }),
          chatgpt: { status: vi.fn() },
          apiStatus: vi.fn(),
        }),
        cli,
        chatgpt: vi.fn(),
        api,
      });
      await expect(
        adapters.resolveTurnDriver!({
          event: { request: new Request('http://app.test/send') },
        } as AssistantRequestContext),
      ).rejects.toMatchObject({ code: 'AI_UNAVAILABLE' });
    }
    expect(cli).not.toHaveBeenCalled();
    expect(api.chat).not.toHaveBeenCalled();
  });
});
