// @vitest-environment jsdom
/**
 * Component coverage for TargetList via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type { ServiceTargetView } from '../../types.js';
import TargetList from '../TargetList.svelte';

function targetView(
  overrides: Partial<ServiceTargetView> = {},
): ServiceTargetView {
  return {
    id: 'target-1',
    targetType: 'acknowledgement',
    cycle: 0,
    status: 'pending',
    severity: 'sev2',
    baseMinutes: 30,
    startedAt: '2026-01-05T10:00:00.000Z',
    dueAt: '2026-01-05T10:30:00.000Z',
    satisfiedAt: null,
    breachedAt: null,
    paused: false,
    ...overrides,
  };
}

describe('TargetList', () => {
  it('renders target type, due time, and status badge', async () => {
    const { container } = render(TargetList, {
      props: {
        targets: [
          targetView(),
          targetView({
            id: 'target-2',
            targetType: 'resolution',
            status: 'satisfied',
            satisfiedAt: '2026-01-05T11:00:00.000Z',
          }),
        ],
      },
    });
    expect(screen.getByText('acknowledgement')).toBeInTheDocument();
    expect(screen.getByText('resolution')).toBeInTheDocument();
    expect(screen.getAllByText(/due /)).toHaveLength(2);
    expect(screen.getByText('pending')).toBeInTheDocument();
    expect(screen.getByText('satisfied')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('shows the paused indicator and the recurrence cycle', async () => {
    const { container } = render(TargetList, {
      props: {
        targets: [
          targetView({
            id: 'target-3',
            targetType: 'update',
            status: 'paused',
            paused: true,
            cycle: 2,
          }),
        ],
      },
    });
    expect(
      screen.getByText('paused', { selector: '.target-list-paused' }),
    ).toBeInTheDocument();
    expect(screen.getByText('cycle 2')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('renders a breached clock with the error badge label', () => {
    render(TargetList, {
      props: {
        targets: [
          targetView({
            id: 'target-4',
            status: 'breached',
            breachedAt: '2026-01-05T11:00:00.000Z',
          }),
        ],
      },
    });
    expect(screen.getByText('breached')).toBeInTheDocument();
  });

  it('shows the empty message when there are no targets', () => {
    render(TargetList, {
      props: { targets: [], emptyMessage: 'No clocks running' },
    });
    expect(screen.getByText('No clocks running')).toBeInTheDocument();
  });
});
