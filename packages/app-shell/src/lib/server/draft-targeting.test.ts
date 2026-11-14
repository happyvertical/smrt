// Every tool call names its copy. While a draft is open: live serves records
// and refuses structure (naming the draft); structure goes to the draft; the
// draft's auto-approval is never reachable for live; nothing routes to the
// wrong data file.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppHost, MemoryVersionStore } from '../../engine/index.ts';
import { App } from '../objects/App.ts';
import { listApprovalViews } from './approvals.ts';
import { assistantScope } from './assistant/scope.ts';
import { discardNow } from './drafts.ts';
import { getDraftSlot, getHost, hostFor } from './host.ts';
import { createShellMcpServer } from './mcp-server.ts';
import { PolicyError } from './owner.ts';
import { authorizeCall, callTool, toolsFor } from './policy.ts';
import { LIVE_SCOPE, mcpScopeKey, parseTarget, scopeFor } from './target.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';
import { writeView } from './view.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
  await runAs(h.owner, () =>
    App.defineModel('Chore', {
      title: { type: 'text' },
      points: { type: 'text' },
    }),
  );
  await (await getHost()).create('Chore', { title: 'live-1' });
});
afterAll(async () => {
  await h.close();
});

const mcp = (p: { id: string; tenantId: string }) => ({
  id: p.id,
  tenantId: p.tenantId,
  kind: 'human',
  scopes: [],
});
const text = (r: { content: unknown }) =>
  (r.content as { text: string }[]).map((c) => c.text).join('\n');
/** A tool call's failure text, whether it threw or answered isError. */
async function failure(
  run: () => Promise<{ content: unknown; isError?: boolean }>,
) {
  try {
    const r = await run();
    return r.isError ? text(r) : null;
  } catch (e) {
    return (e as Error).message;
  }
}
const titles = async (target: 'live' | 'draft') =>
  (await (await hostFor(target)).list('Chore'))
    .map((r) => String(r.title))
    .sort();

describe('naming the copy', () => {
  it('parses what a request may say, and nothing else', () => {
    expect(parseTarget(undefined)).toBe('live');
    expect(parseTarget(null)).toBe('live');
    expect(parseTarget('')).toBe('live');
    expect(parseTarget('draft')).toBe('draft');
    expect(() => parseTarget('Draft')).toThrow(/live' or 'draft/);
    expect(() => parseTarget('both')).toThrow();
    expect(mcpScopeKey(new URLSearchParams(''))).toBe('live');
    expect(mcpScopeKey(new URLSearchParams('target=draft'))).toBe('draft');
    expect(mcpScopeKey(new URLSearchParams('scope=assistant'))).toBe(
      'assistant',
    );
    expect(() => mcpScopeKey(new URLSearchParams('scope=other'))).toThrow();
    expect(() =>
      mcpScopeKey(new URLSearchParams('scope=assistant&target=draft')),
    ).toThrow(/not both/);
    expect(LIVE_SCOPE).toEqual({ records: 'live', structure: 'live' });
  });

  it('the live host can never take autoApprove (it is for draft copies only)', async () => {
    await expect(
      AppHost.open(join(h.dir, 'user-app'), {
        store: new MemoryVersionStore(),
        autoApprove: true,
      }),
    ).rejects.toThrow(/not one/);
    expect((await getHost()).draft).toBeNull();
  });
});

