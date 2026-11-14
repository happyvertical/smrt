import { describe, expect, it, vi } from 'vitest';
import { createInMemoryMcpAuditSink, mcpArgumentKeyNames } from '../audit.js';
import { MCP_CONFIRM_REQUIRED_CODE, McpToolError } from '../errors.js';
import {
  createMcpAppServer,
  type McpAppPrincipal,
  type McpToolCallAuditEvent,
} from '../server.js';
import type { McpWorkflowToolDefinition } from '../workflow-tools.js';

function def(
  name: string,
  extra: Partial<McpWorkflowToolDefinition> = {},
): McpWorkflowToolDefinition {
  return {
    name,
    description: name,
    effect: 'write',
    idempotent: false,
    openWorld: false,
    inputSchema: { type: 'object', properties: { to: { type: 'string' } } },
    outputSchema: { type: 'object' },
    execute: () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...extra,
  } as McpWorkflowToolDefinition;
}

const agent: McpAppPrincipal = {
  id: 'cred-1',
  kind: 'agent',
  tenantId: 'tenant-a',
  scopes: ['crm.read'],
};
const owner: McpAppPrincipal = {
  id: 'user-1',
  kind: 'owner',
  tenantId: 'tenant-a',
  scopes: ['crm.read', 'mail.send'],
};

