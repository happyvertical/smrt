/**
 * Unit tests for the pure view-model helpers of the svelte module: dashboard
 * math, board grouping, award validation, payout gating/timelines, and the
 * expense reconciliation totals.
 */

import { describe, expect, it } from 'vitest';
import type {
  AttributionCandidateView,
  CommissionExpenseRowView,
  OpportunityCardView,
  PipelineStageView,
} from '../types.js';
import {
  adjacentStageIds,
  buildShareUrl,
  canQualifyLead,
  equalSplitAwards,
  formatCommissionFormula,
  formatPlanRef,
  groupOpportunitiesByStage,
  isHttpUrl,
  isOverdue,
  openOpportunityCount,
  openPipelineTotals,
  payoutActionsFor,
  payoutStatusTimeline,
  pipelineValueByStage,
  sumExpenseRowsByCurrency,
  uniqueCandidateReferrerIds,
  validateAwards,
  winRate,
} from '../types.js';

const stages: PipelineStageView[] = [
  { id: 's1', name: 'New' },
  { id: 's2', name: 'Proposal' },
  { id: 's3', name: 'Closed Won', isWon: true },
];

function opportunity(
  overrides: Partial<OpportunityCardView> & { id: string },
): OpportunityCardView {
  return {
    name: `Opportunity ${overrides.id}`,
    stageId: 's1',
    expectedValueCents: 100_00,
    currency: 'USD',
    probability: 0.5,
    status: 'open',
    ...overrides,
  };
}

describe('dashboard math', () => {
  const opportunities = [
    opportunity({ id: 'o1', stageId: 's1', expectedValueCents: 10_000 }),
    opportunity({ id: 'o2', stageId: 's2', expectedValueCents: 25_000 }),
    opportunity({
      id: 'o3',
      stageId: 's2',
      expectedValueCents: 5_000,
      currency: 'EUR',
    }),
    opportunity({
      id: 'o4',
      stageId: 's3',
      status: 'won',
      expectedValueCents: 99_999,
    }),
    opportunity({ id: 'o5', stageId: 's1', status: 'lost' }),
  ];

  it('counts only open opportunities', () => {
    expect(openOpportunityCount(opportunities)).toBe(3);
  });

  it('totals open pipeline value per currency, never mixing currencies', () => {
    expect(openPipelineTotals(opportunities)).toEqual([
      { currency: 'EUR', amountCents: 5_000 },
      { currency: 'USD', amountCents: 35_000 },
    ]);
  });

  it('breaks open pipeline value down by stage in stage order', () => {
    const byStage = pipelineValueByStage(stages, opportunities);
    expect(byStage.map((s) => s.stageId)).toEqual(['s1', 's2', 's3']);
    expect(byStage[0]).toEqual({
      stageId: 's1',
      stageName: 'New',
      openCount: 1,
      totals: [{ currency: 'USD', amountCents: 10_000 }],
    });
    expect(byStage[1].openCount).toBe(2);
    expect(byStage[1].totals).toEqual([
      { currency: 'EUR', amountCents: 5_000 },
      { currency: 'USD', amountCents: 25_000 },
    ]);
    // Terminal stage: its opportunity is won, no longer open.
    expect(byStage[2].openCount).toBe(0);
    expect(byStage[2].totals).toEqual([]);
  });

  it('computes win rate over closed opportunities only', () => {
    expect(winRate(opportunities)).toBe(0.5);
  });

  it('returns null win rate when nothing has closed', () => {
    expect(winRate([opportunity({ id: 'o1' })])).toBeNull();
  });
});

describe('board helpers', () => {
  it('groups opportunities into the given stage order', () => {
    const columns = groupOpportunitiesByStage(stages, [
      opportunity({ id: 'o1', stageId: 's2' }),
      opportunity({ id: 'o2', stageId: 's1' }),
      opportunity({ id: 'o3', stageId: 'unknown-stage' }),
    ]);
    expect(columns.map((c) => c.stage.id)).toEqual(['s1', 's2', 's3']);
    expect(columns[0].opportunities.map((o) => o.id)).toEqual(['o2']);
    expect(columns[1].opportunities.map((o) => o.id)).toEqual(['o1']);
    expect(columns[2].opportunities).toEqual([]);
  });

  it('finds adjacent stages for next/prev movement', () => {
    expect(adjacentStageIds(stages, 's1')).toEqual({
      prevStageId: null,
      nextStageId: 's2',
    });
    expect(adjacentStageIds(stages, 's2')).toEqual({
      prevStageId: 's1',
      nextStageId: 's3',
    });
    expect(adjacentStageIds(stages, 's3')).toEqual({
      prevStageId: 's2',
      nextStageId: null,
    });
    expect(adjacentStageIds(stages, 'missing')).toEqual({
      prevStageId: null,
      nextStageId: null,
    });
  });
});

