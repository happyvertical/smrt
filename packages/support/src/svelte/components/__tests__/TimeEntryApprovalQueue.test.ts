// @vitest-environment jsdom
/**
 * Component coverage for TimeEntryApprovalQueue via the shared S11 harness
 * (#1416): rendering, the approve/reject callbacks (reject collects a
 * reason first), and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { SupportTimeEntryView } from '../../types.js';
import TimeEntryApprovalQueue from '../TimeEntryApprovalQueue.svelte';

function entryView(
  overrides: Partial<SupportTimeEntryView> = {},
): SupportTimeEntryView {
  return {
    id: 'te-1',
    date: '2026-07-01',
    hours: 1.5,
    description: 'Debugged the login loop',
    status: 'submitted',
    amount: 18000, // $180.00 in cents (#2401)
    currency: 'USD',
    workerName: 'Ada',
    hourlyRate: 12000, // $120.00/h in cents
    source: 'timer',
    participantKind: 'human',
    caseId: 'case-1',
    ...overrides,
  };
}

describe('TimeEntryApprovalQueue', () => {
  it('renders date, hours, description, worker, status, and amount', async () => {
    const { container } = render(TimeEntryApprovalQueue, {
      props: { entries: [entryView()] },
    });
    expect(screen.getByText('2026-07-01')).toBeInTheDocument();
    expect(screen.getByText('1.5h')).toBeInTheDocument();
    expect(screen.getByText('Debugged the login loop')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('submitted')).toBeInTheDocument();
    expect(screen.getByText('180.00')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('omits the amount when no charge has derived yet', () => {
    render(TimeEntryApprovalQueue, {
      props: { entries: [entryView({ amount: undefined })] },
    });
    expect(screen.queryByText('180.00')).not.toBeInTheDocument();
  });

  it('scales by the currency exponent, not a hard-coded 100', () => {
    // ¥18000 is 18000 minor units — JPY has no minor unit — so dividing by 100
    // here would understate the charge a hundredfold (#2401).
    render(TimeEntryApprovalQueue, {
      props: { entries: [entryView({ currency: 'JPY' })] },
    });
    expect(screen.getByText('18000')).toBeInTheDocument();
    expect(screen.queryByText('180.00')).not.toBeInTheDocument();
  });

  it('invokes onapprove with the entry id', async () => {
    const onapprove = vi.fn();
    render(TimeEntryApprovalQueue, {
      props: { entries: [entryView()], onapprove },
    });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Approve time entry: Debugged the login loop',
      }),
    );
    expect(onapprove).toHaveBeenCalledWith('te-1');
  });

  it('collects a reason before invoking onreject', async () => {
    const onreject = vi.fn();
    const { container } = render(TimeEntryApprovalQueue, {
      props: { entries: [entryView()], onreject },
    });

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reject time entry: Debugged the login loop',
      }),
    );
    const confirmButton = screen.getByRole('button', {
      name: 'Confirm rejection of: Debugged the login loop',
    });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(
      screen.getByRole('textbox', {
        name: 'Rejection reason for: Debugged the login loop',
      }),
      'duplicate entry',
    );
    await expectNoA11yViolations(container);
    await userEvent.click(confirmButton);
    expect(onreject).toHaveBeenCalledWith('te-1', 'duplicate entry');
  });

  it('cancelling a rejection restores the actions without firing onreject', async () => {
    const onreject = vi.fn();
    render(TimeEntryApprovalQueue, {
      props: { entries: [entryView()], onreject },
    });
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Reject time entry: Debugged the login loop',
      }),
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Cancel rejecting: Debugged the login loop',
      }),
    );
    expect(onreject).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', {
        name: 'Approve time entry: Debugged the login loop',
      }),
    ).toBeInTheDocument();
  });

  it('shows no actions on rows that are not submitted', () => {
    render(TimeEntryApprovalQueue, {
      props: {
        entries: [entryView({ id: 'te-2', status: 'approved' })],
        onapprove: vi.fn(),
      },
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the empty message when there are no entries', () => {
    render(TimeEntryApprovalQueue, {
      props: { entries: [], emptyMessage: 'Nothing awaiting review' },
    });
    expect(screen.getByText('Nothing awaiting review')).toBeInTheDocument();
  });
});
