import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpAuditRecord } from '../audit.js';
import { createSmrtMcpAuditStore } from '../audit-store.js';
import { createMcpAppServer } from '../server.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'smrt-app-mcp-audit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(extra: Partial<McpAuditRecord> = {}): McpAuditRecord {
  return {
    principalId: 'cred-1',
    principalKind: 'agent',
    tool: 'crm_search',
    tenantId: 'tenant-a',
    outcome: 'allowed',
    argumentKeys: ['limit', 'query'],
    occurredAt: new Date('2026-11-13T10:00:00Z'),
    ...extra,
  };
}

describe('SMRT-model audit store', () => {
  function store() {
    return createSmrtMcpAuditStore({
      smrtOptions: () => ({
        db: { type: 'sqlite', url: join(dir, 'a.sqlite'), cache: false },
      }),
    });
  }

  it('persists and lists records by tenant and principal, newest first', async () => {
    const s = store();
    await s.record(record());
    await s.record(
      record({
        principalId: 'user-1',
        principalKind: 'owner',
        tool: 'mail_send',
        outcome: 'denied',
        errorCode: 'confirm_required',
        occurredAt: new Date('2026-11-13T11:00:00Z'),
      }),
    );
    await s.record(record({ tenantId: 'tenant-b' }));

    const a = await s.list({ tenantId: 'tenant-a' });
    expect(a.map((r) => r.tool)).toEqual(['mail_send', 'crm_search']);
    expect(a[0]).toMatchObject({
      principalKind: 'owner',
      outcome: 'denied',
      errorCode: 'confirm_required',
      tenantId: 'tenant-a',
    });
    expect(a[1].argumentKeys).toEqual(['limit', 'query']);
    expect(a[1].occurredAt.toISOString()).toBe('2026-11-13T10:00:00.000Z');

    expect(
      await s.list({ tenantId: 'tenant-a', principalId: 'cred-1' }),
    ).toHaveLength(1);
    expect(await s.list({ tenantId: 'tenant-b' })).toHaveLength(1);
    expect(await s.list({ tenantId: 'tenant-c' })).toEqual([]);
    expect(await s.list({ tenantId: 'tenant-a', limit: 1 })).toHaveLength(1);
  });

  it('stores anonymous calls as global rows and requires an explicit tenant to read', async () => {
    const s = store();
    await s.record(
      record({ tenantId: null, principalId: null, principalKind: null }),
    );
    const global = await s.list({ tenantId: null });
    expect(global).toHaveLength(1);
    expect(global[0].principalId).toBeNull();
    await expect(s.list({} as never)).rejects.toThrow(TypeError);
    expect(await s.list({ tenantId: 'tenant-a' })).toEqual([]);
  });

  it('works as the server auditSink end to end', async () => {
    const s = store();
    const app = createMcpAppServer({
      smrtOptions: () => ({}),
      serverInfo: { name: 't', version: '1' },
      allowedClassNames: [],
      auditSink: s,
      workflowTools: [
        {
          name: 'crm_search',
          description: 'x',
          effect: 'read',
          idempotent: true,
          openWorld: false,
          inputSchema: { type: 'object', properties: {} },
          outputSchema: { type: 'object' },
          execute: () => ({ content: [{ type: 'text', text: 'ok' }] }),
        },
      ],
    });
    await app.callTool({
      name: 'crm_search',
      arguments: { query: 'SECRET' },
      principal: { id: 'cred-1', kind: 'agent', tenantId: 'tenant-a' },
    });
    const rows = await s.list({ tenantId: 'tenant-a', principalId: 'cred-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'crm_search',
      argumentKeys: ['query'],
    });
    expect(JSON.stringify(rows)).not.toContain('SECRET');
  });
});
