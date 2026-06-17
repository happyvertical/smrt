// @vitest-environment jsdom
/**
 * Component coverage for RejectDialog via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import RejectDialog from '../RejectDialog.svelte';

const baseProps = (over = {}) => ({
  open: true,
  onconfirm: vi.fn(),
  oncancel: vi.fn(),
  ...over,
});

describe('RejectDialog', () => {
  it('renders the dialog with a reason field when open', () => {
    render(RejectDialog, { props: baseProps() });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    render(RejectDialog, { props: baseProps({ open: false }) });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires a reason before the confirm button is enabled', async () => {
    const onconfirm = vi.fn();
    render(RejectDialog, { props: baseProps({ onconfirm }) });
    const confirm = screen.getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox'), 'Insufficient detail');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(onconfirm).toHaveBeenCalledWith('Insufficient detail');
  });

  it('cancels via the cancel button', async () => {
    const oncancel = vi.fn();
    render(RejectDialog, { props: baseProps({ oncancel }) });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(oncancel).toHaveBeenCalledTimes(1);
  });

  it('is axe-clean', async () => {
    const { container } = render(RejectDialog, { props: baseProps() });
    await expectNoA11yViolations(container);
  });
});
