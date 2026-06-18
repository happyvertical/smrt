/**
 * Golden test for LoadingOverlay (Sweep S11, #1416).
 *
 * LoadingOverlay renders a full-screen `role="dialog"` busy surface only while
 * `show` is true and not dismissed. It carries `aria-busy` (true unless an
 * error is present), an `aria-labelledby` title from `message`, optional
 * progress/items, an error message, and a dismiss button when `dismissible`.
 */
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y';
import LoadingOverlay from '../LoadingOverlay.svelte';

describe('LoadingOverlay', () => {
  it('renders nothing when not shown', () => {
    render(LoadingOverlay, { props: { show: false } });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders a busy dialog labelled by its message when shown', () => {
    render(LoadingOverlay, {
      props: { show: true, message: 'Importing data' },
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(dialog).toHaveAccessibleName('Importing data');
    expect(
      screen.getByRole('heading', { name: 'Importing data' }),
    ).toBeInTheDocument();
  });

  it('uses a default message when none is provided', () => {
    render(LoadingOverlay, { props: { show: true } });
    expect(
      screen.getByRole('heading', { name: 'Loading...' }),
    ).toBeInTheDocument();
  });

  it('shows a progress percentage when progress > 0', () => {
    render(LoadingOverlay, { props: { show: true, progress: 60 } });
    expect(screen.getByText('60%')).toBeInTheDocument();
  });

  it('omits the progress readout when progress is 0', () => {
    render(LoadingOverlay, { props: { show: true, progress: 0 } });
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('renders completed items', () => {
    render(LoadingOverlay, {
      props: { show: true, items: ['Profiles', 'Assets'] },
    });
    expect(screen.getByText('Profiles')).toBeInTheDocument();
    expect(screen.getByText('Assets')).toBeInTheDocument();
  });

  it('clears aria-busy and shows the error message in the error state', () => {
    render(LoadingOverlay, {
      props: { show: true, error: { message: 'Import failed' } },
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByText('Import failed')).toBeInTheDocument();
  });

  it('omits the dismiss button unless dismissible', () => {
    render(LoadingOverlay, { props: { show: true } });
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
  });

  it('fires ondismiss and hides the overlay when the dismiss button is clicked', async () => {
    const ondismiss = vi.fn();
    render(LoadingOverlay, {
      props: { show: true, dismissible: true, ondismiss },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(ondismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('dismisses via the Escape key when dismissible', async () => {
    const ondismiss = vi.fn();
    render(LoadingOverlay, {
      props: { show: true, dismissible: true, ondismiss },
    });
    await userEvent.keyboard('{Escape}');
    expect(ondismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores Escape when not dismissible', async () => {
    render(LoadingOverlay, { props: { show: true, dismissible: false } });
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('is axe-clean in the loading state', async () => {
    const { container } = render(LoadingOverlay, {
      props: { show: true, message: 'Loading your workspace', progress: 45 },
    });
    await expectNoA11yViolations(container);
  });

  it('is axe-clean with completed items and a dismiss action', async () => {
    const { container } = render(LoadingOverlay, {
      props: {
        show: true,
        message: 'Almost done',
        items: ['Step one'],
        dismissible: true,
      },
    });
    await expectNoA11yViolations(container);
  });
});
