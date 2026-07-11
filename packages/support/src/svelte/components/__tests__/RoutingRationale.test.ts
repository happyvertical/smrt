// @vitest-environment jsdom
/**
 * Component coverage for RoutingRationale via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { RankedSpecialistView } from '../../types.js';
import RoutingRationale from '../RoutingRationale.svelte';

function rankedView(
  overrides: Partial<RankedSpecialistView> = {},
): RankedSpecialistView {
  return {
    specialistId: 'spec-1',
    displayName: 'Ada Lovelace',
    score: 45,
    eligible: true,
    factors: {
      status: 'active',
      projectQualification: 'expert',
      weeklyAvailable: true,
      openCases: 2,
    },
    ...overrides,
  };
}

describe('RoutingRationale', () => {
  it('renders name, score, eligibility, and factor chips', async () => {
    const { container } = render(RoutingRationale, {
      props: {
        ranking: [
          rankedView(),
          rankedView({
            specialistId: 'spec-2',
            displayName: 'Grace Hopper',
            score: 0,
            eligible: false,
            factors: { status: 'active', projectQualification: 'none' },
          }),
        ],
      },
    });
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('score 45')).toBeInTheDocument();
    expect(screen.getByText('eligible')).toBeInTheDocument();
    expect(screen.getByText('ineligible')).toBeInTheDocument();
    // Boolean-true factors render as bare chips; others as key: value.
    expect(screen.getByText('weeklyAvailable')).toBeInTheDocument();
    expect(
      screen.getByText('projectQualification: expert'),
    ).toBeInTheDocument();
    expect(screen.getByText('projectQualification: none')).toBeInTheDocument();
    expect(screen.getByText('openCases: 2')).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('fires onreassign with the specialist id', async () => {
    const onreassign = vi.fn();
    const { container } = render(RoutingRationale, {
      props: { ranking: [rankedView()], onreassign },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Reassign to Ada Lovelace' }),
    );
    expect(onreassign).toHaveBeenCalledWith('spec-1');
    await expectNoA11yViolations(container);
  });

  it('renders no reassign action without an onreassign handler', () => {
    render(RoutingRationale, { props: { ranking: [rankedView()] } });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the empty message for an empty ranking', () => {
    render(RoutingRationale, {
      props: { ranking: [], emptyMessage: 'Nobody to rank' },
    });
    expect(screen.getByText('Nobody to rank')).toBeInTheDocument();
  });
});
