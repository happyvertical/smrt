// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import AssistanceLauncher from '../../AssistanceLauncher.svelte';
import DevelopmentBoard from '../../DevelopmentBoard.svelte';
import DevelopmentRequestDetail from '../../DevelopmentRequestDetail.svelte';
import PreviewApprovalPanel from '../../PreviewApprovalPanel.svelte';

describe('managed application delivery surfaces', () => {
  it('submits Assistance intake without dropping requester context or evidence', async () => {
    const onsubmit = vi.fn();
    const { container } = render(AssistanceLauncher, {
      props: {
        requesterId: 'requester-1',
        applicationContext: { route: '/invoices' },
        evidence: [{ url: 'https://evidence.invalid/screenshot' }],
        onsubmit,
      },
    });
    await userEvent.type(screen.getByLabelText('Subject'), 'Export failed');
    await userEvent.type(
      screen.getByLabelText('What do you need?'),
      'The CSV export returns an error.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(onsubmit).toHaveBeenCalledWith({
      requesterId: 'requester-1',
      subject: 'Export failed',
      applicationContext: { route: '/invoices' },
      conversation: [{ body: 'The CSV export returns an error.' }],
      evidence: [{ url: 'https://evidence.invalid/screenshot' }],
    });
    await expectNoA11yViolations(container);
  });

  it('renders projected board work and selects a request', async () => {
    const onselect = vi.fn();
    const { container } = render(DevelopmentBoard, {
      props: {
        requests: [
          {
            id: 'r1',
            description: 'Add CSV export',
            type: 'feature',
            status: 'planned',
          },
        ],
        onselect,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: /Add CSV export/i }),
    );
    expect(onselect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'r1' }),
    );
    await expectNoA11yViolations(container);
  });

  it('renders an accessible empty state and provider-neutral issue detail', async () => {
    const { container, rerender } = render(DevelopmentBoard);
    expect(screen.getByText('No visible development work')).toBeVisible();
    await expectNoA11yViolations(container);

    await rerender({ requests: [] });
    const detail = render(DevelopmentRequestDetail, {
      props: {
        request: {
          id: 'r2',
          title: 'Export invoices',
          description: 'Add an invoice export.',
          type: 'feature',
          status: 'planned',
          visibility: 'workspace',
          requesterLabel: 'Client owner',
        },
        events: [
          {
            id: 'e1',
            sequence: 1,
            type: 'pull_request',
            label: 'Pull request opened',
            occurredAt: '2026-07-11T12:00:00Z',
          },
        ],
      },
    });
    expect(
      screen.getByRole('heading', { name: 'Export invoices' }),
    ).toBeVisible();
    expect(screen.getByText('Pull request opened')).toBeVisible();
    await expectNoA11yViolations(detail.container);
  });

  it('allows one preview decision and hides actions after completion', async () => {
    const ondecide = vi.fn();
    const { container, rerender } = render(PreviewApprovalPanel, {
      props: {
        preview: { id: 'a1', previewId: 'pv1', status: 'pending' },
        ondecide,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Approve preview' }),
    );
    expect(ondecide).toHaveBeenCalledWith(true);
    await rerender({
      preview: { id: 'a1', previewId: 'pv1', status: 'approved' },
      ondecide,
    });
    expect(
      screen.queryByRole('button', { name: 'Approve preview' }),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
});
