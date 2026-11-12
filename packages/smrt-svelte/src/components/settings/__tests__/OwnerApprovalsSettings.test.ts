import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import OwnerApprovalsSettings from '../OwnerApprovalsSettings.svelte';

describe('OwnerApprovalsSettings', () => {
  it.each([
    'decision',
    'poll',
  ] as const)('removes a newly completed approval observed through the existing %s transport', async (completion) => {
    const pending = {
      id: 'live',
      callId: 'call',
      tool: 'cookbook.apply',
      summary: 'Use Fresh.',
      status: 'pending' as const,
    };
    const finished = { ...pending, status: 'succeeded' as const };
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue(completion === 'poll' ? [finished] : [pending]);
    const decideApproval = vi.fn(async () => finished);
    render(OwnerApprovalsSettings, {
      props: {
        approvals: [pending],
        transport: { sendMessage: vi.fn(), listApprovals, decideApproval },
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toBeEnabled());
    if (completion === 'decision') await userEvent.setup().click(approve);
    await waitFor(
      () => expect(screen.queryByText('Use Fresh.')).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.queryByText('Approved and completed'),
    ).not.toBeInTheDocument();
  });
  it('labels the owner section and excludes terminal outcomes from its empty state', async () => {
    const { container } = render(OwnerApprovalsSettings, {
      props: {
        approvals: (['succeeded', 'denied', 'failed', 'expired'] as const).map(
          (status) => ({
            id: status,
            callId: status,
            tool: 'app.addField',
            summary: `Terminal ${status} change.`,
            status,
          }),
        ),
        transport: {
          sendMessage: vi.fn(),
          listApprovals: vi.fn(async () => []),
        },
      },
    });
    expect(
      screen.getByRole('region', { name: 'Approvals' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No changes are waiting for approval.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Terminal /)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
  it('keeps decisions disabled when the canonical owner list cannot verify the hold', async () => {
    const decideApproval = vi.fn();
    render(OwnerApprovalsSettings, {
      props: {
        approvals: [
          {
            id: 'pending',
            callId: 'call',
            tool: 'app.addField',
            summary: 'Add a field.',
            status: 'pending',
          },
        ],
        transport: {
          sendMessage: vi.fn(),
          decideApproval,
          listApprovals: vi.fn(async () => {
            throw new Error('private');
          }),
        },
      },
    });
    expect(await screen.findByRole('alert')).not.toHaveTextContent('private');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(decideApproval).not.toHaveBeenCalled();
  });
});