describe('tools while a draft is open', () => {
  it('the catalog lists the draft tools, and still no way to decide an approval', async () => {
    const names = (await toolsFor(h.owner)).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'app_startdraft',
        'app_previewpublish',
        'app_publishdraft',
        'app_discarddraft',
        'app_undoto',
      ]),
    );
    expect(names).not.toContain('approval_decide');
  });

  it('starts a draft through a tool', async () => {
    const r = await callTool(h.owner, 'app_startdraft', { name: 'Tools' });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Tools');
    expect((await getHost()).frozen).toBe(true);
    // a second start is refused by name
    expect(
      await failure(() => callTool(h.owner, 'app_startdraft', {})),
    ).toMatch(/already open/);
  });

  it('a structural call aimed at live is refused, naming the draft, and nothing is queued', async () => {
    const approvalsBefore = (await listApprovalViews()).length;
    for (const [tool, args] of [
      [
        'app_addfield',
        { model: 'Chore', field: 'size', definition: { type: 'text' } },
      ],
      ['app_removefield', { model: 'Chore', field: 'points' }],
      ['app_defineModel'.toLowerCase(), { name: 'Nope' }],
      ['app_undo', {}],
    ] as const) {
      const msg = await failure(() =>
        callTool(h.owner, tool, args as Record<string, unknown>, LIVE_SCOPE),
      );
      expect(msg, tool).toMatch(/draft "Tools" is open/);
    }
    // not even a risky one becomes an Approval: it is refused before that
    expect((await listApprovalViews()).length).toBe(approvalsBefore);
    expect(
      Object.keys((await getHost()).describe().models.Chore.fields),
    ).toContain('points');
  });

  it('structure goes to the draft when the request says so; risky ones just apply there', async () => {
    const live = await getHost();
    const liveVersion = live.version;
    const added = await callTool(
      h.owner,
      'app_addfield',
      { model: 'Chore', field: 'size', definition: { type: 'text' } },
      scopeFor('draft'),
    );
    expect(added.isError).toBeFalsy();
    const removed = await callTool(
      h.owner,
      'app_removefield',
      { model: 'Chore', field: 'points' },
      scopeFor('draft'),
    );
    expect(removed.isError).toBeFalsy();
    expect(removed.pending).toBeUndefined();
    expect(text(removed)).not.toContain('pending_approval');
    expect(live.version).toBe(liveVersion);
    const draftFields = Object.keys(
      (await hostFor('draft')).describe().models.Chore.fields,
    );
    expect(draftFields).toContain('size');
    expect(draftFields).not.toContain('points');
    expect(Object.keys(live.describe().models.Chore.fields)).toContain(
      'points',
    );
  });

  it('describe says which copy it describes and carries the draft', async () => {
    const liveView = JSON.parse(
      text(await callTool(h.owner, 'app_describe', {}, LIVE_SCOPE)),
    ) as { mode: string; draft: { name: string } | null; frozen: boolean };
    expect(liveView).toMatchObject({ mode: 'live', frozen: true });
    expect(liveView.draft?.name).toBe('Tools');
    const draftView = JSON.parse(
      text(await callTool(h.owner, 'app_describe', {}, scopeFor('draft'))),
    ) as { mode: string; draft: { name: string } | null; frozen: boolean };
    expect(draftView).toMatchObject({ mode: 'draft', frozen: false });
    expect(draftView.draft?.name).toBe('Tools');
  });

  it('the app tools follow the copy: a draft-only model has tools only there', async () => {
    await callTool(
      h.owner,
      'app_definemodel',
      { name: 'Extra', fields: { note: { type: 'text' } } },
      scopeFor('draft'),
    );
    const liveNames = (await toolsFor(h.owner, LIVE_SCOPE)).map((t) => t.name);
    const draftNames = (await toolsFor(h.owner, scopeFor('draft'))).map(
      (t) => t.name,
    );
    expect(liveNames).not.toContain('extra_list');
    expect(draftNames).toContain('extra_list');
    await expect(
      authorizeCall(h.owner, 'extra_list', LIVE_SCOPE),
    ).rejects.toBeInstanceOf(PolicyError);
    const made = await callTool(
      h.owner,
      'extra_create',
      { note: 'in the draft' },
      scopeFor('draft'),
    );
    expect(made.isError).toBeFalsy();
  });

  it('a live record write while the draft is open lands on live and not in the draft', async () => {
    const r = await callTool(
      h.owner,
      'chore_create',
      { title: 'live-2' },
      LIVE_SCOPE,
    );
    expect(r.isError).toBeFalsy();
    const d = await callTool(
      h.owner,
      'chore_create',
      { title: 'draft-1' },
      scopeFor('draft'),
    );
    expect(d.isError).toBeFalsy();
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
    expect(await titles('draft')).toEqual(['draft-1', 'live-1']);
  });

  it('a delete is an Approval on live and immediate on the draft only', async () => {
    const live = await getHost();
    const liveId = (await live.list('Chore')).find((r) => r.title === 'live-2')
      ?.id as string;
    const del = await callTool(
      h.owner,
      'chore_delete',
      { id: liveId },
      LIVE_SCOPE,
    );
    expect(del.pending?.status).toBe('pending_approval');
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
    const draftId = (await (await hostFor('draft')).list('Chore')).find(
      (r) => r.title === 'draft-1',
    )?.id as string;
    const gone = await callTool(
      h.owner,
      'chore_delete',
      { id: draftId },
      scopeFor('draft'),
    );
    expect(gone.pending).toBeUndefined();
    expect(await titles('draft')).toEqual(['live-1']);
    expect(await titles('live')).toEqual(['live-1', 'live-2']);
  });

  it('an MCP server is fixed to the copy its URL named', async () => {
    const owner = mcp(h.owner);
    const liveServer = createShellMcpServer();
    const draftServer = createShellMcpServer(() => scopeFor('draft'));
    const names = async (s: ReturnType<typeof createShellMcpServer>) =>
      (await s.listTools({ principal: owner })).map((t) => t.name);
    expect(await names(liveServer)).not.toContain('extra_list');
    expect(await names(draftServer)).toContain('extra_list');
    // a builder call through the default server cannot reach the draft's free pass
    const refused = await failure(
      () =>
        liveServer.callTool({
          name: 'app_removefield',
          arguments: { model: 'Chore', field: 'title' },
          principal: owner,
        }) as never,
    );
    expect(refused).toMatch(/draft "Tools" is open/);
    expect(
      Object.keys((await getHost()).describe().models.Chore.fields),
    ).toContain('title');
    // the same call through the draft server applies in the draft only
    await draftServer.callTool({
      name: 'app_renamefield',
      arguments: { model: 'Chore', from: 'size', to: 'bulk' },
      principal: owner,
    });
    const draftFields = Object.keys(
      (await hostFor('draft')).describe().models.Chore.fields,
    );
    expect(draftFields).toContain('bulk');
    expect(draftFields).not.toContain('size');
    const liveFields = Object.keys(
      (await getHost()).describe().models.Chore.fields,
    );
    expect(liveFields).not.toContain('bulk');
    expect(liveFields).not.toContain('size');
    // a non-owner sees nothing on either
    expect(await draftServer.listTools({ principal: mcp(h.member) })).toEqual(
      [],
    );
    await expect(
      draftServer.callTool({
        name: 'chore_list',
        arguments: {},
        principal: mcp(h.member),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('target=draft with no draft open is a clear refusal, never live', async () => {
    const tmp = createShellMcpServer(() => scopeFor('draft'));
    await discardNow();
    await expect(tmp.listTools({ principal: mcp(h.owner) })).rejects.toThrow(
      /no draft open/,
    );
    expect(
      await failure(
        () =>
          tmp.callTool({
            name: 'app_addfield',
            arguments: {
              model: 'Chore',
              field: 'zzz',
              definition: { type: 'text' },
            },
            principal: mcp(h.owner),
          }) as never,
      ),
    ).toMatch(/no draft open|unknown tool/);
    expect(
      (await getHost()).describe().models.Chore.fields.zzz,
    ).toBeUndefined();
  });
});

describe('the assistant split (builds in the draft, records follow the view)', () => {
  it('no draft: everything is live', async () => {
    expect(await assistantScope(h.owner)).toEqual(LIVE_SCOPE);
  });

  it('a draft open: structure on the draft, records on the viewed copy', async () => {
    await callTool(h.owner, 'app_startdraft', { name: 'Split' });
    expect(await assistantScope(h.owner)).toEqual({
      structure: 'draft',
      records: 'live',
    });
    await writeView(h.owner, 'draft');
    expect(await assistantScope(h.owner)).toEqual({
      structure: 'draft',
      records: 'draft',
    });
    // the member never gets a draft scope
    expect(await assistantScope(h.member)).toEqual(LIVE_SCOPE);
    // the saved view survives, but only while its draft does
    await writeView(h.owner, 'live');
    await expect(writeView(h.owner, 'both')).rejects.toThrow();
    await writeView(h.owner, 'draft');
    await discardNow();
    expect(await getDraftSlot()).toBeNull();
    expect(await assistantScope(h.owner)).toEqual(LIVE_SCOPE);
    await expect(writeView(h.owner, 'draft')).rejects.toThrow(/no draft open/);
  });

  it('publish and discard asked through tools are Approvals', async () => {
    await callTool(h.owner, 'app_startdraft', { name: 'Ask' });
    await callTool(
      h.owner,
      'app_addfield',
      { model: 'Chore', field: 'size', definition: { type: 'text' } },
      scopeFor('draft'),
    );
    const live = await getHost();
    const version = live.version;
    const pub = await callTool(h.owner, 'app_publishdraft', {});
    expect(pub.pending?.status).toBe('pending_approval');
    const preview = await callTool(h.owner, 'app_previewpublish', {});
    expect(text(preview)).toContain('digest');
    const dis = await callTool(h.owner, 'app_discarddraft', {});
    expect(dis.pending?.status).toBe('pending_approval');
    expect(live.version).toBe(version);
    expect(await getDraftSlot()).not.toBeNull();
    // a member cannot ask
    await expect(
      callTool(h.member, 'app_publishdraft', {}),
    ).rejects.toMatchObject({ status: 403 });
    await discardNow();
  });
});
