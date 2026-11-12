import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PrebuiltComponentsSettings from '../PrebuiltComponentsSettings.svelte';

describe('PrebuiltComponentsSettings', () => {
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
    render(PrebuiltComponentsSettings, {
      props: {
        enabled: true,
        onsave: vi.fn(),
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
  it('shows an explained keyboard switch and excludes all terminal approval results', async () => {
    const onsave = vi.fn(async () => {});
    const { container } = render(PrebuiltComponentsSettings, {
      props: {
        enabled: true,
        onsave,
        transport: { sendMessage: vi.fn() },
        approvals: (['succeeded', 'denied', 'failed', 'expired'] as const).map(
          (status, i) => ({
            id: String(i),
            callId: 'call',
            tool: 'cookbook.apply',
            summary: 'Yoga Studio set up.',
            status,
          }),
        ),
      },
    });
    expect(
      screen.getByText(/Turning this off keeps your existing information/),
    ).toBeInTheDocument();
    const toggle = screen.getByRole('checkbox', {
      name: 'Use pre-built components',
    });
    expect(toggle).toBeChecked();
    expect(
      screen.queryByText(/Yoga Studio|Approved and completed/),
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard(' ');
    await waitFor(() => expect(onsave).toHaveBeenCalledWith(false));
    expect(screen.getByRole('status')).toHaveTextContent('Off');
    await expectNoA11yViolations(container);
  });
  it('restores the previous choice on failure and keeps unsettled owner decisions reachable', async () => {
    const pending = {
      id: 'pending',
      callId: 'call',
      tool: 'cookbook.apply',
      summary: 'Use Fresh.',
      status: 'pending' as const,
    };
    render(PrebuiltComponentsSettings, {
      props: {
        enabled: false,
        onsave: vi.fn(async () => {
          throw new Error('private');
        }),
        approvals: [pending],
        transport: {
          sendMessage: vi.fn(),
          listApprovals: vi.fn(async () => [pending]),
          decideApproval: vi.fn(async () => pending),
        },
      },
    });
    const user = userEvent.setup();
    const toggle = screen.getByRole('checkbox', {
      name: 'Use pre-built components',
    });
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
    expect(screen.getByText('Use Fresh.')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Approve' }),
    ).toBeInTheDocument();
  });
});
