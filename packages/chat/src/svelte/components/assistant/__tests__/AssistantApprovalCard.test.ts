// @vitest-environment jsdom
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantApprovalView } from '../../../../assistant-turn-events.js';
import AssistantApprovalCard from '../AssistantApprovalCard.svelte';
import { createInMemoryAssistantTransport } from '../assistant-transport.js';

const approval: AssistantApprovalView = {
  id: 'a1',
  callId: 'c1',
  tool: 'invoices.delete',
  summary: 'Delete invoice INV-1?',
  status: 'pending',
};

describe('AssistantApprovalCard', () => {
  it.each([
    undefined,
    { summary: 'Add Licence plate to Members' },
  ])('uses only explicit host presentation in generic mode (%j)', async (presentation) => {
    const raw = {
      ...approval,
      summary: 'PRIVATE TenantId ProfileId @fixture/models:Member',
      ...(presentation ? { presentation } : {}),
    };
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = async () => [raw];
    transport.decideApproval = async () => ({ ...raw, status: 'succeeded' });
    const view = render(AssistantApprovalCard, {
      props: { approval: raw, transport, toolPresentation: 'generic' },
    });
    expect(
      await screen.findByText(presentation?.summary ?? 'Review this change'),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Approve' }),
      ).not.toBeDisabled(),
    );
    expect(view.container.textContent).not.toMatch(
      /PRIVATE|TenantId|ProfileId|@fixture/,
    );
  });
  it.each([
    undefined,
    't1',
  ])('shows the persisted summary, approves once, and announces the outcome with thread %s', async (threadId) => {
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = vi.fn(async () => [approval]);
    transport.decideApproval = vi.fn(async () => ({
      ...approval,
      status: 'succeeded',
    }));
    const ondecided = vi.fn();
    render(AssistantApprovalCard, {
      props: { approval, threadId, transport, ondecided },
    });
    expect(screen.getByText(approval.summary)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await vi.waitFor(() =>
      expect(approve.hasAttribute('disabled')).toBe(false),
    );
    await userEvent.click(approve);
    expect(await screen.findByText('Approved and completed')).toBeTruthy();
    expect(transport.listApprovals).toHaveBeenCalledWith(threadId);
    expect(transport.decideApproval).toHaveBeenCalledExactlyOnceWith(
      'a1',
      true,
    );
    expect(ondecided).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('denies and restores terminal state from storage on reload', async () => {
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = vi.fn(async () => [approval]);
    transport.decideApproval = vi.fn(async () => ({
      ...approval,
      status: 'denied',
    }));
    const first = render(AssistantApprovalCard, {
      props: { approval, threadId: 't1', transport },
    });
    const deny = screen.getByRole('button', { name: 'Deny' });
    await vi.waitFor(() => expect(deny.hasAttribute('disabled')).toBe(false));
    await userEvent.click(deny);
    expect(
      await screen.findByText('Denied. The tool did not run.'),
    ).toBeTruthy();
    expect(transport.decideApproval).toHaveBeenCalledWith('a1', false);
    first.unmount();
    transport.listApprovals = async () => [{ ...approval, status: 'expired' }];
    render(AssistantApprovalCard, {
      props: { approval, threadId: 't1', transport },
    });
    expect(
      await screen.findByText('Expired. The tool did not run.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it.each([
    undefined,
    't1',
  ])('keeps controls disabled until storage verifies the pending state and reports failure accessibly with thread %s', async (threadId) => {
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = vi.fn(async () => {
      throw new Error('forbidden');
    });
    transport.decideApproval = vi.fn();
    render(AssistantApprovalCard, {
      props: { approval, threadId, transport },
    });
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Could not update this approval. Try again.',
    );
    expect(
      screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(transport.decideApproval).not.toHaveBeenCalled();
  });
});
