// Ported subprocess lifecycle/security cases. No real CLI or provider is used.
// Shell tests additionally exercise these engines through its real owner policy.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nodeDir } from './env.js';
import { installStub, tempDir } from './test-support.js';
import type { AgentTool } from './tools.js';
import {
  type AgentEngineDeps,
  type AgentTurnHost,
  type AgentTurnMessage,
  reportAgentFailure,
  runAgentTurn,
  type AgentTurnEvent as TurnEvent,
} from './turn.js';

describe('safe correlated engine diagnostics', () => {
  it('logs the cause class and code location once, with no exception message, cause or unsafe code', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new TypeError('Bearer secret-test-token', {
      cause: { apiKey: 'secret-test-key' },
    });
    error.stack += '\n    at /private/secret-test-token.js:12:34';
    const reference = reportAgentFailure(
      'codex',
      'binding',
      error,
      'secret-test-code',
    );
    expect(reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(reportAgentFailure('codex', 'driver', error)).toBe(reference);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[smrt-inference] local engine failure',
      expect.objectContaining({
        reference,
        phase: 'binding',
        cause: 'TypeError',
        code: 'unexpected_failure',
        sites: expect.any(Array),
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /secret-test|Bearer|apiKey/,
    );
  });
});

const minted: string[] = [];
let revoked = 0;
let token: string | null = null;
const live = () => token;
afterEach(() => vi.restoreAllMocks());
function setup(tool: AgentTool, extra: Partial<AgentEngineDeps> = {}) {
  const bin = tempDir('stub-bin-');
  const stateDir = tempDir('agent-state-');
  const path = installStub(bin, tool === 'claude-code' ? 'claude' : 'codex');
  const deps: AgentEngineDeps = {
    locate: async () => ({ path, extraPath: [nodeDir()] }),
    credentials: {
      async mint() {
        token = `smrt_mcp_${randomBytes(32).toString('base64url')}`;
        minted.push(token);
        return token;
      },
      async revoke() {
        revoked += 1;
        token = null;
      },
    },
    stateDir: async () => stateDir,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: stateDir,
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      OPENAI_API_KEY: 'sk-openai-leak',
      CODEX_API_KEY: 'codex-leak',
      SMRT_AI_API_KEY: 'smrt-leak',
      SMRT_SECRET_MASTER_KEY: 'master-leak',
    },
    ...extra,
  };
  return { deps, stateDir };
}
function threadHost(text: string, messages: AgentTurnMessage[]): AgentTurnHost {
  return {
    appendMessage: async (message) => {
      messages.push(message);
    },
    lastSession: async () => {
      for (const message of messages.toReversed()) {
        if (message.meta && 'cliSession' in message.meta)
          return message.meta.cliSession.id;
      }
      return null;
    },
    guidance: async () => ({
      systemPrompt: 'Use only this app tools.',
      prompt: text,
    }),
    allowTool: (name) => name !== 'approval_decide',
    approvals: { subscribe: () => () => {}, get: async () => null },
    describeResult: async ({ text }) => ({ summary: text }),
  };
}
async function turn(
  tool: AgentTool,
  text: string,
  options: {
    deps?: AgentEngineDeps;
    signal?: AbortSignal;
    onEvent?: (e: TurnEvent) => void;
  } = {},
) {
  return runOn(
    tool,
    text,
    options.deps ?? setup(tool).deps,
    { messages: [] },
    options,
  );
}
async function runOn(
  tool: AgentTool,
  text: string,
  deps: AgentEngineDeps,
  thread: { messages: AgentTurnMessage[] },
  options: { signal?: AbortSignal; onEvent?: (e: TurnEvent) => void } = {},
) {
  const events: TurnEvent[] = [];
  const stop = await runAgentTurn({
    text,
    tool,
    mcpUrl: 'http://127.0.0.1:4801/mcp',
    deps,
    signal: options.signal ?? new AbortController().signal,
    emit: (e) => {
      events.push(e);
      options.onEvent?.(e);
    },
    host: threadHost(text, thread.messages),
  });
  return { events, stop, thread };
}
const textOf = (events: TurnEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
const waitFor = async <T>(fn: () => T | undefined | false, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
describe.each(['claude-code', 'codex'] as const)('%s engine', (tool) => {
  it('streams text and ends complete', async () => {
    const { events, stop } = await turn(tool, 'say hello there');
    expect(textOf(events)).toBe('hello there');
    expect(stop).toBe('complete');
    expect(events.at(-1)).toEqual({ type: 'done', stop: 'complete' });
  });

  it('keeps the conversation: the next turn resumes the tool’s session', async () => {
    const { deps } = setup(tool);
    const first = await turn(tool, 'resume', { deps });
    const firstText = textOf(first.events);
    expect(firstText.startsWith('new:')).toBe(true);
    const second = await runOn(tool, 'resume', deps, first.thread);
    expect(textOf(second.events)).toBe(`resumed:${firstText.slice(4)}`);
    // The thread shows both exchanges, nothing engine-specific.
    const view = first.thread.messages;
    expect(view.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('cancel kills the CLI and its helpers', async () => {
    const { deps, stateDir } = setup(tool);
    const controller = new AbortController();
    const run = turn(tool, 'hang', { deps, signal: controller.signal });
    const pidsFile = join(stateDir, 'pids.json');
    await waitFor(() => existsSync(pidsFile));
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as {
      child: number;
      grand: number;
    };
    expect(alive(pids.child) && alive(pids.grand)).toBe(true);
    controller.abort();
    const { stop } = await run;
    expect(stop).toBe('aborted');
    await waitFor(() => !alive(pids.child) && !alive(pids.grand));
  });

  it('a timeout kills the whole tree and says so', async () => {
    const { deps, stateDir } = setup(tool, { limits: { turnTimeoutMs: 600 } });
    const { events, stop } = await turn(tool, 'hang', { deps });
    expect(stop).toBe('timeout');
    expect(events.some((e) => e.type === 'error' && e.code === 'timeout')).toBe(
      true,
    );
    const pids = JSON.parse(readFileSync(join(stateDir, 'pids.json'), 'utf8'));
    await waitFor(() => !alive(pids.child) && !alive(pids.grand));
  });

  it('the CLI gets neither provider keys nor the token on its command line', async () => {
    const { deps, stateDir } = setup(tool);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, thread } = await turn(tool, 'dump', { deps });
    const dump = JSON.parse(
      readFileSync(join(stateDir, 'dump.json'), 'utf8'),
    ) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
    };
    const token = minted.at(-1) as string;
    expect(Object.keys(dump.env)).not.toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY']),
    );
    const names = Object.keys(dump.env).join(' ');
    expect(names).not.toMatch(/ANTHROPIC|OPENAI|CODEX_API|SMRT_AI|MASTER/);
    expect(dump.env.SMRT_SHELL_MCP_TOKEN).toBe(token);
    expect(dump.argv.join(' ')).not.toContain(token);
    expect(
      dump.cwd.endsWith(join('agent-state-', '')) || dump.cwd.includes('work'),
    ).toBe(true);
    // not in any event, stored message or log line either
    const everywhere = JSON.stringify([
      events,
      thread.messages,
      log.mock.calls,
    ]);
    expect(everywhere).not.toContain(token);
    expect(everywhere).not.toMatch(/leak/);
  });

  it('stops at once if a tool outside the shell’s own appears', async () => {
    const { deps, stateDir } = setup(tool);
    const { events, stop } = await turn(tool, 'forbidden', { deps });
    expect(stop).toBe('error');
    expect(
      events.some((e) => e.type === 'error' && e.code === 'agent_tool_blocked'),
    ).toBe(true);
    expect(existsSync(join(stateDir, 'pids.json'))).toBe(false);
  });

  it('a failing CLI is a plain error with none of its output', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, stop } = await turn(tool, 'fail');
    expect(stop).toBe('error');
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ code: 'agent_cli_failed' });
    expect(JSON.stringify([events, log.mock.calls])).not.toContain(
      'secret-in-stderr',
    );
  });

  it('reports required MCP startup failures without disclosing child diagnostics', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, stop } = await turn(tool, 'mcp-fail');
    expect(stop).toBe('error');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'agent_mcp_unavailable',
      message: expect.stringMatching(/app's tools.*Reference:/),
    });
    expect(log).toHaveBeenCalledWith(
      '[smrt-inference] local engine failure',
      expect.objectContaining({ code: 'agent_mcp_unavailable' }),
    );
    expect(JSON.stringify([events, log.mock.calls])).not.toContain(
      'secret-in-stderr',
    );
    expect(live()).toBeNull();
  });

  it('revokes the token when the turn ends, however it ends', async () => {
    const before = revoked;
    await turn(tool, 'say ok');
    await turn(tool, 'fail');
    expect(revoked).toBe(before + 2);
    expect(live()).toBeNull();
  });

  it('a missing CLI is a typed error before anything runs', async () => {
    const { deps } = setup(tool, { locate: async () => null });
    const { events, stop } = await turn(tool, 'say hi', { deps });
    expect(stop).toBe('error');
    expect(events[0]).toMatchObject({
      type: 'error',
      code: 'agent_cli_missing',
    });
  });
});

