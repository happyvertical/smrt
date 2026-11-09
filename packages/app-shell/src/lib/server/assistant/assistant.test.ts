import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TurnEvent } from '../../assistant/events.ts';
import { ApprovalCollection } from '../../objects/Approval.ts';
import { listApprovalViews } from '../approvals.ts';
import { getHost, getShellDb } from '../host.ts';
import { createShellMcpServer } from '../mcp-server.ts';
import { callTool } from '../policy.ts';
import { openShell, runAs, type ShellHarness } from '../test-support.ts';
import {
  AssistantNotConfiguredError,
  assertApiKeyProvider,
  resolveAssistantOptions,
  SubscriptionProviderError,
} from './config.ts';
import { holdForUser } from './hold.ts';
import { call, drive, say, scripted } from './test-helpers.ts';
import {
  appendMessage,
  createThread,
  historyFor,
  viewMessages,
} from './threads.ts';
import { ASSISTANT_DENIED_TOOLS, assistantTools } from './turn.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

const mcp = (p: { id: string; tenantId: string }) => ({
  id: p.id,
  tenantId: p.tenantId,
  kind: 'human',
  scopes: [] as string[],
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const text = (r: { content: unknown }) =>
  (r.content as { text: string }[])[0].text;

async function decide(approvalId: string, approve: boolean) {
  const row = await (
    await ApprovalCollection.create({ db: await getShellDb() })
  ).get(approvalId);
  if (!row) throw new Error('no approval');
  return runAs(h.owner, () => row.decide(approve));
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(10);
  }
}

describe('the model sees only the owner allow-list', () => {
  it('offers the owner builder tools and app tools, not approval_decide', async () => {
    await runAs(h.owner, () =>
      callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      }),
    );
    const names = (await assistantTools(h.owner)).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'app_definemodel',
        'app_describe',
        'chore_create',
        'chore_list',
        'chore_delete',
      ]),
    );
    for (const denied of ASSISTANT_DENIED_TOOLS)
      expect(names).not.toContain(denied);
    expect(names).not.toContain('approval_decide');
  });

  it('gives a non-owner and nobody no tools, and runs nothing for them', async () => {
    expect(await assistantTools(h.member)).toEqual([]);
    const seen: string[][] = [];
    const { model } = scripted([
      (r) => {
        seen.push(r.tools.map((t) => t.function.name));
        return say('', call('chore_create', { title: 'sneak' }));
      },
      () => say('done'),
    ]);
    const { events } = await drive({ principal: h.member, model });
    expect(seen[0]).toEqual([]);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect((await (await getHost()).list('Chore')).length).toBe(0);
  });

  it('refuses a tool that was not offered, before dispatch', async () => {
    const { model } = scripted([
      () =>
        say(
          '',
          call('does_not_exist', {}),
          call('approval_decide', { id: 'x', approve: true }),
        ),
      () => say('ok'),
    ]);
    const { events, stop } = await drive({ principal: h.owner, model });
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).toMatchObject({ ok: false });
    expect(stop).toBe('complete');
  });

  it('refuses malformed arguments without running the tool', async () => {
    const { model } = scripted([
      () => say('', call('chore_create', '{not json')),
      () => say('ok'),
    ]);
    const { events } = await drive({ principal: h.owner, model });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({
      ok: false,
    });
    expect((await (await getHost()).list('Chore')).length).toBe(0);
  });
});

