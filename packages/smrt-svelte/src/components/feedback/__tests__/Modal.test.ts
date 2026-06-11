/**
 * Golden test for Modal (Sweep L4, #1423).
 *
 * Modal wraps a native <dialog>; jsdom implements showModal()/close(), so the
 * open/close effect runs. Content is always in the DOM — visibility is driven
 * by the dialog's modal state.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import Modal from '../Modal.svelte';

function bodySnippet(text: string) {
  return createRawSnippet(() => ({ render: () => `<p>${text}</p>` }));
}

describe('Modal', () => {
  it('exposes a dialog labelled by its title, with content', () => {
    render(Modal, {
      props: {
        open: true,
        title: 'Settings',
        children: bodySnippet('Body copy'),
      },
    });
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveAttribute('aria-label', 'Settings');
    expect(
      screen.getByRole('heading', { name: 'Settings', hidden: true }),
    ).toBeInTheDocument();
    expect(screen.getByText('Body copy')).toBeInTheDocument();
  });

  it('invokes onClose from the close button', async () => {
    const onClose = vi.fn();
    render(Modal, { props: { open: true, title: 'X', onClose } });
    await userEvent.click(
      screen.getByRole('button', { name: 'Close modal', hidden: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omits the close button when showClose is false', () => {
    render(Modal, { props: { open: true, title: 'X', showClose: false } });
    expect(
      screen.queryByRole('button', { name: 'Close modal', hidden: true }),
    ).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(Modal, {
      props: {
        open: true,
        title: 'Accessible dialog',
        children: bodySnippet('content'),
      },
    });
    await expectNoA11yViolations(container);
  });
});