describe('host failures release credentials', () => {
  it('revokes a minted token even when subscribing throws', async () => {
    const { deps } = setup('codex');
    const host = threadHost('say hi', []);
    const error = new Error('host unavailable');
    host.approvals.subscribe = () => {
      throw error;
    };
    const before = revoked;
    await expect(
      runAgentTurn({
        text: 'say hi',
        tool: 'codex',
        mcpUrl: 'http://127.0.0.1:4801/mcp',
        signal: new AbortController().signal,
        emit: () => {},
        deps,
        host,
      }),
    ).rejects.toBe(error);
    expect(revoked).toBe(before + 1);
  });

  it('stops the child and revokes when a stream callback throws', async () => {
    const { deps, stateDir } = setup('codex');
    const host = threadHost('hang-text', []);
    const error = new Error('host unavailable');
    const before = revoked;
    await expect(
      runAgentTurn({
        text: 'say hi',
        tool: 'codex',
        mcpUrl: 'http://127.0.0.1:4801/mcp',
        signal: new AbortController().signal,
        emit: (event) => {
          if (event.type === 'text') throw error;
        },
        deps,
        host,
      }),
    ).rejects.toBe(error);
    expect(revoked).toBe(before + 1);
    const pids = JSON.parse(readFileSync(join(stateDir, 'pids.json'), 'utf8'));
    await waitFor(() => !alive(pids.child) && !alive(pids.grand));
  });

  it('refuses a remote endpoint and revokes without starting the child', async () => {
    const { deps, stateDir } = setup('codex');
    const before = revoked;
    await expect(
      runAgentTurn({
        text: 'dump',
        tool: 'codex',
        mcpUrl: 'http://evil.example/mcp',
        signal: new AbortController().signal,
        emit: () => {},
        deps,
        host: threadHost('dump', []),
      }),
    ).rejects.toThrow();
    expect(revoked).toBe(before + 1);
    expect(existsSync(join(stateDir, 'dump.json'))).toBe(false);
  });
});

