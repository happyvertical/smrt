import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, listApprovalViews } from './approvals.ts';
import { getHost } from './host.ts';
import { createShellMcpServer } from './mcp-server.ts';
import { PolicyError } from './owner.ts';
import { authorizeCall, callTool, toolsFor } from './policy.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

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
  scopes: [],
});

describe('merged catalog and policy', () => {
  it('lists shell and app tools together for the owner', async () => {
    await runAs(h.owner, async () => {
      const r = await callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      expect(r.isError).toBeFalsy();
    });
    const names = (await toolsFor(h.owner)).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'app_definemodel',
        'app_addfield',
        'app_undo',
        'approval_pending',
        'chore_list',
        'chore_create',
        'chore_delete',
      ]),
    );
    // only the declared operations: no generated CRUD on the shell's models
    for (const gone of [
      'app_list',
      'app_get',
      'app_create',
      'app_update',
      'app_delete',
      'approval_list',
      'approval_get',
      'approval_create',
      'approval_update',
      'approval_delete',
    ])
      expect(names).not.toContain(gone);
    const sides = Object.fromEntries(
      (await toolsFor(h.owner)).map((t) => [t.name, t.side]),
    );
    expect(sides.app_definemodel).toBe('shell');
    expect(sides.chore_list).toBe('app');
  });

  it('routes calls to the right side', async () => {
    const created = await callTool(h.owner, 'chore_create', { title: 'mop' });
    expect(created.isError).toBeFalsy();
    const listed = await callTool(h.owner, 'chore_list', {});
    expect(JSON.stringify(listed.content)).toContain('mop');
    const described = await callTool(h.owner, 'app_describe', {});
    expect(JSON.stringify(described.content)).toContain('Chore');
  });

  it('sees a newly added field in the tool schema after a change', async () => {
    await callTool(h.owner, 'app_addfield', {
      model: 'Chore',
      field: 'points',
      definition: { type: 'text' },
    });
    const create = (await toolsFor(h.owner)).find(
      (t) => t.name === 'chore_create',
    );
    expect(JSON.stringify(create?.inputSchema)).toContain('points');
  });

  it('refuses everything for a non-owner and for nobody', async () => {
    expect(await toolsFor(h.member)).toEqual([]);
    expect(await toolsFor(null)).toEqual([]);
    await expect(authorizeCall(h.member, 'chore_list')).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      authorizeCall(h.member, 'app_definemodel'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(authorizeCall(null, 'chore_list')).rejects.toMatchObject({
      status: 401,
    });
    await expect(authorizeCall(h.owner, 'nope')).rejects.toBeInstanceOf(
      PolicyError,
    );
    await expect(
      callTool(h.member, 'chore_create', { title: 'x' }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect((await (await getHost()).list('Chore')).length).toBe(1);
  });

  it('gates risky tools: delete becomes an approval, risky builder methods too', async () => {
    const host = await getHost();
    const id = (await host.list('Chore'))[0].id as string;
    const del = await callTool(h.owner, 'chore_delete', { id });
    expect(JSON.stringify(del.content)).toContain('pending_approval');
    expect((await host.list('Chore')).length).toBe(1);
    const rm = await callTool(h.owner, 'app_removefield', {
      model: 'Chore',
      field: 'points',
    });
    expect(JSON.stringify(rm.content)).toContain('pending_approval');
    expect(host.describe().models.Chore.fields).toHaveProperty('points');
    expect((await listApprovalViews({ status: 'pending' })).length).toBe(2);
    // there is no way to pass `approved` through a tool call
    const sneaky = await callTool(h.owner, 'app_removefield', {
      model: 'Chore',
      field: 'points',
      approved: true,
    });
    expect(JSON.stringify(sneaky.content)).toContain('pending_approval');
    expect(host.describe().models.Chore.fields).toHaveProperty('points');
  });

  it('the Approval tools list and decide through the same gate', async () => {
    const text = (r: { content: unknown }) =>
      (r.content as { text: string }[])[0].text;
    const listed = JSON.parse(
      text(await callTool(h.owner, 'approval_pending', {})),
    );
    const rows: { id: string; action: { kind: string } }[] =
      listed.result ?? listed;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const cmd = rows.find(
      (r) => r.action.kind === 'command',
    ) as (typeof rows)[number];
    // Deciding is the owner's act in the UI, never a tool: no tool caller
    // (the assistant, an outside MCP client) can approve its own call.
    await expect(
      callTool(h.owner, 'approval_decide', { id: cmd.id, approve: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await toolsFor(h.owner)).map((t) => t.name)).not.toContain(
      'approval_decide',
    );
    const denied = await decideApproval(cmd.id, false, h.owner.id);
    expect(denied.status).toBe('denied');
    const tool = rows.find(
      (r) => r.action.kind === 'tool',
    ) as (typeof rows)[number];
    const host = await getHost();
    expect((await host.list('Chore')).length).toBe(1);
    const approved = await decideApproval(tool.id, true, h.owner.id);
    expect(approved.status).toBe('approved');
    expect((await host.list('Chore')).length).toBe(0);
    // members cannot reach any of it
    await expect(
      callTool(h.member, 'approval_pending', {}),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('merged MCP server', () => {
  it('lists and calls through policy.ts', async () => {
    const server = createShellMcpServer();
    const tools = await server.listTools({ principal: mcp(h.owner) });
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['app_describe', 'chore_list']),
    );
    expect(await server.listTools({ principal: mcp(h.member) })).toEqual([]);
    expect(await server.listTools({ principal: null })).toEqual([]);
    const ok = await server.callTool({
      name: 'chore_list',
      arguments: {},
      principal: mcp(h.owner),
    });
    expect(ok.isError).toBeFalsy();
    await expect(
      server.callTool({
        name: 'chore_list',
        arguments: {},
        principal: mcp(h.member),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      server.callTool({ name: 'chore_list', arguments: {}, principal: null }),
    ).rejects.toMatchObject({ status: 401 });
    expect((await server.getToolsListCacheHint?.())?.ttlMs).toBe(0);
  });
});
