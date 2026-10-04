/** Native confirmation rendering, actions, focus and instance identity. */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import ConfirmDialog from '../ConfirmDialog.svelte';
import RichMessage from './confirm-message.fixture.svelte';

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

  it('uses native dialog and unique instance description ids', () => {
    render(ConfirmDialog, { props: baseProps });
    render(ConfirmDialog, {
      props: { ...baseProps, title: 'Second', message: 'Other' },
    });
    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs.every((dialog) => dialog instanceof HTMLDialogElement)).toBe(
      true,
    );
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const ids = dialogs.map((dialog) => dialog.getAttribute(attribute));
      expect(new Set(ids).size).toBe(2);
      for (let index = 0; index < dialogs.length; index++) {
        expect(
          dialogs[index].contains(document.getElementById(ids[index]!)),
        ).toBe(true);
      }
    }
  });

  it('handles native cancel without closing outside controlled state', async () => {
    const oncancel = vi.fn();
    render(ConfirmDialog, { props: { ...baseProps, oncancel } });
    const dialog = screen.getByRole('dialog');
    const event = new Event('cancel', { cancelable: true });
    await fireEvent(dialog, event);
    expect(event.defaultPrevented).toBe(true);
    expect(oncancel).toHaveBeenCalledTimes(1);
    expect(dialog).toHaveAttribute('open');
  });

  it('renders a snippet message as accessible rich content', () => {
    render(RichMessage);
    const dialog = screen.getByRole('dialog', { name: 'Rich confirmation' });
    expect(dialog.querySelector('strong')).toHaveTextContent('Record name');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(dialog).toHaveAccessibleDescription(
      'Remove Record name? Notes Attachments',
    );
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

  describe('focus management (#1586)', () => {
    it('moves focus to the confirm button when opened', async () => {
      render(ConfirmDialog, { props: baseProps });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus(),
      );
    });

    it('traps Tab focus within the dialog', async () => {
      render(ConfirmDialog, { props: baseProps });
      const confirm = screen.getByRole('button', { name: 'Confirm' });
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      await waitFor(() => expect(confirm).toHaveFocus());

      // Tab from the last focusable (confirm) wraps to the first (cancel).
      await userEvent.tab();
      expect(cancel).toHaveFocus();

      // Shift+Tab from the first focusable (cancel) wraps back to confirm.
      await userEvent.tab({ shift: true });
      expect(confirm).toHaveFocus();
    });

    it('restores focus to the opener when closed', async () => {
      // An external trigger holds focus before the dialog opens.
      const opener = document.createElement('button');
      opener.textContent = 'Open';
      document.body.appendChild(opener);
      opener.focus();
      expect(opener).toHaveFocus();

      const { rerender } = render(ConfirmDialog, { props: baseProps });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Confirm' })).toHaveFocus(),
      );

      await rerender({ ...baseProps, open: false });
      expect(opener).toHaveFocus();

      opener.remove();
    });

    it('does not consume Escape from outside its dialog', async () => {
      const oncancel = vi.fn();
      render(ConfirmDialog, { props: { ...baseProps, oncancel } });
      await fireEvent.keyDown(window, { key: 'Escape' });
      expect(oncancel).not.toHaveBeenCalled();
    });

    it('focuses the dialog container when all controls are disabled (loading)', async () => {
      // Both buttons are disabled while loading, so there is no focusable
      // control; focus falls back to the dialog container (tabindex=-1) to stay
      // contained and keep Escape reachable.
      render(ConfirmDialog, { props: { ...baseProps, loading: true } });
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    });
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