function make(
  tools: McpWorkflowToolDefinition[],
  options: Record<string, unknown> = {},
) {
  const sink = createInMemoryMcpAuditSink();
  const events: McpToolCallAuditEvent[] = [];
  const app = createMcpAppServer({
    smrtOptions: () => ({}),
    serverInfo: { name: 't', version: '1' },
    allowedClassNames: [],
    workflowTools: tools,
    auditSink: sink,
    onToolCall: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { app, sink, events };
}

describe('declarative tool scopes', () => {
  const tools = () => [
    def('crm_search', { effect: 'read', requiredScopes: ['crm.read'] }),
    def('mail_send', { requiredScopes: ['mail.send'] }),
    def('open_tool'),
  ];

  it('filters discovery and denies calls by the principal scopes', async () => {
    const { app, sink } = make(tools());
    const names = async (p: McpAppPrincipal | null) =>
      (await app.listTools({ principal: p })).map((t) => t.name).sort();
    expect(await names(agent)).toEqual(['crm_search', 'open_tool']);
    expect(await names(owner)).toEqual([
      'crm_search',
      'mail_send',
      'open_tool',
    ]);
    await expect(
      app.callTool({ name: 'mail_send', arguments: {}, principal: agent }),
    ).rejects.toMatchObject({ status: 403 });
    expect(sink.records[0]).toMatchObject({
      tool: 'mail_send',
      outcome: 'denied',
      principalId: 'cred-1',
      principalKind: 'agent',
    });
    const ok = await app.callTool({
      name: 'mail_send',
      arguments: {},
      principal: owner,
    });
    expect(ok.isError).toBeUndefined();
  });

  it('supports host toolScopes patterns and requires every scope', async () => {
    const { app } = make([def('mail_send'), def('mail_draft')], {
      toolScopes: { 'mail_*': ['mail.send', 'crm.read'] },
    });
    const partial = { ...agent, scopes: ['mail.send'] };
    expect(await app.listTools({ principal: partial })).toEqual([]);
    expect(
      (await app.listTools({ principal: owner })).map((t) => t.name),
    ).toEqual(['mail_draft', 'mail_send']);
  });

  it('composes with toolPolicy as AND and never exposes a scoped tool anonymously', async () => {
    const { app } = make(
      [def('crm_search', { requiredScopes: ['crm.read'] })],
      {
        toolPolicy: ({ principal }: { principal: McpAppPrincipal | null }) =>
          principal?.kind !== 'agent',
        publicToolPatterns: () => ['crm_*'],
      },
    );
    expect(await app.listTools({ principal: agent })).toEqual([]);
    expect(await app.listTools({ principal: null })).toEqual([]);
    expect(await app.listTools({ principal: owner })).toHaveLength(1);
  });

  it('rejects malformed configuration at construction', () => {
    expect(() => make([def('a')], { toolScopes: { a: 'x' as never } })).toThrow(
      TypeError,
    );
    expect(() => make([def('a', { requiredScopes: [''] })])).toThrow(TypeError);
    expect(() => make([def('a')], { confirmTools: [1 as never] })).toThrow(
      TypeError,
    );
  });
});

describe('confirm gate', () => {
  it('advertises confirm and refuses unconfirmed calls before execution', async () => {
    const execute = vi.fn(() => ({
      content: [{ type: 'text', text: 'sent' }],
    }));
    const assertion = vi.fn();
    const { app, sink, events } = make(
      [def('mail_send', { requiresConfirm: true, execute: execute as never })],
      { workflowAssertions: { mail_send: assertion } },
    );
    const [listed] = await app.listTools({ principal: owner });
    expect(
      (listed.inputSchema as { properties: Record<string, unknown> }).properties
        .confirm,
    ).toMatchObject({ type: 'boolean' });

    for (const args of [
      {},
      { confirm: 'true' },
      { confirm: 1 },
      { confirm: false },
    ]) {
      const result = await app.callTool({
        name: 'mail_send',
        arguments: args,
        principal: owner,
      });
      expect(result.isError).toBe(true);
      expect(
        (result.structuredContent as { error: { code: string } }).error.code,
      ).toBe(MCP_CONFIRM_REQUIRED_CODE);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(assertion).not.toHaveBeenCalled();
    expect(sink.records.map((r) => r.outcome)).toEqual([
      'denied',
      'denied',
      'denied',
      'denied',
    ]);
    expect(events[0].error?.code).toBe(MCP_CONFIRM_REQUIRED_CODE);

    const done = await app.callTool({
      name: 'mail_send',
      arguments: { confirm: true, to: 'a@b.c' },
      principal: owner,
    });
    expect(done.isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sink.records.at(-1)).toMatchObject({
      outcome: 'allowed',
      argumentKeys: ['confirm', 'to'],
    });
  });

  it('gates by host pattern and does not touch ungated tools', async () => {
    const { app } = make(
      [def('mail_send'), def('mail_list', { effect: 'read' })],
      {
        confirmTools: ['mail_send'],
      },
    );
    const tools = await app.listTools({ principal: owner });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(JSON.stringify(byName.mail_send.inputSchema)).toContain('confirm');
    expect(JSON.stringify(byName.mail_list.inputSchema)).not.toContain(
      'confirm',
    );
    const ungated = await app.callTool({
      name: 'mail_list',
      arguments: {},
      principal: owner,
    });
    expect(ungated.isError).toBeUndefined();
  });
});

describe('audit records', () => {
  it('records identity, tenant, outcome and argument KEYS only', async () => {
    const { app, sink } = make([
      def('crm_search', { effect: 'read' }),
      def('boom', {
        execute: () => {
          throw new Error('secret-token-123');
        },
      }),
      def('nope', {
        execute: () => {
          throw new McpToolError('forbidden', 'Missing scope: x');
        },
      }),
    ]);
    await app.callTool({
      name: 'crm_search',
      arguments: { query: 'SENSITIVE-VALUE', limit: 5 },
      principal: agent,
    });
    const boom = await app.callTool({
      name: 'boom',
      arguments: {},
      principal: agent,
    });
    const nope = await app.callTool({
      name: 'nope',
      arguments: {},
      principal: agent,
    });
    expect(boom.isError).toBe(true);
    expect(nope.isError).toBe(true);
    await expect(
      app.callTool({ name: 'missing', arguments: {}, principal: agent }),
    ).rejects.toBeTruthy();

    expect(sink.records.map((r) => [r.tool, r.outcome])).toEqual([
      ['crm_search', 'allowed'],
      ['boom', 'error'],
      ['nope', 'denied'],
      ['missing', 'denied'],
    ]);
    const first = sink.records[0];
    expect(first).toMatchObject({
      principalId: 'cred-1',
      principalKind: 'agent',
      tenantId: 'tenant-a',
      argumentKeys: ['limit', 'query'],
    });
    expect(first.occurredAt).toBeInstanceOf(Date);
    expect(JSON.stringify(sink.records)).not.toContain('SENSITIVE-VALUE');
    expect(JSON.stringify(sink.records)).not.toContain('secret-token-123');
  });

  it('uses the host tenant resolver and reports sink failures without altering the call', async () => {
    const failures: unknown[] = [];
    const { app } = make([def('crm_search', { effect: 'read' })], {
      auditTenantId: () => 'tenant-host',
      auditSink: {
        record() {
          throw new Error('db down');
        },
      },
      onToolCallHookError: (e: unknown) => failures.push(e),
    });
    const result = await app.callTool({
      name: 'crm_search',
      arguments: {},
      principal: agent,
    });
    expect(result.isError).toBeUndefined();
    expect(failures).toHaveLength(1);
  });

  it('records anonymous calls with null identity and tenant', async () => {
    const { app, sink } = make([def('open_read', { effect: 'read' })], {
      publicToolPatterns: () => ['open_*'],
    });
    await app.callTool({ name: 'open_read', arguments: {}, principal: null });
    expect(sink.records[0]).toMatchObject({
      principalId: null,
      principalKind: null,
      tenantId: null,
      outcome: 'allowed',
    });
  });

  it('survives a throwing tenant resolver and falls back to the principal tenant', async () => {
    const failures: unknown[] = [];
    const { app, sink } = make([def('crm_search', { effect: 'read' })], {
      auditTenantId: () => {
        throw new Error('boom');
      },
      onToolCallHookError: (e: unknown) => failures.push(e),
    });
    await app.callTool({ name: 'crm_search', arguments: {}, principal: agent });
    expect(failures).toHaveLength(1);
    expect(sink.records[0]).toMatchObject({ tenantId: 'tenant-a' });
  });

  it('does not persist anonymous unknown-tool denials but still reports them', async () => {
    const { app, sink, events } = make([def('crm_search', { effect: 'read' })]);
    await expect(
      app.callTool({ name: 'nope', arguments: {}, principal: null }),
    ).rejects.toMatchObject({ status: 404 });
    expect(sink.records).toHaveLength(0);
    expect(events).toHaveLength(1);
  });

  it('records the verified credential identity', async () => {
    const { app, sink } = make([def('crm_search', { effect: 'read' })]);
    await app.callTool({
      name: 'crm_search',
      arguments: {},
      principal: {
        ...agent,
        identity: { issuer: 'https://idp', subject: 'sub-1', clientId: 'c1' },
      },
    });
    expect(sink.records[0]).toMatchObject({
      identityIssuer: 'https://idp',
      identitySubject: 'sub-1',
      identityClientId: 'c1',
    });
  });

  it('warns once about toolScopes and confirmTools patterns that match no tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app } = make([def('crm_search', { effect: 'read' })], {
      toolScopes: { 'typo_*': ['x'] },
      confirmTools: ['also_missing'],
    });
    await app.listTools({ principal: agent });
    await app.listTools({ principal: agent });
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('bounds argument key names and ignores non-object arguments', () => {
    expect(mcpArgumentKeyNames(undefined)).toEqual([]);
    expect(mcpArgumentKeyNames(['a'])).toEqual([]);
    expect(mcpArgumentKeyNames({ b: 1, a: 2 })).toEqual(['a', 'b']);
    const many = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `k${String(i).padStart(2, '0')}`,
        i,
      ]),
    );
    expect(mcpArgumentKeyNames(many)).toHaveLength(32);
    expect(mcpArgumentKeyNames({ ['x'.repeat(300)]: 1 })[0]).toHaveLength(120);
  });

  it('in-memory sink lists by tenant and principal', async () => {
    const { app, sink } = make([def('crm_search', { effect: 'read' })]);
    await app.callTool({ name: 'crm_search', principal: agent });
    await app.callTool({
      name: 'crm_search',
      principal: { ...owner, tenantId: 'tenant-b' },
    });
    expect(sink.list({ tenantId: 'tenant-a' })).toHaveLength(1);
    expect(sink.list({ principalId: 'user-1' })[0].tenantId).toBe('tenant-b');
  });
});