describe('risky calls wait for the owner', () => {
  it('delete: pending, nothing applied, applied only after approve; the turn resumes', async () => {
    const host = await getHost();
    const rec = (await callTool(h.owner, 'chore_create', { title: 'mop' })) as {
      content: unknown;
    };
    const id = JSON.parse(text(rec)).id ?? JSON.parse(text(rec)).result?.id;
    expect(id).toBeTruthy();
    const { model, requests } = scripted([
      () => say('Removing it.', call('chore_delete', { id, approved: true })),
      () => say('All done.'),
    ]);
    const events: TurnEvent[] = [];
    const run = drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const ask = (await waitFor(() =>
      events.find((e) => e.type === 'approval_required'),
    )) as Extract<TurnEvent, { type: 'approval_required' }>;
    // held: nothing deleted, no further model call, turn not finished
    await tick(50);
    expect((await host.list('Chore')).length).toBe(1);
    expect(requests).toHaveLength(1);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    const outcome = await decide(ask.approvalId, true);
    expect(outcome.status).toBe('approved');
    const { stop } = await run;
    expect(stop).toBe('complete');
    expect((await host.list('Chore')).length).toBe(0);
    expect(requests).toHaveLength(2);
    const told = JSON.stringify(requests[1].messages.at(-1));
    expect(told).toContain('approved');
    expect(events.find((e) => e.type === 'approval_decided')).toMatchObject({
      status: 'approved',
    });
  });

  it('deny: stays unapplied and the model is told it was denied', async () => {
    const host = await getHost();
    await callTool(h.owner, 'chore_create', { title: 'dust' });
    const id = (await host.list('Chore'))[0].id as string;
    const { model, requests } = scripted([
      () => say('', call('chore_delete', { id })),
      () => say('Understood.'),
    ]);
    const events: TurnEvent[] = [];
    const run = drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const ask = (await waitFor(() =>
      events.find((e) => e.type === 'approval_required'),
    )) as Extract<TurnEvent, { type: 'approval_required' }>;
    await decide(ask.approvalId, false);
    expect((await run).stop).toBe('complete');
    expect((await host.list('Chore')).length).toBe(1);
    expect(JSON.stringify(requests[1].messages.at(-1))).toContain('denied');
  });

  it('a risky builder method (removeField) waits too, and applies only on approve', async () => {
    const host = await getHost();
    await callTool(h.owner, 'app_addfield', {
      model: 'Chore',
      field: 'points',
      definition: { type: 'text' },
    });
    const { model } = scripted([
      () =>
        say('', call('app_removefield', { model: 'Chore', field: 'points' })),
      () => say('done'),
    ]);
    const events: TurnEvent[] = [];
    const run = drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const ask = (await waitFor(() =>
      events.find((e) => e.type === 'approval_required'),
    )) as Extract<TurnEvent, { type: 'approval_required' }>;
    expect(host.describe().models.Chore.fields).toHaveProperty('points');
    await decide(ask.approvalId, true);
    await run;
    expect(host.describe().models.Chore.fields).not.toHaveProperty('points');
  });

  it('a held turn that is aborted leaves the approval pending and unapplied', async () => {
    const host = await getHost();
    const id = (await host.list('Chore'))[0].id as string;
    const ctl = new AbortController();
    const { model } = scripted([() => say('', call('chore_delete', { id }))]);
    const events: TurnEvent[] = [];
    const run = drive({
      principal: h.owner,
      model,
      signal: ctl.signal,
      onEvent: (e) => events.push(e),
    });
    const ask = (await waitFor(() =>
      events.find((e) => e.type === 'approval_required'),
    )) as Extract<TurnEvent, { type: 'approval_required' }>;
    ctl.abort();
    expect((await run).stop).toBe('aborted');
    expect((await host.list('Chore')).length).toBe(1);
    const pending = await listApprovalViews({ status: 'pending' });
    expect(pending.map((p) => p.id)).toContain(ask.approvalId);
    await decide(ask.approvalId, false);
  });

  it('a hold that times out ends the turn as waiting, nothing applied', async () => {
    const host = await getHost();
    const id = (await host.list('Chore'))[0].id as string;
    const { model } = scripted([() => say('', call('chore_delete', { id }))]);
    const { stop, events } = await drive({
      principal: h.owner,
      model,
      limits: { holdTimeoutMs: 40 },
    });
    expect(stop).toBe('waiting');
    expect(events.find((e) => e.type === 'approval_decided')).toMatchObject({
      status: 'timeout',
    });
    expect((await host.list('Chore')).length).toBe(1);
    for (const p of await listApprovalViews({ status: 'pending' }))
      await decide(p.id, false);
  });
});

describe('holdForUser', () => {
  it('pauses until the decision, then resumes with the outcome', async () => {
    const host = await getHost();
    const id = (await host.list('Chore'))[0].id as string;
    const pending = JSON.parse(
      text(await callTool(h.owner, 'chore_delete', { id })),
    );
    const approvalId = pending.approvalId ?? pending.result?.approvalId;
    let resolved = false;
    const held = holdForUser(approvalId, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    }).then((o) => {
      resolved = true;
      return o;
    });
    await tick(60);
    expect(resolved).toBe(false);
    await decide(approvalId, false);
    expect(await held).toEqual({ status: 'denied' });
  });

  it('resolves immediately for an approval already decided', async () => {
    const [done] = await listApprovalViews({ status: 'denied' });
    expect(
      await holdForUser(done.id, {
        signal: new AbortController().signal,
        timeoutMs: 1000,
      }),
    ).toEqual({ status: 'denied' });
  });
});

