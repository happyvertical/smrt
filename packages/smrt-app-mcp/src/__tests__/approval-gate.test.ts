import { describe, expect, it, vi } from 'vitest';
import {
  type McpApprovalGate,
  type McpApprovalGateRequest,
  mcpApprovalBindingHash,
} from '../approval-gate.js';
import { createMcpAppServer, type McpAppPrincipal } from '../server.js';
import type { McpWorkflowToolDefinition } from '../workflow-tools.js';

const owner: McpAppPrincipal = {
  id: 'user-1',
  kind: 'owner',
  tenantId: 'tenant-a',
  scopes: [],
};

function make(gate: McpApprovalGate) {
  const execute = vi.fn(() => ({ content: [{ type: 'text', text: 'ok' }] }));
  const app = createMcpAppServer({
    smrtOptions: () => ({}),
    serverInfo: { name: 't', version: '1' },
    allowedClassNames: [],
    workflowTools: [
      {
        name: 'wipe',
        description: 'wipe',
        effect: 'write',
        idempotent: false,
        openWorld: false,
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        execute,
      } as unknown as McpWorkflowToolDefinition,
    ],
    confirmTools: ['wipe'],
    approvals: gate,
  });
  return { app, execute };
}

describe('mcpApprovalBindingHash', () => {
  const base = { tool: 't', tenantId: 'a', principalId: 'p' };
  it('ignores key order and binds tool, tenant, principal and values', async () => {
    const h = (over = {}, args: Record<string, unknown> = { a: 1, b: [1] }) =>
      mcpApprovalBindingHash({ ...base, ...over, args });
    expect(await h()).toBe(await h({}, { b: [1], a: 1 }));
    expect(await h({ tool: 'u' })).not.toBe(await h());
    expect(await h({ tenantId: 'b' })).not.toBe(await h());
    expect(await h({ principalId: 'q' })).not.toBe(await h());
    expect(await h({}, { a: 2, b: [1] })).not.toBe(await h());
  });
  it('rejects values that are not plain JSON', async () => {
    for (const bad of [() => 1, 1n, new Date(), Number.NaN, undefined]) {
      await expect(
        mcpApprovalBindingHash({ ...base, args: { x: bad } as never }),
      ).rejects.toThrow();
    }
  });
});

describe('approvals option', () => {
  it('passes the binding without confirm and runs only on approved', async () => {
    const seen: McpApprovalGateRequest[] = [];
    let state: 'pending' | 'approved' | 'refused' = 'pending';
    const { app, execute } = make({
      check: async (request) => {
        seen.push(request);
        return state === 'approved'
          ? { state }
          : state === 'refused'
            ? { state, reason: 'rejected' }
            : { state, created: true, approvalId: 'x' };
      },
    });
    const call = (args: Record<string, unknown>) =>
      app.callTool({ name: 'wipe', arguments: args, principal: owner });
    expect((await call({ confirm: true, n: 1 })).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    state = 'refused';
    expect((await call({ n: 1 })).isError).toBe(true);
    state = 'approved';
    expect((await call({ n: 1 })).isError).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(seen[0].bindingHash).toBe(seen[2].bindingHash);
    expect(seen[0]).toMatchObject({
      tenantId: 'tenant-a',
      principalId: 'user-1',
    });
  });

  it('refuses anonymous callers and malformed gate answers', async () => {
    const { app, execute } = make({ check: async () => ({}) as never });
    const res = await app.callTool({
      name: 'wipe',
      arguments: {},
      principal: owner,
    });
    expect(
      (res.structuredContent as { error: { code: string } }).error.code,
    ).toBe('approval_unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
});
