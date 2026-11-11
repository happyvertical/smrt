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
  it('shows the persisted summary, approves once, and announces the outcome', async () => {
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = vi.fn(async () => [approval]);
    transport.decideApproval = vi.fn(async () => ({
      ...approval,
      status: 'succeeded',
    }));
    const ondecided = vi.fn();
    render(AssistantApprovalCard, {
      props: { approval, threadId: 't1', transport, ondecided },
    });
    expect(screen.getByText(approval.summary)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    await vi.waitFor(() =>
      expect(approve.hasAttribute('disabled')).toBe(false),
    );
    await userEvent.click(approve);
    expect(await screen.findByText('Approved and completed')).toBeTruthy();
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

  it('keeps controls disabled until storage verifies the pending state and reports failure accessibly', async () => {
    const transport = createInMemoryAssistantTransport();
    transport.listApprovals = vi.fn(async () => {
      throw new Error('forbidden');
    });
    transport.decideApproval = vi.fn();
    render(AssistantApprovalCard, {
      props: { approval, threadId: 't1', transport },
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