describe('a stubbed turn builds and uses the app', () => {
  it('defines a model, then creates a record', async () => {
    const { model, requests } = scripted([
      () =>
        say(
          'I will add Plants.',
          call('app_definemodel', {
            name: 'Plant',
            fields: { name: { type: 'text' } },
          }),
        ),
      // the new model's tools exist only after the first step
      (r) => {
        expect(r.tools.map((t) => t.function.name)).toContain('plant_create');
        return say('', call('plant_create', { name: 'Fern' }));
      },
      () => say('Added a Plant called Fern.'),
    ]);
    const { events, stop, threadId } = await drive({
      principal: h.owner,
      model,
      text: 'track my plants',
    });
    expect(stop).toBe('complete');
    expect(requests).toHaveLength(3);
    const names = events
      .filter((e) => e.type === 'tool_call')
      .map((e) => (e as { name: string }).name);
    expect(names).toEqual(['app_definemodel', 'plant_create']);
    expect(
      events
        .filter((e) => e.type === 'tool_result')
        .every((e) => (e as { ok: boolean }).ok),
    ).toBe(true);
    const listed = await callTool(h.owner, 'plant_list', {});
    expect(text(listed)).toContain('Fern');
    // persisted and replayable
    const shown = await viewMessages(threadId);
    expect(shown.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ]);
    expect(shown[0].content).toBe('track my plants');
    expect(shown.at(-1)?.content).toContain('Fern');
    const replay = await historyFor(threadId);
    expect(replay[0]).toMatchObject({ role: 'user' });
    expect(replay.filter((m) => m.role === 'tool')).toHaveLength(2);
  });
});

describe('the turn is bounded', () => {
  it('stops at max steps', async () => {
    const { model, requests } = scripted([
      () => say('', call('app_describe', {})),
    ]);
    const { stop, events } = await drive({
      principal: h.owner,
      model,
      limits: { maxSteps: 3 },
    });
    expect(stop).toBe('max_steps');
    expect(requests).toHaveLength(3);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3);
  });

  it('stops at the token cap', async () => {
    const { model, requests } = scripted([
      () => ({ ...say('', call('app_describe', {})), totalTokens: 500 }),
    ]);
    const { stop } = await drive({
      principal: h.owner,
      model,
      limits: { maxTotalTokens: 900 },
    });
    expect(stop).toBe('max_tokens');
    expect(requests).toHaveLength(2);
  });

  it('honors only the first N calls of a step and runs them in order', async () => {
    const order: string[] = [];
    const { model } = scripted([
      () =>
        say(
          '',
          call('app_describe', {}),
          call('app_history', {}),
          call('app_describe', {}),
        ),
      () => say('ok'),
    ]);
    const { events } = await drive({
      principal: h.owner,
      model,
      limits: { maxToolCallsPerStep: 2 },
      onEvent: (e) => {
        if (e.type === 'tool_call' || e.type === 'tool_result')
          order.push(`${e.type}:${e.name}`);
      },
    });
    expect(order).toEqual([
      'tool_call:app_describe',
      'tool_result:app_describe',
      'tool_call:app_history',
      'tool_result:app_history',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete' });
  });

  it('times out a model call that never answers', async () => {
    const { model } = scripted([
      (r) =>
        new Promise((_, reject) =>
          r.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    ]);
    const { stop, events } = await drive({
      principal: h.owner,
      model,
      limits: { modelTimeoutMs: 40 },
    });
    expect(stop).toBe('timeout');
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      code: 'timeout',
    });
  });

  it('aborts when the client disconnects mid-call', async () => {
    const ctl = new AbortController();
    const { model } = scripted([
      (r) =>
        new Promise((_, reject) => {
          r.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
          setTimeout(() => ctl.abort(), 20);
        }),
    ]);
    const { stop } = await drive({
      principal: h.owner,
      model,
      signal: ctl.signal,
    });
    expect(stop).toBe('aborted');
  });

  it('streams text deltas and sends a full reply once when the model does not stream', async () => {
    const streaming = scripted([
      (r) => {
        r.onText('Hel');
        r.onText('lo');
        return say('Hello');
      },
    ]);
    const a = await drive({ principal: h.owner, model: streaming.model });
    expect(
      a.events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta),
    ).toEqual(['Hel', 'lo']);
    const plain = scripted([() => say('Hi there')]);
    const b = await drive({ principal: h.owner, model: plain.model });
    expect(b.events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: 'Hi there' },
    ]);
  });

  it('turns a model failure into a plain error with no provider detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { model } = scripted([
      () => {
        throw new Error('401 invalid x-api-key sk-ant-SECRETKEY123');
      },
    ]);
    const { stop, events } = await drive({ principal: h.owner, model });
    expect(stop).toBe('error');
    expect(JSON.stringify(events)).not.toContain('SECRETKEY123');
    expect(JSON.stringify(spy.mock.calls)).not.toContain('SECRETKEY123');
    spy.mockRestore();
  });
});

