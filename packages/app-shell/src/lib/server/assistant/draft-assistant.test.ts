// The assistant and drafts: it builds only in the draft, never holds for a
// per-change approval there, follows the owner's view for records, says which
// copy it changed, and never publishes by itself. API engine (scripted stub
// model) and the local CLI engines (stub CLIs against a real /mcp handler).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TurnEvent } from '../../assistant/events.ts';
import { ApprovalCollection } from '../../objects/Approval.ts';
import { nodeDir } from '../agent-cli/env.ts';
import { installStub, tempDir } from '../agent-cli/test-support.ts';
import type { AgentTool } from '../agent-cli/tools.ts';
import { getApprovalView, listApprovalViews } from '../approvals.ts';
import { discardNow, startDraft } from '../drafts.ts';
import { getDraftSlot, getHost, getShellDb, hostFor } from '../host.ts';
import { type Principal, runAs } from '../owner.ts';
import { callTool } from '../policy.ts';
import { openShell, type ShellHarness } from '../test-support.ts';
import { writeView } from '../view.ts';
import { type AgentEngineDeps, runAgentTurn } from './agent-turn.ts';
import { modeLine, systemPrompt } from './guidance.ts';
import { assistantScope } from './scope.ts';
import { call, drive, say, scripted } from './test-helpers.ts';
import { startTestMcp, type TestMcp } from './test-mcp.ts';
import { createThread, viewMessages } from './threads.ts';

let h: ShellHarness;
let mcp: TestMcp;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, () =>
    callTool(h.owner, 'app_definemodel', {
      name: 'Chore',
      fields: { title: { type: 'text' }, points: { type: 'text' } },
    }),
  );
  await (await getHost()).create('Chore', { title: 'live-1' });
  mcp = await startTestMcp(h.owner, (p) => assistantScope(p as Principal));
});
afterAll(async () => {
  await mcp.close();
  await h.close();
});

const titles = async (target: 'live' | 'draft') =>
  (await (await hostFor(target)).list('Chore'))
    .map((r) => String(r.title))
    .sort();
