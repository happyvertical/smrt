import type { Campaign } from '../models/Campaign.js';
import type { BudgetPacingResult, BudgetPacingStatus } from '../types.js';

export interface BudgetPacingEvidence {
  spendCents: number;
  snapshotCount: number;
  usedCampaignRollups: boolean;
}

/** Canonical campaign pacing calculation for grouped and row-level evidence. */
export function calculateCampaignPacing(
  campaign: Campaign,
  evidence: BudgetPacingEvidence,
  at = new Date(),
): BudgetPacingResult {
  return calculatePacing({
    campaign,
    evidence,
    budgetCents: campaign.budgetCents,
    startAt: campaign.startAt,
    endAt: campaign.endAt,
    at,
  });
}

export function calculatePacing({
  campaign,
  evidence,
  budgetCents,
  startAt,
  endAt,
  at,
}: {
  campaign: Campaign;
  evidence: BudgetPacingEvidence;
  budgetCents: number;
  startAt: Date | null;
  endAt: Date | null;
  at: Date;
}): BudgetPacingResult {
  const elapsed = elapsedFraction(startAt, endAt, at);
  const expectedSpendCents =
    elapsed === null ? null : Math.round(budgetCents * elapsed);
  const varianceCents =
    expectedSpendCents === null
      ? null
      : evidence.spendCents - expectedSpendCents;
  return {
    campaignId: campaign.id ?? '',
    currency: campaign.currency,
    budgetCents,
    spendCents: evidence.spendCents,
    remainingCents: budgetCents - evidence.spendCents,
    expectedSpendCents,
    varianceCents,
    budgetFraction: budgetCents > 0 ? evidence.spendCents / budgetCents : null,
    elapsedFraction: elapsed,
    status: pacingStatus({
      campaign,
      budgetCents,
      spendCents: evidence.spendCents,
      elapsedFraction: elapsed,
      varianceCents,
      startAt,
      at,
    }),
    snapshotCount: evidence.snapshotCount,
    usedCampaignRollups: evidence.usedCampaignRollups,
  };
}

function pacingStatus({
  campaign,
  budgetCents,
  spendCents,
  elapsedFraction,
  varianceCents,
  startAt,
  at,
}: {
  campaign: Campaign;
  budgetCents: number;
  spendCents: number;
  elapsedFraction: number | null;
  varianceCents: number | null;
  startAt: Date | null;
  at: Date;
}): BudgetPacingStatus {
  if (budgetCents <= 0) return 'unbudgeted';
  if (spendCents > budgetCents) return 'over_budget';
  if (startAt && at.getTime() < startAt.getTime()) return 'not_started';
  if (
    campaign.status === 'completed' ||
    campaign.status === 'archived' ||
    elapsedFraction === 1
  ) {
    return 'complete';
  }
  if (varianceCents === null) return 'on_track';

  // A five-percent budget band avoids noisy status flips from minor timing
  // differences between spend collection and scheduled pacing.
  const toleranceCents = Math.max(1, Math.round(budgetCents * 0.05));
  if (varianceCents > toleranceCents) return 'ahead';
  if (varianceCents < -toleranceCents) return 'behind';
  return 'on_track';
}

function elapsedFraction(
  startAt: Date | null,
  endAt: Date | null,
  at: Date,
): number | null {
  if (!startAt || !endAt) return null;
  const start = startAt.getTime();
  const end = endAt.getTime();
  if (end <= start) return at.getTime() < start ? 0 : 1;
  return Math.min(1, Math.max(0, (at.getTime() - start) / (end - start)));
}
