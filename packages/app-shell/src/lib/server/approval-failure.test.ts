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
