// @vitest-environment jsdom
/**
 * Component coverage for InviteUserModal via the shared S11 harness (#1416).
 */
import {
  fireEvent,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import InviteUserModal from '../InviteUserModal.svelte';

const baseProps = (over = {}) => ({
  open: true,
  tenant: { name: 'Acme' } as any,
  roles: [{ id: 'r1', slug: 'member', name: 'Member' }] as any,
  onsubmit: vi.fn(),
  onclose: vi.fn(),
  ...over,
});

describe('InviteUserModal', () => {
  it('renders the invite dialog scoped to the tenant when open', () => {
    render(InviteUserModal, { props: baseProps() });
    expect(
      screen.getByRole('heading', { name: 'Invite User to Acme' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Send Invite' }),
    ).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(InviteUserModal, { props: baseProps({ open: false }) });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the JS validation error when submitted with no email', async () => {
    const onsubmit = vi.fn();
    const { container } = render(InviteUserModal, {
      props: baseProps({ onsubmit }),
    });
    // Submit the form directly to exercise the component's own guard — a button
    // click would be pre-empted by the input's native `required` constraint.
    const form = container.querySelector('form');
    if (!form) throw new Error('form not found');
    await fireEvent.submit(form);
    expect(screen.getByText('Email is required')).toBeInTheDocument();
    expect(onsubmit).not.toHaveBeenCalled();
  });

  it('submits the email and default role', async () => {
    const onsubmit = vi.fn();
    render(InviteUserModal, { props: baseProps({ onsubmit }) });
    await userEvent.type(
      screen.getByLabelText('Email address'),
      'ada@example.com',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send Invite' }));
    expect(onsubmit).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', roleId: 'r1' }),
    );
  });

  it('closes via the Cancel button', async () => {
    const onclose = vi.fn();
    render(InviteUserModal, { props: baseProps({ onclose }) });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  // Regression for #1399 blocker #2: the hand-rolled dialog had no focus
  // trap/restore. Adopting the smrt-ui Modal renders a native <dialog> (top
  // layer + trap + inert), which supplies the trap and Escape handling the
  // previous markup lacked.
  it('renders inside a native <dialog> for the focus trap', () => {
    const { container } = render(InviteUserModal, { props: baseProps() });
    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    // The form lives inside the dialog, so focus is trapped within it.
    expect(dialog?.querySelector('form')).not.toBeNull();
  });
});
