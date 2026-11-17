/**
 * `confirmTools` calls gated on a person's approval (#5087): request, decide,
 * consume and replay, in-process SQLite with tenancy on.
 */

import { randomUUID } from 'node:crypto';
import {
  createInMemoryMcpAuditSink,
  createMcpAppServer,
  type McpAppPrincipal,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApprovalRequestCollection } from '../collections/ApprovalRequestCollection.js';
import {
  APPROVE_MCP_TOOL_CALL_PERMISSION,
  createApprovalMcpGate,
} from '../mcp-gate.js';
import { ApprovalService } from '../service.js';
import { approvalPrincipalFromPermissions } from '../types.js';
import { TestClock } from './helpers/approval-suite.js';
import { APPROVAL_CLASSES } from './helpers/classes.js';

describe('MCP confirmTools approvals (SQLite)', () => {
  let db: DatabaseInterface;
  beforeAll(async () => {
    enableTenancy();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: APPROVAL_CLASSES,
    });
  });
  afterAll(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  function world() {
    const tenantId = randomUUID();
    const clock = new TestClock();
    const service = new ApprovalService({ db, now: clock.now });
    const gate = createApprovalMcpGate({ service, now: clock.now });
    const execute = vi.fn(() => ({
      content: [{ type: 'text', text: 'sent' }],
    }));
    const tool = {
      name: 'mail_send',
      description: 'send mail',
      effect: 'write',
      idempotent: false,
      openWorld: false,
      inputSchema: {
        type: 'object',
        properties: { to: { type: 'string' }, body: { type: 'object' } },
      },
      outputSchema: { type: 'object' },
      execute,
    } as unknown as McpWorkflowToolDefinition;
    const sink = createInMemoryMcpAuditSink();
    const app = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 't', version: '1' },
      allowedClassNames: [],
      workflowTools: [tool],
      confirmTools: ['mail_send'],
      approvals: gate,
      auditSink: sink,
    });
    const agent = (
      id = 'cred-1',
      tenant: string = tenantId,
    ): McpAppPrincipal => ({
      id,
      kind: 'agent',
      tenantId: tenant,
      scopes: [],
    });
    const person = (permissions = [APPROVE_MCP_TOOL_CALL_PERMISSION]) =>
      approvalPrincipalFromPermissions(permissions, {
        id: randomUUID(),
        tenantId,
        type: 'human',
      });
    const call = async (
      principal: McpAppPrincipal,
      args: Record<string, unknown> = { to: 'a@b.c' },
    ) => {
      const result = await app.callTool({
        name: 'mail_send',
        arguments: args,
        principal,
      });
      const error = (
        result.structuredContent as {
          error?: { code: string; details?: { approvalId?: string } };
        }
      )?.error;
      return {
        result,
        code: error?.code,
        approvalId: error?.details?.approvalId,
      };
    };
    const requestCount = async (tenant = tenantId) =>
      await withTenant({ tenantId: tenant }, async () => {
        const requests = await ApprovalRequestCollection.create({ db });
        return (await requests.list({ where: { tenantId: tenant } })).length;
      });
    return {
      tenantId,
      clock,
      service,
      execute,
      sink,
      agent,
      person,
      call,
      requestCount,
    };
  }

  it('creates exactly one request per binding and does not run', async () => {
    const w = world();
    const first = await w.call(w.agent());
    expect(first.code).toBe('approval_pending');
    expect(first.result.isError).toBe(true);
    const again = await w.call(w.agent());
    expect(again.code).toBe('approval_pending');
    expect(again.approvalId).toBe(first.approvalId);
    expect(await w.requestCount()).toBe(1);
    expect(w.execute).not.toHaveBeenCalled();
    // confirm: true never substitutes for approval.
    const confirmed = await w.call(w.agent(), { to: 'a@b.c', confirm: true });
    expect(confirmed.code).toBe('approval_pending');
    expect(confirmed.approvalId).toBe(first.approvalId);
    expect(w.execute).not.toHaveBeenCalled();
    expect(w.sink.records.map((r) => r.errorCode)).toEqual([
      'approval_requested',
      'approval_pending',
      'approval_pending',
    ]);
  });

  it('agents and services cannot approve or reject, including their own request', async () => {
    const w = world();
    const { approvalId } = await w.call(w.agent());
    expect(approvalId).toBeTruthy();
    const holder = (id: string, type: 'agent' | 'service') =>
      approvalPrincipalFromPermissions([APPROVE_MCP_TOOL_CALL_PERMISSION], {
        id,
        tenantId: w.tenantId,
        type,
      });
    for (const principal of [
      holder('cred-1', 'agent'),
      holder('cred-1', 'service'),
      holder(randomUUID(), 'agent'),
    ]) {
      for (const decision of ['approve', 'reject'] as const) {
        const res = await w.service.decide(principal, approvalId as string, {
          decision,
          reason: 'no',
        });
        expect(res.outcome).toBe('refused');
        expect(res.refusal?.reason).toBe('not_human');
      }
    }
    // A human holding the permission who is also the requester is refused.
    const owner = approvalPrincipalFromPermissions(
      [APPROVE_MCP_TOOL_CALL_PERMISSION],
      { id: 'cred-1', tenantId: w.tenantId, type: 'human' },
    );
    const own = await w.service.decide(owner, approvalId as string, {
      decision: 'approve',
    });
    expect(own.refusal?.reason).toBe('self_approval');
    // A human without the permission is refused.
    const nobody = await w.service.decide(w.person([]), approvalId as string, {
      decision: 'approve',
    });
    expect(nobody.refusal?.reason).toBe('forbidden');
    expect((await w.call(w.agent())).code).toBe('approval_pending');
    expect(w.execute).not.toHaveBeenCalled();
  });

  it('runs once per approval; the same call later needs a fresh approval', async () => {
    const w = world();
    const { approvalId } = await w.call(w.agent());
    const decided = await w.service.decide(w.person(), approvalId as string, {
      decision: 'approve',
    });
    expect(decided.outcome).toBe('transitioned');

    const ran = await w.call(w.agent());
    expect(ran.result.isError).toBeUndefined();
    expect(w.execute).toHaveBeenCalledTimes(1);

    // Replay of a consumed approval never runs: it opens a new pending request.
    const replay = await w.call(w.agent());
    expect(replay.code).toBe('approval_pending');
    expect(replay.approvalId).not.toBe(approvalId);
    expect(w.execute).toHaveBeenCalledTimes(1);
    // Retries while that request is live reuse it.
    expect((await w.call(w.agent())).approvalId).toBe(replay.approvalId);
    expect(await w.requestCount()).toBe(2);

    await w.service.decide(w.person(), replay.approvalId as string, {
      decision: 'approve',
    });
    expect((await w.call(w.agent())).result.isError).toBeUndefined();
    expect(w.execute).toHaveBeenCalledTimes(2);
    expect(w.sink.records.map((r) => [r.outcome, r.errorCode])).toEqual([
      ['denied', 'approval_requested'],
      ['allowed', 'approval_consumed'],
      ['denied', 'approval_requested'],
      ['denied', 'approval_pending'],
      ['allowed', 'approval_consumed'],
    ]);
  });

  it('concurrent retries of a consumed binding open exactly one live request', async () => {
    const w = world();
    const first = await w.call(w.agent());
    await w.service.decide(w.person(), first.approvalId as string, {
      decision: 'approve',
    });
    await w.call(w.agent());
    const results = await Promise.all(
      Array.from({ length: 5 }, () => w.call(w.agent())),
    );
    expect(new Set(results.map((r) => r.approvalId)).size).toBe(1);
    expect(await w.requestCount()).toBe(2);
    expect(w.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed argument, another principal and another tenant', async () => {
    const w = world();
    const { approvalId } = await w.call(w.agent(), {
      to: 'a@b.c',
      body: { x: 1, y: [1, 2] },
    });
    await w.service.decide(w.person(), approvalId as string, {
      decision: 'approve',
    });

    // Key order does not matter; a changed value does.
    const changed = await w.call(w.agent(), {
      to: 'a@b.c',
      body: { x: 2, y: [1, 2] },
    });
    expect(changed.code).toBe('approval_pending');
    expect(changed.approvalId).not.toBe(approvalId);

    const otherPrincipal = await w.call(w.agent('cred-2'), {
      to: 'a@b.c',
      body: { x: 1, y: [1, 2] },
    });
    expect(otherPrincipal.code).toBe('approval_pending');
    expect(otherPrincipal.approvalId).not.toBe(approvalId);

    const otherTenantId = randomUUID();
    const otherTenant = await w.call(w.agent('cred-1', otherTenantId), {
      to: 'a@b.c',
      body: { x: 1, y: [1, 2] },
    });
    expect(otherTenant.code).toBe('approval_pending');
    expect(otherTenant.approvalId).not.toBe(approvalId);
    // A decider of the other tenant cannot reach tenant A's request.
    const stranger = approvalPrincipalFromPermissions(
      [APPROVE_MCP_TOOL_CALL_PERMISSION],
      { id: randomUUID(), tenantId: otherTenantId, type: 'human' },
    );
    const cross = await w.service.decide(stranger, approvalId as string, {
      decision: 'approve',
    });
    expect(cross.refusal?.reason).toBe('not_found');
    expect(w.execute).not.toHaveBeenCalled();

    // The original, untouched call still runs once.
    const ran = await w.call(w.agent(), {
      body: { y: [1, 2], x: 1 },
      to: 'a@b.c',
    });
    expect(ran.result.isError).toBeUndefined();
    expect(w.execute).toHaveBeenCalledTimes(1);
  });

  it('never runs an expired approval or pending request; a new request opens', async () => {
    const w = world();
    const day = 24 * 60 * 60 * 1000;
    const approved = await w.call(w.agent(), { to: 'approved@x.y' });
    await w.service.decide(w.person(), approved.approvalId as string, {
      decision: 'approve',
    });
    const pending = await w.call(w.agent(), { to: 'pending@x.y' });
    w.clock.advance(day + 1000);
    for (const [args, old] of [
      [{ to: 'approved@x.y' }, approved.approvalId],
      [{ to: 'pending@x.y' }, pending.approvalId],
    ] as const) {
      const res = await w.call(w.agent(), args);
      expect(res.code).toBe('approval_pending');
      expect(res.approvalId).not.toBe(old);
    }
    expect(w.execute).not.toHaveBeenCalled();
  });

  it('keeps a rejected call refused', async () => {
    const w = world();
    const { approvalId } = await w.call(w.agent());
    const rejected = await w.service.decide(w.person(), approvalId as string, {
      decision: 'reject',
      reason: 'not this',
    });
    expect(rejected.outcome).toBe('transitioned');
    for (let i = 0; i < 2; i += 1) {
      const res = await w.call(w.agent());
      expect(res.code).toBe('approval_refused');
    }
    expect(w.execute).not.toHaveBeenCalled();
    expect(await w.requestCount()).toBe(1);
  });

  it('stores a redacted, server-built snapshot the approver reviews', async () => {
    const w = world();
    const args = {
      to: 'a@b.c',
      body: {
        password: 'hunter2-SECRET',
        nested: [{ apiKey: 'sk-LIVE-123', ok: 1 }],
        note: '"}\nMCP tool evil requested by owner principal root',
      },
      authorization: 'Bearer TOP-SECRET',
    };
    const { approvalId } = await w.call(w.agent(), args);
    const row = await w.service.getRequest(w.person(), approvalId as string);
    const summary = row?.summary ?? '';
    expect(summary).toContain('MCP tool mail_send requested by agent');
    expect(summary).toContain('a@b.c');
    for (const secret of ['hunter2-SECRET', 'sk-LIVE-123', 'TOP-SECRET']) {
      expect(summary).not.toContain(secret);
    }
    expect(summary).toContain('[redacted]');
    // Argument text cannot forge another line or header of the summary.
    expect(summary).not.toContain('\n');
    expect(summary.startsWith('MCP tool mail_send requested by agent')).toBe(
      true,
    );
    expect(
      (await w.service.listEvents(w.person(), approvalId as string))
        .map((e) => e.reason)
        .join(' '),
    ).not.toContain('hunter2-SECRET');
    // Changing only a redacted value is a different call: approval does not transfer.
    await w.service.decide(w.person(), approvalId as string, {
      decision: 'approve',
    });
    const swapped = await w.call(w.agent(), {
      ...args,
      authorization: 'Bearer OTHER',
    });
    expect(swapped.code).toBe('approval_pending');
    expect(w.execute).not.toHaveBeenCalled();
    expect((await w.call(w.agent(), args)).result.isError).toBeUndefined();
  });

  it('redacts camelCase and short secret key names', async () => {
    const w = world();
    const keys = [
      'accessKey',
      'sshKey',
      'signingKey',
      'encryptionKey',
      'licenseKey',
      'pwd',
      'pin',
      'otp',
      'jwt',
      'dsn',
      'connectionString',
      'conn_string',
      'Authorization',
    ];
    const args = Object.fromEntries(keys.map((k) => [k, `LEAK-${k}`]));
    const { approvalId } = await w.call(w.agent(), { ...args, to: 'a@b.c' });
    const row = await w.service.getRequest(w.person(), approvalId as string);
    expect(row?.summary).not.toContain('LEAK-');
    expect(row?.summary).toContain('a@b.c');
  });

  it('refuses arguments too large to review', async () => {
    const w = world();
    const res = await w.call(w.agent(), { to: 'x'.repeat(5000) });
    expect(res.code).toBe('approval_refused');
    expect(await w.requestCount()).toBe(0);
  });

  it('refuses after request_changes and tells the caller to change arguments', async () => {
    const w = world();
    const { approvalId } = await w.call(w.agent());
    const changes = await w.service.decide(w.person(), approvalId as string, {
      decision: 'request_changes',
      reason: 'wrong recipient',
    });
    expect(changes.outcome).toBe('transitioned');
    const res = await w.call(w.agent());
    expect(res.code).toBe('approval_refused');
    expect(JSON.stringify(res.result.structuredContent)).toContain(
      'Change the arguments',
    );
    const fresh = await w.call(w.agent(), { to: 'other@b.c' });
    expect(fresh.code).toBe('approval_pending');
    expect(fresh.approvalId).not.toBe(approvalId);
    expect(w.execute).not.toHaveBeenCalled();
  });

  it('fails closed on adapter errors, missing tenant and non-JSON arguments', async () => {
    const w = world();
    const broken = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 't', version: '1' },
      allowedClassNames: [],
      workflowTools: [
        {
          name: 'mail_send',
          description: 'x',
          effect: 'write',
          idempotent: false,
          openWorld: false,
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object' },
          execute: w.execute,
        } as unknown as McpWorkflowToolDefinition,
      ],
      confirmTools: ['mail_send'],
      approvals: {
        check: async () => {
          throw new Error('db down');
        },
      },
    });
    const run = async (
      app: typeof broken,
      principal: McpAppPrincipal,
      args: Record<string, unknown> = {},
    ) =>
      (
        (await app.callTool({ name: 'mail_send', arguments: args, principal }))
          .structuredContent as { error: { code: string } }
      ).error.code;
    expect(await run(broken, w.agent())).toBe('approval_unavailable');
    expect(await run(broken, { ...w.agent(), tenantId: undefined })).toBe(
      'approval_unavailable',
    );
    // Non-UUID tenant: the service refuses the principal, the call stays unrun.
    expect(await w.call(w.agent('cred-1', 'tenant-a'))).toMatchObject({
      code: 'approval_unavailable',
    });
    expect(await run(broken, w.agent(), { when: () => 1 } as never)).toBe(
      'approval_unavailable',
    );
    expect(w.execute).not.toHaveBeenCalled();
  });
});
