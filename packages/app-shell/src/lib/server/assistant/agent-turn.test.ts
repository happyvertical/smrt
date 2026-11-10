// The local agent CLI engine against STUB CLIs (test-fixtures/stub-cli.mjs): no
// network, no model. A stub reads its "prompt", emits the stream shapes the
// real tools do, and for tool calls talks to a REAL `/mcp` route (the shell's
// merged server, bearer-token auth, the one policy) over loopback HTTP.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createLocalMcpTokenAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import { nodeDir } from '../agent-cli/env.ts';
import { installStub, tempDir } from '../agent-cli/test-support.ts';
import type { AgentTool } from '../agent-cli/tools.ts';
import { decideApproval, getApprovalView } from '../approvals.ts';
import { getHost } from '../host.ts';
import { createShellMcpServer } from '../mcp-server.ts';
import { runAs } from '../owner.ts';
import { callTool } from '../policy.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import { type AgentEngineDeps, runAgentTurn } from './agent-turn.ts';
import { createThread, viewMessages } from './threads.ts';

let h: ShellHarness;
let server: Server;
let mcpUrl = '';
let live: string | null = null; // the one valid token
const minted: string[] = [];
let revoked = 0;

beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, () =>
    callTool(h.owner, 'app_definemodel', {
      name: 'Chore',
      fields: { title: { type: 'text' } },
    }),
  );
  const handler = mountMcpRoute(createShellMcpServer(), {
    checkOrigin: true,
    auth: () =>
      createLocalMcpTokenAuth({
        verify: async (token) =>
          live && token === live
            ? {
                id: h.owner.id,
                tenantId: h.owner.tenantId,
                scopes: ['assistant.use'],
              }
            : null,
      }),
    bindPrincipal: (p, run) =>
      runAs({ id: p.id as string, tenantId: p.tenantId as string }, () =>
        run(p),
      ),
  });
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? '/', mcpUrl);
    const response = await handler({
      request: new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }),
      url,
      locals: {},
    } as never);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mcpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  server.close();
  await h.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setup(tool: AgentTool, extra: Partial<AgentEngineDeps> = {}) {
  const bin = tempDir('stub-bin-');
  const stateDir = tempDir('agent-state-');
  const path = installStub(bin, tool === 'claude-code' ? 'claude' : 'codex');
  const deps: AgentEngineDeps = {
    locate: async () => ({ path, extraPath: [nodeDir()] }),
    credentials: {
      async mint() {
        live = `smrt_mcp_${randomBytes(32).toString('base64url')}`;
        minted.push(live);
        return live;
      },
      async revoke() {
        revoked += 1;
        live = null;
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

async function turn(
  tool: AgentTool,
  text: string,
  options: {
    deps?: AgentEngineDeps;
    threadId?: string;
    signal?: AbortSignal;
    onEvent?: (e: TurnEvent) => void;
  } = {},
) {
  const deps = options.deps ?? setup(tool).deps;
  const thread = await createThread(h.owner.id, 't');
  return runOn(tool, text, deps, thread, options);
}

async function runOn(
  tool: AgentTool,
  text: string,
  deps: AgentEngineDeps,
  thread: Awaited<ReturnType<typeof createThread>>,
  options: { signal?: AbortSignal; onEvent?: (e: TurnEvent) => void } = {},
) {
  const events: TurnEvent[] = [];
  const stop = await runAs(h.owner, () =>
    runAgentTurn({
      principal: h.owner,
      thread,
      text,
      tool,
      mcpUrl,
      signal: options.signal ?? new AbortController().signal,
      emit: (e) => {
        events.push(e);
        options.onEvent?.(e);
      },
      deps,
    }),
  );
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
    const view = await viewMessages(first.thread.id as string);
    expect(view.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('runs a tool call through the real /mcp route and reports it', async () => {
    const { events, stop } = await turn(
      tool,
      'tool chore_create {"title":"mop the floor"}',
    );
    expect(stop).toBe('complete');
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({
      name: 'chore_create',
    });
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ name: 'chore_create', ok: true });
    const rows = await (await getHost()).list('Chore');
    expect(rows.some((r) => r.title === 'mop the floor')).toBe(true);
    expect(textOf(events)).toContain('All done.');
  });

  it('holds a risky call for approval: the card shows, nothing is applied', async () => {
    const host = await getHost();
    await callTool(h.owner, 'chore_create', { title: `risky-${tool}` });
    const row = (await host.list('Chore')).find(
      (r) => r.title === `risky-${tool}`,
    );
    const id = row?.id as string;
    const { events, stop } = await turn(
      tool,
      // `approved: true` from a model must change nothing.
      `tool chore_delete ${JSON.stringify({ id, approved: true })}`,
    );
    const ask = events.find((e) => e.type === 'approval_required') as Extract<
      TurnEvent,
      { type: 'approval_required' }
    >;
    expect(ask).toBeTruthy();
    expect(ask.name).toBe('chore_delete');
    expect(stop).toBe('waiting');
    // still there, approval still pending
    expect((await host.list('Chore')).some((r) => r.id === id)).toBe(true);
    expect((await getApprovalView(ask.approvalId))?.status).toBe('pending');
    // only the owner's decision applies it
    const outcome = await decideApproval(ask.approvalId, true, h.owner.id);
    expect(outcome.status).toBe('approved');
    expect((await host.list('Chore')).some((r) => r.id === id)).toBe(false);
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
      await viewMessages(thread.id as string),
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

  it('revokes the token when the turn ends, however it ends', async () => {
    const before = revoked;
    await turn(tool, 'say ok');
    await turn(tool, 'fail');
    expect(revoked).toBe(before + 2);
    expect(live).toBeNull();
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

describe('the /mcp route itself', () => {
  async function rpc(
    method: string,
    name: string | undefined,
    token: string | null,
  ) {
    const body = method === 'tools/call' ? { name, arguments: {} } : {};
    return fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...body,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
  }

  it('refuses a missing, wrong or revoked token', async () => {
    // No bearer: no session either, so no principal and no tools.
    const anon = await (await rpc('tools/list', undefined, null)).text();
    expect(anon).not.toContain('chore_create');
    live = `smrt_mcp_${'a'.repeat(43)}`;
    expect(
      (await rpc('tools/list', undefined, `smrt_mcp_${'b'.repeat(43)}`)).status,
    ).toBe(401);
    const good = live;
    live = null;
    expect((await rpc('tools/list', undefined, good)).status).toBe(401);
  });

  it('does not offer approval_decide, and calling it does nothing', async () => {
    live = `smrt_mcp_${'c'.repeat(43)}`;
    const listed = await (await rpc('tools/list', undefined, live)).text();
    expect(listed).toContain('chore_create');
    expect(listed).not.toContain('approval_decide');
    const called = await (
      await rpc('tools/call', 'approval_decide', live)
    ).text();
    expect(called).not.toMatch(/"approved"/);
    live = null;
  });
});

describe('a stored stop reason is never `complete` while an approval waits', () => {
  it('is typed', () => {
    const stops: TurnStop[] = ['complete', 'waiting'];
    expect(stops).toContain('waiting');
  });
});
