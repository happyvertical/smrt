// @vitest-environment jsdom
/**
 * Component coverage for ApprovalActions via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ApprovalActions from '../ApprovalActions.svelte';

describe('ApprovalActions', () => {
  it('offers Submit/Delete for a draft and submits on click', async () => {
    const onsubmit = vi.fn();
    render(ApprovalActions, {
      props: { status: 'draft' as any, onsubmit, ondelete: vi.fn() },
    });
    expect(
      screen.getByRole('button', { name: 'Submit for Approval' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Submit for Approval' }),
    );
    expect(onsubmit).toHaveBeenCalledTimes(1);
  });

  it('offers Approve/Reject for a submitted entry', async () => {
    const onapprove = vi.fn();
    render(ApprovalActions, {
      props: { status: 'submitted' as any, onapprove, onreject: vi.fn() },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onapprove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('shows the approved status message', () => {
    render(ApprovalActions, { props: { status: 'approved' as any } });
    expect(
      screen.getByText('This entry has been approved'),
    ).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(ApprovalActions, {
      props: {
        status: 'submitted' as any,
        onapprove: vi.fn(),
        onreject: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
