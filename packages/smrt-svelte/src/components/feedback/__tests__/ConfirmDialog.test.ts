/**
 * Golden test for ConfirmDialog (Sweep S11, #1416).
 *
 * ConfirmDialog renders a backdrop `<div role="dialog" aria-modal="true">` only
 * while `open` is true, with a title, message, and cancel/confirm buttons. It
 * exposes `onconfirm`/`oncancel` callbacks; Escape and backdrop clicks both
 * route to `oncancel`.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import ConfirmDialog from '../ConfirmDialog.svelte';

const baseProps = {
  open: true,
  title: 'Delete item',
  message: 'This action cannot be undone.',
};

describe('ConfirmDialog', () => {
  it('renders a labelled dialog with title and message when open', () => {
    render(ConfirmDialog, { props: baseProps });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(
      screen.getByRole('heading', { name: 'Delete item' }),
    ).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('Delete item');
    expect(
      screen.getByText('This action cannot be undone.'),
    ).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(ConfirmDialog, { props: { ...baseProps, open: false } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses default Confirm / Cancel button labels', () => {
    render(ConfirmDialog, { props: baseProps });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('honors custom confirm/cancel labels', () => {
    render(ConfirmDialog, {
      props: { ...baseProps, confirmLabel: 'Delete', cancelLabel: 'Keep' },
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep' })).toBeInTheDocument();
  });

  it('fires onconfirm when the confirm button is clicked', async () => {
    const onconfirm = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, onconfirm } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onconfirm).toHaveBeenCalledTimes(1);
  });

  it('fires oncancel when the cancel button is clicked', async () => {
    const oncancel = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, oncancel } });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('fires oncancel when Escape is pressed', async () => {
    const oncancel = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, oncancel } });
    screen.getByRole('dialog').focus();
    await userEvent.keyboard('{Escape}');
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('fires oncancel when the backdrop is clicked', async () => {
    const oncancel = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, oncancel } });
    await userEvent.click(screen.getByRole('dialog'));
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('does not fire oncancel when clicking inside the dialog content', async () => {
    const oncancel = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, oncancel } });
    await userEvent.click(screen.getByRole('heading', { name: 'Delete item' }));
    expect(oncancel).not.toHaveBeenCalled();
  });

  it('disables both buttons while loading', () => {
    render(ConfirmDialog, { props: { ...baseProps, loading: true } });
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('does not fire callbacks from disabled buttons while loading', async () => {
    const onconfirm = vi.fn();
    const oncancel = vi.fn();
    render(ConfirmDialog, {
      props: { ...baseProps, loading: true, onconfirm, oncancel },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onconfirm).not.toHaveBeenCalled();
    expect(oncancel).not.toHaveBeenCalled();
  });

  it('applies destructive styling to the confirm button', () => {
    render(ConfirmDialog, {
      props: { ...baseProps, destructive: true, confirmLabel: 'Delete' },
    });
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass(
      'destructive',
    );
  });

  it('omits destructive styling by default', () => {
    render(ConfirmDialog, { props: baseProps });
    expect(screen.getByRole('button', { name: 'Confirm' })).not.toHaveClass(
      'destructive',
    );
  });

  it('is axe-clean while open', async () => {
    const { container } = render(ConfirmDialog, { props: baseProps });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean in the destructive loading state', async () => {
    const { container } = render(ConfirmDialog, {
      props: { ...baseProps, destructive: true, loading: true },
    });
    await expectNoA11yViolations(container);
  });
});