describe('lead helpers', () => {
  it('allows qualification from new and working only', () => {
    expect(canQualifyLead('new')).toBe(true);
    expect(canQualifyLead('working')).toBe(true);
    expect(canQualifyLead('qualified')).toBe(false);
    expect(canQualifyLead('disqualified')).toBe(false);
    expect(canQualifyLead('merged')).toBe(false);
  });

  it('detects overdue next actions relative to an explicit clock', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    expect(isOverdue(new Date(2026, 5, 14), now)).toBe(true);
    expect(isOverdue(new Date(2026, 5, 16), now)).toBe(false);
    expect(isOverdue(null, now)).toBe(false);
    expect(isOverdue(undefined, now)).toBe(false);
    expect(isOverdue('not-a-date', now)).toBe(false);
  });
});

describe('referral link helpers', () => {
  it('builds share URLs, normalising trailing slashes and encoding the code', () => {
    expect(buildShareUrl('https://example.com/r', 'AB12CD')).toBe(
      'https://example.com/r/AB12CD',
    );
    expect(buildShareUrl('https://example.com/r///', 'AB12CD')).toBe(
      'https://example.com/r/AB12CD',
    );
    expect(buildShareUrl('https://example.com/r', 'A B')).toBe(
      'https://example.com/r/A%20B',
    );
  });

  it('accepts only http(s) URLs for the create form', () => {
    expect(isHttpUrl('https://example.com/landing')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('  https://example.com  ')).toBe(true);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('award validation', () => {
  it('accepts a single full-credit award', () => {
    const result = validateAwards([{ referrerId: 'r1', creditFraction: 1 }]);
    expect(result.valid).toBe(true);
    expect(result.totalFraction).toBe(1);
  });

  it('accepts fractions summing to 1 within the service tolerance', () => {
    const result = validateAwards([
      { referrerId: 'r1', creditFraction: 0.3333 },
      { referrerId: 'r2', creditFraction: 0.3333 },
      { referrerId: 'r3', creditFraction: 0.3334 },
    ]);
    expect(result.valid).toBe(true);
  });

  it('rejects an empty award set', () => {
    const result = validateAwards([]);
    expect(result.valid).toBe(false);
    expect(result.message).toBeDefined();
  });

  it('rejects duplicate referrers', () => {
    const result = validateAwards([
      { referrerId: 'r1', creditFraction: 0.5 },
      { referrerId: 'r1', creditFraction: 0.5 },
    ]);
    expect(result.valid).toBe(false);
  });

  it('rejects out-of-range fractions', () => {
    expect(
      validateAwards([{ referrerId: 'r1', creditFraction: 0 }]).valid,
    ).toBe(false);
    expect(
      validateAwards([{ referrerId: 'r1', creditFraction: 1.2 }]).valid,
    ).toBe(false);
    expect(
      validateAwards([{ referrerId: 'r1', creditFraction: Number.NaN }]).valid,
    ).toBe(false);
  });

  it('rejects sums away from 1.0', () => {
    const result = validateAwards([
      { referrerId: 'r1', creditFraction: 0.5 },
      { referrerId: 'r2', creditFraction: 0.4 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.totalFraction).toBeCloseTo(0.9);
  });
});

describe('equal split seeding', () => {
  it('gives a single referrer full credit', () => {
    expect(equalSplitAwards(['r1'])).toEqual([
      { referrerId: 'r1', creditFraction: 1 },
    ]);
  });

  it('splits across three referrers with the last taking the remainder', () => {
    const awards = equalSplitAwards(['r1', 'r2', 'r3']);
    expect(awards.map((a) => a.creditFraction)).toEqual([
      0.3333, 0.3333, 0.3334,
    ]);
    expect(validateAwards(awards).valid).toBe(true);
  });

  it('returns an empty set for no referrers', () => {
    expect(equalSplitAwards([])).toEqual([]);
  });

  it('deduplicates candidate referrers in first-seen order', () => {
    const candidates: AttributionCandidateView[] = [
      {
        touchId: 't1',
        referrerId: 'r2',
        kind: 'click',
        occurredAt: '2026-01-01',
      },
      {
        touchId: 't2',
        referrerId: 'r1',
        kind: 'code_entry',
        occurredAt: '2026-01-02',
      },
      {
        touchId: 't3',
        referrerId: 'r2',
        kind: 'click',
        occurredAt: '2026-01-03',
      },
    ];
    expect(uniqueCandidateReferrerIds(candidates)).toEqual(['r2', 'r1']);
  });
});

describe('commission formula', () => {
  it('renders base × rate × share = amount for rate-based components', () => {
    expect(
      formatCommissionFormula(
        {
          basis: 'gross',
          baseAmountCents: 100_000,
          rate: 0.1,
          shareFraction: 0.5,
          amountCents: 5_000,
          currency: 'USD',
        },
        'en-US',
      ),
    ).toBe('$1,000.00 × 10% × 50% = $50.00');
  });

  it('renders fixed-basis components without the rate factor', () => {
    expect(
      formatCommissionFormula(
        {
          basis: 'fixed',
          baseAmountCents: 2_500,
          rate: 0,
          shareFraction: 1,
          amountCents: 2_500,
          currency: 'USD',
        },
        'en-US',
      ),
    ).toBe('$25.00 (fixed) × 100% = $25.00');
  });

  it('formats plan references as key@vN', () => {
    expect(formatPlanRef('partner-standard', 3)).toBe('partner-standard@v3');
  });
});

describe('payout timeline and gating', () => {
  it('marks the happy path steps done/current/upcoming', () => {
    expect(payoutStatusTimeline('processing')).toEqual([
      { status: 'pending', state: 'done' },
      { status: 'approved', state: 'done' },
      { status: 'processing', state: 'current' },
      { status: 'completed', state: 'upcoming' },
    ]);
  });

  it('starts at pending', () => {
    const steps = payoutStatusTimeline('pending');
    expect(steps[0]).toEqual({ status: 'pending', state: 'current' });
    expect(steps.at(-1)).toEqual({ status: 'completed', state: 'upcoming' });
  });

  it('replaces the terminal step with failed for failed batches', () => {
    const steps = payoutStatusTimeline('failed');
    expect(steps.map((s) => s.status)).toEqual([
      'pending',
      'approved',
      'processing',
      'failed',
    ]);
    expect(steps.at(-1)?.state).toBe('current');
  });

  it('gates operator actions by batch status', () => {
    expect(payoutActionsFor('pending')).toEqual({
      canApprove: true,
      canMarkProcessing: false,
      canComplete: false,
      canFail: false,
    });
    expect(payoutActionsFor('approved')).toEqual({
      canApprove: false,
      canMarkProcessing: true,
      canComplete: false,
      canFail: true,
    });
    expect(payoutActionsFor('processing')).toEqual({
      canApprove: false,
      canMarkProcessing: false,
      canComplete: true,
      canFail: true,
    });
    expect(payoutActionsFor('completed')).toEqual({
      canApprove: false,
      canMarkProcessing: false,
      canComplete: false,
      canFail: false,
    });
    expect(payoutActionsFor('failed')).toEqual({
      canApprove: false,
      canMarkProcessing: false,
      canComplete: false,
      canFail: false,
    });
  });
});

describe('expense reconciliation totals', () => {
  const rows: CommissionExpenseRowView[] = [
    {
      id: '2026-06:USD:a',
      label: 'Program A',
      currency: 'USD',
      commissionExpenseCents: 100_000,
      adjustmentCents: -5_000,
      payoutCents: 60_000,
    },
    {
      id: '2026-06:USD:b',
      label: 'Program B',
      currency: 'USD',
      commissionExpenseCents: 50_000,
      adjustmentCents: 0,
      payoutCents: 50_000,
    },
    {
      id: '2026-06:EUR',
      label: 'Program C',
      currency: 'EUR',
      commissionExpenseCents: 20_000,
      adjustmentCents: 1_000,
      payoutCents: 0,
    },
  ];

  it('sums per currency and derives the net accrual', () => {
    expect(sumExpenseRowsByCurrency(rows)).toEqual([
      {
        currency: 'EUR',
        commissionExpenseCents: 20_000,
        adjustmentCents: 1_000,
        payoutCents: 0,
        netAccruedCents: 21_000,
      },
      {
        currency: 'USD',
        commissionExpenseCents: 150_000,
        adjustmentCents: -5_000,
        payoutCents: 110_000,
        netAccruedCents: 35_000,
      },
    ]);
  });

  it('handles an empty row set', () => {
    expect(sumExpenseRowsByCurrency([])).toEqual([]);
  });
});