describe('API key only, never a subscription login', () => {
  it('refuses subscription provider ids', () => {
    for (const id of [
      'claude-cli',
      'chatgpt-plan',
      ' Claude-CLI ',
      'CHATGPT_PLAN',
    ])
      expect(() => assertApiKeyProvider(id)).toThrow(SubscriptionProviderError);
    for (const id of ['anthropic', 'openai', 'gemini', undefined, ''])
      expect(() => assertApiKeyProvider(id)).not.toThrow();
  });

  it('refuses them from config and env, and reports not configured with no key', async () => {
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
    await expect(
      resolveAssistantOptions(h.owner, { env: {} }),
    ).rejects.toBeInstanceOf(AssistantNotConfiguredError);
    const ok = await resolveAssistantOptions(h.owner, {
      env: { ANTHROPIC_API_KEY: 'sk-test-key' },
    });
    expect(ok.provider ?? ok.type).toBe('anthropic');
  });

  it('has no code path that spawns a CLI or reads a login', () => {
    const dir = import.meta.dirname;
    for (const name of readdirSync(dir)) {
      if (!/\.ts$/.test(name) || /\.test\.ts$|test-helpers/.test(name))
        continue;
      const src = readFileSync(join(dir, name), 'utf8');
      expect(src, name).not.toMatch(/child_process|spawn\(|execFile|claude -p/);
    }
  });
});

describe('outside agents get the same rules', () => {
  it('an external MCP client and the assistant reach the same pending approval, and neither applies it', async () => {
    const host = await getHost();
    await callTool(h.owner, 'chore_create', { title: 'wipe' });
    const id = (await host.list('Chore'))[0].id as string;
    const server = createShellMcpServer();
    const viaMcp = await server.callTool({
      name: 'chore_delete',
      arguments: { id },
      principal: mcp(h.owner),
    });
    const pendingMcp = JSON.parse(text(viaMcp as never));
    expect(pendingMcp.status).toBe('pending_approval');
    const { model } = scripted([
      () => say('', call('chore_delete', { id })),
      () => say('ok'),
    ]);
    const events: TurnEvent[] = [];
    const run = drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const ask = (await waitFor(() =>
      events.find((e) => e.type === 'approval_required'),
    )) as Extract<TurnEvent, { type: 'approval_required' }>;
    expect(ask.approvalId).toBe(pendingMcp.approvalId);
    expect(ask.summary).toBe(pendingMcp.summary);
    expect((await host.list('Chore')).length).toBeGreaterThan(0);
    await decide(ask.approvalId, false);
    await run;
  });

  it('a non-owner gets nothing from either door', async () => {
    const server = createShellMcpServer();
    expect(await server.listTools({ principal: mcp(h.member) })).toEqual([]);
    await expect(
      server.callTool({
        name: 'chore_list',
        arguments: {},
        principal: mcp(h.member),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await assistantTools(h.member)).toEqual([]);
  });

  it('neither the assistant nor the owner’s MCP client has approval_decide', async () => {
    const server = createShellMcpServer();
    const names = (await server.listTools({ principal: mcp(h.owner) })).map(
      (t) => t.name,
    );
    expect(names).not.toContain('approval_decide');
    expect((await assistantTools(h.owner)).map((t) => t.name)).not.toContain(
      'approval_decide',
    );
  });
});

describe('thread history', () => {
  it('drops a tool call that never got a result and a result with no call', async () => {
    const thread = await createThread(h.owner.id, 'edge');
    await appendMessage(thread, { role: 'user', content: 'hi' });
    await appendMessage(thread, {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
      ],
    });
    await appendMessage(thread, { role: 'user', content: 'again' });
    await appendMessage(thread, {
      role: 'tool',
      content: '{}',
      toolCallId: 'zzz',
    });
    const replay = await historyFor(thread.id as string);
    expect(replay.map((m) => m.role)).toEqual(['user', 'user']);
  });
});
