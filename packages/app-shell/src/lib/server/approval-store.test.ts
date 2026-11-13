import { OwnerApprovalAuthority } from '@happyvertical/smrt-app-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalCollection } from '../objects/Approval.ts';
import { shellApprovalAuthority } from './approval-store.ts';
import { getApprovalView, requestApproval } from './approvals.ts';
import { holdForUser } from './assistant/hold.ts';
import { openShell, type ShellHarness } from './test-support.ts';

let h: ShellHarness;
beforeEach(async () => {
  h = await openShell();
});
afterEach(async () => {
  await h.close();
});

async function legacy(
  status: 'pending' | 'approved' | 'denied' | 'failed',
  result = '',
) {
  const row = await (await ApprovalCollection.create({ db: h.db })).create({
    command: JSON.stringify({
      kind: 'record-delete',
      model: 'Chore',
      id: 'old-record',
    }),
    actionKey: 'old-action',
    summary: 'Delete the old chore',
    preview: '{"rows":1}',
    status,
    requestedBy: h.owner.id,
    createdAt: '2024-01-01T00:00:00.000Z',
    decidedBy: status === 'pending' ? '' : h.owner.id,
    decidedAt: status === 'pending' ? '' : '2024-01-02T00:00:00.000Z',
    result,
  });
  await row.save();
  return row.id as string;
}

describe('shared authority over installed Tricia approval rows', () => {
  it('keeps old pending ids/previews and all decided history without a data migration', async () => {
    const pending = await legacy('pending');
    const approved = await legacy('approved', '{"removed":true}');
    const denied = await legacy('denied');
    const failed = await legacy('failed', '{"error":"failed before upgrade"}');
    const { authority, tenantId } = await shellApprovalAuthority();
    expect(authority).toBeInstanceOf(OwnerApprovalAuthority);
    expect(await authority.get(tenantId, pending)).toMatchObject({
      id: pending,
      status: 'pending',
      context: { preview: '{"rows":1}' },
    });
    expect((await getApprovalView(pending))?.preview).toEqual({ rows: 1 });
    const reopened = (await shellApprovalAuthority()).authority;
    expect(
      (await reopened.list(h.owner, false)).map((row) => row.id).sort(),
    ).toEqual([pending, approved, denied, failed].sort());
    expect(await reopened.get(tenantId, approved)).toMatchObject({
      status: 'succeeded',
      result: { removed: true },
    });
    expect(await getApprovalView(approved)).toMatchObject({
      id: approved,
      status: 'approved',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    await reopened.decide(h.owner, pending, false);
    expect(await getApprovalView(pending)).toMatchObject({
      status: 'denied',
      decidedBy: h.owner.id,
    });
  });

  it('checks live owner membership and tenant and makes decisions and consumption single-use across instances', async () => {
    const id = await legacy('pending');
    const first = await shellApprovalAuthority();
    const second = await shellApprovalAuthority();
    await expect(
      first.authority.decide(h.member, id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      first.authority.decide(h.stranger, id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      first.authority.decide({ ...h.owner, tenantId: 'foreign' }, id, true),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await first.authority.get('foreign', id)).toBeNull();
    const decisions = await Promise.allSettled([
      first.authority.decide(h.owner, id, true),
      second.authority.decide(h.owner, id, true),
    ]);
    expect(decisions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const consumers = await Promise.allSettled([
      first.authority.consume(first.tenantId, id),
      second.authority.consume(second.tenantId, id),
    ]);
    expect(consumers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const reopened = (await shellApprovalAuthority()).authority;
    await expect(reopened.consume(first.tenantId, id)).rejects.toMatchObject({
      code: 'conflict',
    });
    await reopened.complete(first.tenantId, id, true, { removed: true });
    await expect(
      reopened.complete(first.tenantId, id, false, { error: 'overwritten' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await getApprovalView(id)).toMatchObject({
      status: 'approved',
      result: { removed: true },
    });
  });

  it('observes completion through the shared hold bridge, including another authority, timeout and abort', async () => {
    const id = await legacy('pending');
    const { authority, tenantId } = await shellApprovalAuthority();
    const waiting = holdForUser(id, {
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    await authority.decide(h.owner, id, true);
    await authority.consume(tenantId, id);
    expect(
      await holdForUser(id, {
        signal: new AbortController().signal,
        timeoutMs: 20,
      }),
    ).toEqual({ status: 'timeout' });
    await authority.complete(tenantId, id, true, { removed: true });
    expect(await waiting).toEqual({
      status: 'approved',
      result: { removed: true },
    });
    const signal = new AbortController();
    signal.abort();
    expect(
      await holdForUser(id, { signal: signal.signal, timeoutMs: 5000 }),
    ).toEqual({ status: 'aborted' });
  });

  it('preserves larger, validated template actions as inert JSON in the shared envelope', async () => {
    const { authority, tenantId } = await shellApprovalAuthority();
    const action = JSON.stringify({
      kind: 'command',
      command: { type: 'importTemplate', data: { code: 'x'.repeat(150_000) } },
    });
    const saved = await authority.request({
      tenantId,
      requestedBy: h.owner.id,
      tool: 'shell.action',
      callId: 'large-template',
      args: { action },
      summary: 'Import the reviewed template',
      context: { preview: '{}' },
    });
    expect(saved.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    expect((await authority.get(tenantId, saved.id))?.args.action).toBe(action);
    expect((await getApprovalView(saved.id))?.action).toEqual(
      JSON.parse(action),
    );
  });

  it('preserves nested draft field defaults and code in the approval preview', async () => {
    const preview = {
      definition: {
        models: {
          Example: {
            fieldsChanged: [
              {
                from: {
                  type: 'json',
                  default: { one: { two: { three: 'original' } } },
                },
                to: {
                  type: 'json',
                  default: { one: { two: { three: 'changed' } } },
                },
              },
            ],
          },
        },
      },
    };
    const pending = await requestApproval(
      {
        kind: 'publish-draft',
        draftId: 'draft',
        draftName: 'Nested defaults',
        digest: 'pinned-preview',
      },
      { summary: 'Publish nested defaults', risky: true, preview },
      h.owner.id,
    );
    expect(pending.preview).toEqual(preview);
    expect((await getApprovalView(pending.approvalId))?.preview).toEqual(
      preview,
    );
  });

  it('never replays a legacy approval interrupted between decision and result', async () => {
    const id = await legacy('approved');
    const { authority, tenantId } = await shellApprovalAuthority();
    expect(await authority.get(tenantId, id)).toMatchObject({
      status: 'executing',
    });
    await expect(authority.decide(h.owner, id, true)).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(authority.consume(tenantId, id)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await holdForUser(id, {
        signal: new AbortController().signal,
        timeoutMs: 20,
      }),
    ).toEqual({ status: 'timeout' });
  });
});
