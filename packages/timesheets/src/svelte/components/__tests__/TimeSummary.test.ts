// @vitest-environment jsdom
/**
 * Component coverage for TimeSummary via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import TimeSummary from '../TimeSummary.svelte';

describe('TimeSummary', () => {
  it('renders the total hours and value cards', () => {
    render(TimeSummary, {
      props: { totalHours: 12, totalAmount: 600, entryCount: 3 },
    });
    expect(screen.getByText('Total Hours')).toBeInTheDocument();
    expect(screen.getByText('Total Value')).toBeInTheDocument();
    expect(screen.getByText('3 entries')).toBeInTheDocument();
  });

  it('shows pending and approved cards when enabled and non-zero', () => {
    render(TimeSummary, {
      props: {
        totalHours: 12,
        totalAmount: 600,
        pendingHours: 4,
        pendingAmount: 200,
        approvedHours: 8,
        approvedAmount: 400,
        showPending: true,
        showApproved: true,
      },
    });
    expect(screen.getByText('Pending Approval')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });

  it('is axe-clean', async () => {
    const { container } = render(TimeSummary, {
      props: { totalHours: 12, totalAmount: 600 },
    });
    await expectNoA11yViolations(container);
  });
});