// A fake MCP endpoint proves the contract without a dependency on any host app.
it('stops Codex on a disabled tool host before publishing a fallback answer', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { events, stop, thread } = await turn('codex', 'host-disabled');
  expect(stop).toBe('error');
  expect(events.find((e) => e.type === 'error')).toMatchObject({
    code: 'tool_host_policy',
    message: expect.stringMatching(/security settings.*Reference:/),
  });
  expect(events.some((e) => e.type === 'text')).toBe(false);
  expect(JSON.stringify([events, thread.messages, log.mock.calls])).not.toMatch(
    /secret-in-host-error|This answer must never be published/,
  );
  expect(log).toHaveBeenCalledWith(
    '[smrt-inference] local engine failure',
    expect.objectContaining({ code: 'tool_host_policy' }),
  );
  expect(live()).toBeNull();
});

it.each(
  (['claude-code', 'codex'] as const).flatMap((tool) =>
    (['pending', 'approved', 'denied'] as const).map((decision) => ({
      tool,
      decision,
    })),
  ),
)('$tool correlates a canonical hold when its decision is $decision before the result', async ({
  tool,
  decision,
}) => {
  const { deps } = setup(tool);
  const messages: AgentTurnMessage[] = [];
  const host = threadHost('tool record_delete {"id":"record-1"}', messages);
  let pending:
    | Parameters<Parameters<AgentTurnHost['approvals']['subscribe']>[0]>[0]
    | undefined;
  let listener:
    | Parameters<AgentTurnHost['approvals']['subscribe']>[0]
    | undefined;
  const unsubscribe = vi.fn();
  host.approvals = {
    subscribe: (fn) => {
      listener = fn;
      return unsubscribe;
    },
    get: async (id) =>
      pending
        ? {
            id,
            status: pending.status,
            summary: 'Delete record?',
            preview: { id: 'record-1' },
          }
        : null,
  };
  host.describeResult = async ({ approvalId }) => ({
    summary: approvalId ? 'Waiting for your decision' : 'Done',
    details: { hostTag: 'host-value' },
  });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.params).toMatchObject({
      name: 'record_delete',
      arguments: { id: 'record-1' },
    });
    pending = { id: 'approval-1', status: 'pending' };
    listener?.(pending);
    // The independent owner's decision can win the response-parsing race.
    pending = { ...pending, status: decision };
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'pending_approval' }] },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const events: TurnEvent[] = [];
  try {
    const stop = await runAgentTurn({
      text: 'delete record',
      tool,
      deps,
      mcpUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      host,
    });
    expect(stop).toBe(decision === 'pending' ? 'waiting' : 'complete');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({
      name: 'record_delete',
      args: '{"id":"record-1"}',
    });
    expect(events.find((e) => e.type === 'approval_required')).toMatchObject({
      approvalId: 'approval-1',
      summary: 'Delete record?',
      preview: { id: 'record-1' },
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      name: 'record_delete',
      ok: true,
      summary: 'Waiting for your decision',
      details: { hostTag: 'host-value' },
    });
    expect(messages.find((m) => m.role === 'tool')?.meta).toMatchObject({
      approvalId: 'approval-1',
      hostTag: 'host-value',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(live()).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  'LocalRuntimeError',
  'private-token-from-name',
])('token mint failures with %s report only a stable code and fixed words', async (name) => {
  const { deps } = setup('codex');
  const error = Object.assign(new Error('secret in token store error'), {
    name,
    code: 'invalid_scope',
  });
  deps.credentials.mint = async () => {
    throw error;
  };
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { events, stop } = await turn('codex', 'say hi', { deps });
  expect(stop).toBe('error');
  expect(events[0]).toMatchObject({ type: 'error', code: 'agent_cli_token' });
  expect(JSON.stringify(events)).toContain('permission');
  expect(logged).toHaveBeenCalledWith(
    '[smrt-inference] local engine failure',
    expect.objectContaining({
      phase: 'credential',
      code: 'invalid_scope',
      reference: expect.stringMatching(/^[a-f0-9-]{36}$/),
    }),
  );
  expect(JSON.stringify(events)).toContain(logged.mock.calls[0][1].reference);
  if (name === 'LocalRuntimeError')
    expect(logged).toHaveBeenCalledWith(
      'assistant token failed:',
      'LocalRuntimeError',
      'invalid_scope',
    );
  else
    expect(logged).not.toHaveBeenCalledWith(
      'assistant token failed:',
      expect.anything(),
      expect.anything(),
    );
  expect(JSON.stringify([events, logged.mock.calls])).not.toContain(
    'private-token-from-name',
  );
  expect(JSON.stringify([events, logged.mock.calls])).not.toContain(
    'secret in token store error',
  );
});
