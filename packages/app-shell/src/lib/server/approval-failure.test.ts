import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, returnedFailure } from './approvals.ts';
import { getHost } from './host.ts';
import { callTool } from './policy.ts';
import {
  applyWaiting,
  openShell,
  runAs,
  type ShellHarness,
} from './test-support.ts';

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  await h.close();
});

describe('an approved action that comes back as an error is a failed approval', () => {
  it('classifies returned tool and REST failures', () => {
    expect(
      returnedFailure('tool', {
        isError: true,
        content: [{ type: 'text', text: 'Error: Object not found' }],
      }),
      // Fail closed: text with no public marker is not shown (see connection-budget.test.ts).
    ).toBe('the tool could not do that; try again');
    expect(returnedFailure('tool', { isError: false, content: [] })).toBe(
      undefined,
    );
    expect(returnedFailure('rest', { status: 404, body: '{}' })).toMatch(/404/);
    expect(returnedFailure('rest', { status: 204, body: '' })).toBe(undefined);
    expect(returnedFailure('command', { version: 3 })).toBe(undefined);
  });

  it('marks the approval failed when the record vanished before it was decided', async () => {
    await runAs(h.owner, async () => {
      await callTool(h.owner, 'app_definemodel', {
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
    });
    await applyWaiting(h.owner);
    const host = await getHost();
    const rec = (await host.create('Chore', { title: 'gone soon' })) as {
      id: string;
    };
    const pending = await callTool(h.owner, 'chore_delete', { id: rec.id });
    const approvalId = JSON.parse(
      (pending.content as { text: string }[])[0].text,
    );
    const id = (approvalId.result ?? approvalId).approvalId as string;
    // The record disappears between the request and the decision.
    await host.remove('Chore', rec.id);
    const outcome = await decideApproval(id, true, h.owner.id);
    expect(outcome.status).toBe('failed');
  });
});

it('the real undo and decision routes preserve records and version after a later edit', async () => {
  const { requestRecordDelete, runAppTool, runRest } = await import(
    './builder.ts'
  );
  const { POST: undo } = await import('../../routes/api/shell/undo/+server.ts');
  const { POST: decide } = await import(
    '../../routes/api/shell/approvals/[id]/+server.ts'
  );
  const { getApprovalView } = await import('./approvals.ts');
  const host = await getHost();
  await host.execute(
    {
      type: 'defineModel',
      name: 'UndoContact',
      label: 'Contacts',
      fields: { name: { type: 'text' }, amount: { type: 'integer' } },
    },
    { author: h.owner.id, approved: true },
  );
  const row = await host.create('UndoContact', { name: 'Acme', amount: 1 });
  await host.execute(
    {
      type: 'loadRecords',
      model: 'UndoContact',
      mode: 'upsert',
      key: ['name'],
      rows: [{ name: 'Acme', amount: 2 }],
    },
    { author: h.owner.id, approved: true },
  );
  const event = (path: string, body?: unknown, id?: string) => {
    const url = new URL(path, 'http://localhost:5173');
    return {
      url,
      params: { id },
      locals: {
        user: { id: h.owner.id },
        tenantId: h.owner.tenantId,
        permissions: [],
      },
      request: new Request(url, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    } as never;
  };
  const pending = await undo(event('/api/shell/undo'));
  expect(pending.status).toBe(202);
  const approval = await pending.json();
  await host.update('UndoContact', String(row.id), { amount: 3 });
  const version = host.version;
  const response = await decide(
    event(
      `/api/shell/approvals/${approval.approvalId}`,
      { approve: true },
      approval.approvalId,
    ),
  );
  const result = await response.json();
  expect(result.status).toBe('failed');
  expect(result.error).toContain('1 record needs attention');
  expect(result.error).toContain('Contacts “Acme”');
  expect(result.error).not.toContain('the app did not start');
  expect(host.version).toBe(version);
  expect((await host.get('UndoContact', String(row.id)))?.amount).toBe(3);
  const persisted = await getApprovalView(approval.approvalId);
  expect(persisted?.status).toBe('failed');
  expect(persisted?.summary).toBe('Undo: load into Contacts');
  const deletions = [
    await requestRecordDelete(
      'UndoContact',
      String(row.id),
      h.owner.id,
      'live',
    ),
    await runAppTool(
      'undocontact_delete',
      { id: String(row.id) },
      h.owner.id,
      'live',
    ),
    await runRest(
      { method: 'DELETE', url: `/api/undo_contacts/${row.id}` },
      h.owner.id,
      'live',
    ),
  ];
  const deletionViews = await Promise.all(
    deletions.map(async (pending) => {
      if (!('approvalId' in pending))
        throw new Error('Expected delete approval');
      const saved = await getApprovalView(pending.approvalId);
      expect(saved?.preview).toMatchObject({
        modelLabel: 'Contacts',
        recordLabel: 'Acme',
      });
      expect(saved?.summary).not.toContain(String(row.id));
      return saved;
    }),
  );
  if (process.env.SMRT_ROUTE_DELETE_ARTIFACT)
    writeFileSync(
      process.env.SMRT_ROUTE_DELETE_ARTIFACT,
      JSON.stringify(deletionViews),
    );
  if (process.env.SMRT_ROUTE_APPROVAL_ARTIFACT)
    writeFileSync(
      process.env.SMRT_ROUTE_APPROVAL_ARTIFACT,
      JSON.stringify(persisted),
    );
});

it('refuses a known undo conflict before storage through HTTP and the assistant, and can deny legacy cards', async () => {
  const { POST: undo } = await import('../../routes/api/shell/undo/+server.ts');
  const { POST: decide } = await import(
    '../../routes/api/shell/approvals/[id]/+server.ts'
  );
  const { pendingApprovalCount, requestApproval, getApprovalView } =
    await import('./approvals.ts');
  const host = await getHost();
  await host.execute(
    {
      type: 'defineModel',
      name: 'Order',
      label: 'Orders',
      fields: { name: { type: 'text' }, amount: { type: 'integer' } },
    },
    { author: h.owner.id, approved: true },
  );
  const row = await host.create('Order', {
    name: 'QA changed order',
    amount: 1,
  });
  await host.execute(
    {
      type: 'loadRecords',
      model: 'Order',
      mode: 'upsert',
      key: ['name'],
      rows: [{ name: 'QA changed order', amount: 2 }],
    },
    { author: h.owner.id, approved: true },
  );
  await host.update('Order', String(row.id), { amount: 3 });
  const count = await pendingApprovalCount();
  const version = host.version;
  const reason =
    'Cannot undo: 1 record needs attention. Orders “QA changed order”: changed since the command; undo would lose those edits';
  const event = (path: string, body?: unknown, id?: string) => {
    const url = new URL(path, 'http://localhost:5173');
    return {
      url,
      params: { id },
      locals: {
        user: { id: h.owner.id },
        tenantId: h.owner.tenantId,
        permissions: [],
      },
      request: new Request(url, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    } as never;
  };
  const response = await undo(event('/api/shell/undo'));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: reason, code: 'refused' });
  // undo is the owner's from History: the tool door refuses it outright
  await expect(callTool(h.owner, 'app_undo', {})).resolves.toMatchObject({
    isError: true,
  });
  expect(await pendingApprovalCount()).toBe(count);
  expect(host.version).toBe(version);
  expect((await host.get('Order', String(row.id)))?.amount).toBe(3);
  // Simulate a pre-upgrade pending row using the real engine conflict preview.
  const plan = await host.plan({ type: 'undo' });
  const legacy = await requestApproval(
    { kind: 'command', command: { type: 'undo', version } },
    plan,
    h.owner.id,
  );
  const stored = await getApprovalView(legacy.approvalId);
  if (process.env.SMRT_ROUTE_BLOCKED_ARTIFACT)
    writeFileSync(
      process.env.SMRT_ROUTE_BLOCKED_ARTIFACT,
      JSON.stringify(stored),
    );
  const denied = await decide(
    event(
      `/api/shell/approvals/${legacy.approvalId}`,
      { approve: false },
      legacy.approvalId,
    ),
  );
  expect((await denied.json()).status).toBe('denied');
  expect(await pendingApprovalCount()).toBe(count);
  expect(host.version).toBe(version);
  expect((await host.get('Order', String(row.id)))?.amount).toBe(3);
  // Removing the conflict restores the ordinary decidable undo path.
  await host.update('Order', String(row.id), { amount: 2 });
  const allowed = await undo(event('/api/shell/undo'));
  expect(allowed.status).toBe(202);
  const pending = await allowed.json();
  const applied = await decide(
    event(
      `/api/shell/approvals/${pending.approvalId}`,
      { approve: true },
      pending.approvalId,
    ),
  );
  expect((await applied.json()).status).toBe('approved');
  expect((await host.get('Order', String(row.id)))?.amount).toBe(1);
});
