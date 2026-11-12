import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import OwnerApprovalsSettings from '../OwnerApprovalsSettings.svelte';

describe('OwnerApprovalsSettings', () => {
  it('returns the observed approved status to a card when an older pending list finishes afterward', async () => {
    const pending = {
      id: 'stale',
      callId: 'call',
      tool: 'app.addField',
      summary: 'Keep this decision.',
      status: 'pending' as const,
    };
    let release!: (rows: (typeof pending)[]) => void;
    const older = new Promise<(typeof pending)[]>((resolve) => {
      release = resolve;
    });
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockImplementation(() => older);
    const ondecided = vi.fn();
    const onsettled = vi.fn();
    const { unmount } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [pending],
        transport: {
          sendMessage: vi.fn(),
          listApprovals,
          decideApproval: async () => ({ ...pending, status: 'approved' }),
        },
        ondecided,
        onsettled,
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toBeEnabled());
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2), {
      timeout: 2000,
    });
    await userEvent.setup().click(approve);
    await waitFor(() => expect(ondecided).toHaveBeenCalledOnce());
    release([pending]);
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Approve' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole('button', { name: 'Deny' }),
    ).not.toBeInTheDocument();
    expect(onsettled).not.toHaveBeenCalled();
    unmount();
  });

  it('retains another hold terminalized while the first settlement refresh awaits invalidation', async () => {
    const first = {
      id: 'first',
      callId: 'first',
      tool: 'app.addField',
      summary: 'First change.',
      status: 'pending' as const,
    };
    const second = {
      ...first,
      id: 'second',
      callId: 'second',
      summary: 'Second change.',
    };
    let release!: () => void;
    const invalidation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onsettled = vi.fn(async () => {
      if (onsettled.mock.calls.length === 1) await invalidation;
    });
    const { rerender, unmount } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [first, second],
        transport: {
          sendMessage: vi.fn(),
          listApprovals: () => new Promise(() => {}),
        },
        onsettled,
      },
    });
    await rerender({ approvals: [{ ...first, status: 'succeeded' }, second] });
    await waitFor(() => expect(onsettled).toHaveBeenCalledOnce());
    await rerender({
      approvals: [
        { ...first, status: 'succeeded' },
        { ...second, status: 'succeeded' },
      ],
    });
    await waitFor(() => expect(onsettled).toHaveBeenCalledTimes(2));
    release();
    await waitFor(() =>
      expect(screen.queryByText(second.summary)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(first.summary)).not.toBeInTheDocument();
    expect(onsettled).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('notifies settlement once before removing a delayed executing card, preserving decision callbacks', async () => {
    const pending = {
      id: 'delayed',
      callId: 'call',
      tool: 'app.addField',
      summary: 'Add Licence plate.',
      status: 'pending' as const,
    };
    let status: 'pending' | 'approved' | 'executing' | 'succeeded' = 'pending';
    const ondecided = vi.fn();
    const onsettled = vi.fn(async () => {
      expect(screen.getByText(pending.summary)).toBeInTheDocument();
      await rerender({ approvals: [{ ...pending, status: 'succeeded' }] });
    });
    const listApprovals = vi.fn(async () => [{ ...pending, status }]);
    const { rerender } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [pending],
        transport: {
          sendMessage: vi.fn(),
          listApprovals,
          decideApproval: async () => {
            status = 'approved';
            return { ...pending, status };
          },
        },
        ondecided,
        onsettled,
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.setup().click(approve);
    await waitFor(() => expect(ondecided).toHaveBeenCalledOnce());
    expect(onsettled).not.toHaveBeenCalled();
    status = 'executing';
    await screen.findByText('Approved. Running…', {}, { timeout: 3000 });
    expect(onsettled).not.toHaveBeenCalled();
    status = 'succeeded';
    await waitFor(() => expect(onsettled).toHaveBeenCalledOnce(), {
      timeout: 3000,
    });
    expect(screen.queryByText(pending.summary)).not.toBeInTheDocument();
    await rerender({ approvals: [{ ...pending, status }] });
    await waitFor(() =>
      expect(listApprovals.mock.calls.length).toBeGreaterThan(2),
    );
    expect(onsettled).toHaveBeenCalledOnce();
    expect(ondecided).toHaveBeenCalledOnce();
  });

  it('observes externally completed props before removing the known card and ignores historical successes on recreation', async () => {
    const pending = {
      id: 'external',
      callId: 'call',
      tool: 'app.addField',
      summary: 'Add a field.',
      status: 'pending' as const,
    };
    const finished = { ...pending, status: 'succeeded' as const };
    const onsettled = vi.fn(() => {
      expect(screen.getByText(pending.summary)).toBeInTheDocument();
    });
    const ondecided = vi.fn();
    const transport = {
      sendMessage: vi.fn(),
      listApprovals: vi.fn(async () => [finished]),
    };
    const first = render(OwnerApprovalsSettings, {
      props: { approvals: [pending], transport, onsettled, ondecided },
    });
    await waitFor(() => expect(onsettled).toHaveBeenCalledOnce());
    expect(screen.queryByText(pending.summary)).not.toBeInTheDocument();
    expect(ondecided).not.toHaveBeenCalled();
    await first.rerender({ approvals: [finished] });
    first.unmount();
    const callsBeforeRemount = transport.listApprovals.mock.calls.length;
    const recreated = render(OwnerApprovalsSettings, {
      props: { approvals: [finished], transport, onsettled },
    });
    await waitFor(() =>
      expect(transport.listApprovals).toHaveBeenCalledTimes(
        callsBeforeRemount + 1,
      ),
    );
    expect(onsettled).toHaveBeenCalledOnce();
    recreated.unmount();
  });

  it('discovers an out-of-band hold from an empty list and hands polling to its card', async () => {
    const pending = {
      id: 'discovered',
      callId: 'call',
      tool: 'app.addField',
      summary: 'Add Licence plate.',
      status: 'pending' as const,
    };
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([pending]);
    const onsettled = vi.fn();
    const view = render(OwnerApprovalsSettings, {
      props: {
        approvals: [],
        transport: {
          sendMessage: vi.fn(),
          listApprovals,
          decideApproval: vi.fn(),
        },
        onsettled,
      },
    });
    expect(
      screen.getByText('No changes are waiting for approval.'),
    ).toBeInTheDocument();
    await screen.findByText(pending.summary, {}, { timeout: 3000 });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled(),
    );
    expect(listApprovals).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(4), {
      timeout: 2000,
    });
    expect(onsettled).not.toHaveBeenCalled();
    view.unmount();
  });

  it('coalesces discovery with card handoff and discards the obsolete discovery result', async () => {
    const pending = {
      id: 'handoff',
      callId: 'call',
      tool: 'app.addField',
      summary: 'New hold.',
      status: 'pending' as const,
    };
    let finish!: (rows: (typeof pending)[]) => void;
    const response = new Promise<(typeof pending)[]>((resolve) => {
      finish = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    const listApprovals = vi.fn(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await response;
      } finally {
        active--;
      }
    });
    const { rerender, unmount } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [],
        transport: { sendMessage: vi.fn(), listApprovals },
      },
    });
    await waitFor(() => expect(listApprovals).toHaveBeenCalledOnce());
    await rerender({ approvals: [pending] });
    expect(screen.getByText(pending.summary)).toBeInTheDocument();
    expect(listApprovals).toHaveBeenCalledOnce();
    finish([pending]);
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
    expect(maximumActive).toBe(1);
    unmount();
  });

  it.each([
    'succeeded',
    'denied',
    'failed',
    'expired',
  ] as const)('never resurrects stale pending views after canonical %s', async (status) => {
    const pending = {
      id: 'terminal',
      callId: 'call',
      tool: 'app.addField',
      summary: 'A change.',
      status: 'pending' as const,
    };
    const finished = { ...pending, status };
    const onsettled = vi.fn();
    const listApprovals = vi
      .fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValue([pending]);
    const { unmount } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [pending],
        transport: {
          sendMessage: vi.fn(),
          listApprovals,
          decideApproval: async () => finished,
        },
        onsettled,
      },
    });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.setup().click(approve);
    await waitFor(() =>
      expect(screen.queryByText(pending.summary)).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(listApprovals.mock.calls.length).toBeGreaterThan(1),
    );
    expect(
      screen.queryByRole('button', { name: 'Approve' }),
    ).not.toBeInTheDocument();
    expect(onsettled).toHaveBeenCalledTimes(status === 'succeeded' ? 1 : 0);
    unmount();
  });

  it('retries failed empty discovery without exposing errors and cancels late results on unmount', async () => {
    let finish!: (rows: never[]) => void;
    const listApprovals = vi
      .fn()
      .mockRejectedValueOnce(new Error('PRIVATE'))
      .mockImplementation(
        () =>
          new Promise<never[]>((resolve) => {
            finish = resolve;
          }),
      );
    const onsettled = vi.fn();
    const { unmount } = render(OwnerApprovalsSettings, {
      props: {
        approvals: [],
        transport: { sendMessage: vi.fn(), listApprovals },
        onsettled,
      },
    });
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(screen.queryByText('PRIVATE')).not.toBeInTheDocument();
    unmount();
    finish([]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(onsettled).not.toHaveBeenCalled();
  });

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
