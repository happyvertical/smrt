// @vitest-environment jsdom
/**
 * Component coverage for BulkActions via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import BulkActions from '../BulkActions.svelte';

const baseProps = (over = {}) => ({
  selectedCount: 3,
  onapprove: vi.fn(),
  onreject: vi.fn(),
  ondelete: vi.fn(),
  onexport: vi.fn(),
  onclear: vi.fn(),
  ...over,
});

describe('BulkActions', () => {
  it('shows the selection count and bulk action buttons', () => {
    render(BulkActions, { props: baseProps() });
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('items selected')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Approve All' }),
    ).toBeInTheDocument();
  });

  it('invokes onapprove when Approve All is clicked', async () => {
    const onapprove = vi.fn();
    render(BulkActions, { props: baseProps({ onapprove }) });
    await userEvent.click(screen.getByRole('button', { name: 'Approve All' }));
    expect(onapprove).toHaveBeenCalledTimes(1);
  });

  it('clears the selection', async () => {
    const onclear = vi.fn();
    render(BulkActions, { props: baseProps({ onclear }) });
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onclear).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when no items are selected', () => {
    const { container } = render(BulkActions, {
      props: baseProps({ selectedCount: 0 }),
    });
    expect(container.querySelector('.bulk-actions')).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(BulkActions, { props: baseProps() });
    await expectNoA11yViolations(container);
  });
});