const textOf = (events: TurnEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
async function decide(approvalId: string, approve: boolean) {
  const row = await (
    await ApprovalCollection.create({ db: await getShellDb() })
  ).get(approvalId);
  if (!row) throw new Error('no approval');
  return runAs(h.owner, () => row.decide(approve));
}

describe('the mode line', () => {
  it('says which copies the model works on, in plain words', () => {
    const none = modeLine({
      draft: null,
      scope: { records: 'live', structure: 'live' },
    });
    expect(none).toMatch(/no draft is open/);
    const live = modeLine({
      draft: 'Spring',
      scope: { records: 'live', structure: 'draft' },
    });
    expect(live).toContain('the draft "Spring" is open');
    expect(live).toMatch(/looking at the LIVE app/);
    expect(live).toContain('app_publishdraft');
    const draft = modeLine({
      draft: 'Spring',
      scope: { records: 'draft', structure: 'draft' },
    });
    expect(draft).toMatch(/looking at the DRAFT/);
    expect(systemPrompt()).toContain('Where you are working right now');
  });
});

describe('API engine (scripted model)', () => {
  it('no draft open: today’s behaviour, a risky change is held for approval', async () => {
    const { model, requests } = scripted([
      () =>
        say('', call('app_removefield', { model: 'Chore', field: 'points' })),
      () => say('ok'),
    ]);
    const events: TurnEvent[] = [];
    const { stop } = await drive({
      principal: h.owner,
      model,
      limits: { holdTimeoutMs: 40 },
      onEvent: (e) => events.push(e),
    });
    expect(stop).toBe('waiting');
    expect(events.some((e) => e.type === 'approval_required')).toBe(true);
    expect(requests[0].messages[0].content).toContain('no draft is open');
    // no copy note and no copy tags when there is no draft
    expect(textOf(events)).not.toMatch(/in the draft/);
    expect(
      events.find((e) => e.type === 'tool_result' && 'copy' in e),
    ).toBeUndefined();
    for (const p of await listApprovalViews({ status: 'pending' }))
      await decide(p.id, false);
  });

  it('a draft open and the owner viewing Live: structure goes to the draft with no hold; records stay live', async () => {
    await startDraft('Assist', h.owner.id);
    const live = await getHost();
    const liveVersion = live.version;
    const { model, requests } = scripted([
      () =>
        say(
          'Working on it.',
          call('app_removefield', { model: 'Chore', field: 'points' }),
          call('chore_create', { title: 'from-assistant' }),
        ),
      () => say('Done.'),
    ]);
    const events: TurnEvent[] = [];
    const { stop, threadId } = await drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    const saved = await viewMessages(threadId);
    expect(
      saved.find((m) => m.tool?.name === 'app_removefield')?.tool?.copy,
    ).toBe('draft');
    expect(saved.find((m) => m.tool?.name === 'chore_create')?.tool?.copy).toBe(
      'live',
    );
    expect(stop).toBe('complete'); // nothing held
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    // the system prompt told it where it is working
    expect(requests[0].messages[0].content).toContain(
      'the draft "Assist" is open',
    );
    expect(requests[0].messages[0].content).toMatch(/looking at the LIVE app/);
    // the structural change is in the draft only
    expect(live.version).toBe(liveVersion);
    expect(Object.keys(live.describe().models.Chore.fields)).toContain(
      'points',
    );
    expect(
      Object.keys((await hostFor('draft')).describe().models.Chore.fields),
    ).not.toContain('points');
    // the record went to the viewed copy: live
    expect(await titles('live')).toEqual(['from-assistant', 'live-1']);
    expect(await titles('draft')).toEqual(['live-1']);
    // each result says which copy, and the model is told too
    const results = events.filter((e) => e.type === 'tool_result') as Extract<
      TurnEvent,
      { type: 'tool_result' }
    >[];
    expect(results.find((r) => r.name === 'app_removefield')?.copy).toBe(
      'draft',
    );
    expect(results.find((r) => r.name === 'chore_create')?.copy).toBe('live');
    expect(JSON.stringify(requests[1].messages)).toContain(
      '[This acted on the draft',
    );
    // the reply tells the person which copy was changed
    expect(textOf(events)).toContain(
      'I made that change in the draft "Assist"',
    );
    expect(textOf(events)).toContain('live app is unchanged');
  });

  it('viewing the draft, record tools land in the draft', async () => {
    await writeView(h.owner, 'draft');
    const { model, requests } = scripted([
      () => say('', call('chore_create', { title: 'draft-only' })),
      () => say('Added.'),
    ]);
    const { events } = await drive({ principal: h.owner, model });
    expect(requests[0].messages[0].content).toMatch(/looking at the DRAFT/);
    expect(await titles('draft')).toEqual(['draft-only', 'live-1']);
    expect(await titles('live')).toEqual(['from-assistant', 'live-1']);
    // no structural change: no "I made that change" note
    expect(textOf(events)).not.toContain('I made that change');
    await writeView(h.owner, 'live');
  });

  it('publishing raises the publish Approval and holds; it never applies by itself', async () => {
    const live = await getHost();
    const version = live.version;
    const { model, requests } = scripted([
      () => say('Publishing.', call('app_publishdraft', {})),
      () => say('Waiting for you.'),
    ]);
    const events: TurnEvent[] = [];
    const { stop } = await drive({
      principal: h.owner,
      model,
      limits: { holdTimeoutMs: 40 },
      onEvent: (e) => events.push(e),
    });
    expect(stop).toBe('waiting');
    const ask = events.find((e) => e.type === 'approval_required') as Extract<
      TurnEvent,
      { type: 'approval_required' }
    >;
    expect(ask.name).toBe('app_publishdraft');
    expect(ask.summary).toMatch(/Publish draft "Assist"/);
    expect((ask.preview as { digest?: string }).digest).toBeTruthy();
    expect(live.version).toBe(version);
    expect(await getDraftSlot()).not.toBeNull();
    expect((await getApprovalView(ask.approvalId))?.status).toBe('pending');
    expect(requests.length).toBe(1);
    await decide(ask.approvalId, false);
    expect(live.version).toBe(version);
  });

  it('a draft started in the same turn is used by the next call', async () => {
    await discardNow();
    const { model } = scripted([
      () => say('', call('app_startdraft', { name: 'Mid turn' })),
      () =>
        say('', call('app_removefield', { model: 'Chore', field: 'points' })),
      () => say('Done.'),
    ]);
    const events: TurnEvent[] = [];
    const { stop } = await drive({
      principal: h.owner,
      model,
      onEvent: (e) => events.push(e),
    });
    expect(stop).toBe('complete');
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(
      Object.keys((await getHost()).describe().models.Chore.fields),
    ).toContain('points');
    expect(
      Object.keys((await hostFor('draft')).describe().models.Chore.fields),
    ).not.toContain('points');
    await discardNow();
  });
});

// ----- the local CLI engines -------------------------------------------------

const minted: string[] = [];
function setup(tool: AgentTool) {
  const bin = tempDir('stub-bin-');
  const stateDir = tempDir('agent-state-');
  const path = installStub(bin, tool === 'claude-code' ? 'claude' : 'codex');
  const deps: AgentEngineDeps = {
    locate: async () => ({ path, extraPath: [nodeDir()] }),
    credentials: {
      async mint() {
        const token = `smrt_mcp_${randomBytes(32).toString('base64url')}`;
        mcp.setToken(token);
        minted.push(token);
        return token;
      },
      async revoke() {
        mcp.setToken(null);
      },
    },
    stateDir: async () => stateDir,
    baseEnv: { PATH: process.env.PATH, HOME: stateDir },
  };
  return { deps, stateDir };
}

async function cliTurn(tool: AgentTool, text: string) {
  const { deps, stateDir } = setup(tool);
  const thread = await createThread(h.owner.id, 't');
  const events: TurnEvent[] = [];
  const stop = await runAs(h.owner, () =>
    runAgentTurn({
      principal: h.owner,
      thread,
      text,
      tool,
      // the /mcp?scope=assistant request: the test route resolves it per call
      mcpUrl: `${mcp.url}?scope=assistant`,
      signal: new AbortController().signal,
      emit: (e) => events.push(e),
      deps,
    }),
  );
  return { events, stop, stateDir, threadId: thread.id as string };
}

describe.each([
  'claude-code',
  'codex',
] as const)('%s engine with a draft open', (tool) => {
  it('is told the mode, builds only in the draft, and says which copy', async () => {
    await startDraft(`Cli ${tool}`, h.owner.id);
    const live = await getHost();
    const liveVersion = live.version;
    const dumped = await cliTurn(tool, 'dump');
    const dump = JSON.parse(
      readFileSync(join(dumped.stateDir, 'dump.json'), 'utf8'),
    ) as { argv: string[] };
    expect(dump.argv.join(' ')).toMatch(
      new RegExp(`Mode: the draft .{1,3}Cli ${tool}.{1,3} is open`),
    );

    const { events, stop, threadId } = await cliTurn(
      tool,
      'tool app_removefield {"model":"Chore","field":"points"}',
    );
    expect(
      (await viewMessages(threadId)).find(
        (m) => m.tool?.name === 'app_removefield',
      )?.tool?.copy,
    ).toBe('draft');
    expect(stop).toBe('complete'); // a draft change needs no approval
    expect(events.some((e) => e.type === 'approval_required')).toBe(false);
    expect(live.version).toBe(liveVersion);
    expect(Object.keys(live.describe().models.Chore.fields)).toContain(
      'points',
    );
    expect(
      Object.keys((await hostFor('draft')).describe().models.Chore.fields),
    ).not.toContain('points');
    expect(
      events.find(
        (e) => e.type === 'tool_result' && e.name === 'app_removefield',
      ),
    ).toMatchObject({ ok: true, copy: 'draft' });
    expect(textOf(events)).toContain(
      `I made that change in the draft "Cli ${tool}"`,
    );

    // a record tool follows the owner's view (live)
    await cliTurn(tool, `tool chore_create {"title":"cli-${tool}"}`);
    expect((await titles('live')).includes(`cli-${tool}`)).toBe(true);
    expect((await titles('draft')).includes(`cli-${tool}`)).toBe(false);

    // publishing raises the Approval and stops the turn; nothing applied
    const pub = await cliTurn(tool, 'tool app_publishdraft {}');
    const ask = pub.events.find((e) => e.type === 'approval_required');
    expect(ask).toBeTruthy();
    expect(pub.stop).toBe('waiting');
    expect(live.version).toBe(liveVersion);
    expect(await getDraftSlot()).not.toBeNull();
    for (const p of await listApprovalViews({ status: 'pending' }))
      await decide(p.id, false);
    await discardNow();
  });
});
