import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideApproval, returnedFailure } from './approvals.ts';
import { getHost } from './host.ts';
import { callTool } from './policy.ts';
import { openShell, runAs, type ShellHarness } from './test-support.ts';

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
    ).toBe('Error: Object not found');
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
  const { runCommand } = await import('./builder.ts');
  const { POST: undo } = await import('../../routes/api/shell/undo/+server.ts');
  const { POST: decide } = await import(
    '../../routes/api/shell/approvals/[id]/+server.ts'
  );
  const { getApprovalView } = await import('./approvals.ts');
  const host = await getHost();
  await runCommand(
    {
      type: 'defineModel',
      name: 'UndoContact',
      label: 'Contacts',
      fields: { name: { type: 'text' }, amount: { type: 'integer' } },
    },
    h.owner.id,
    'live',
  );
  const row = await host.create('UndoContact', { name: 'Acme', amount: 1 });
  const load = await runCommand(
    {
      type: 'loadRecords',
      model: 'UndoContact',
      mode: 'upsert',
      key: ['name'],
      rows: [{ name: 'Acme', amount: 2 }],
    },
    h.owner.id,
    'live',
  );
  if (!('approvalId' in load)) throw new Error('expected load approval');
  await decideApproval(load.approvalId, true, h.owner.id);
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
  expect((await getApprovalView(approval.approvalId))?.status).toBe('failed');
});
