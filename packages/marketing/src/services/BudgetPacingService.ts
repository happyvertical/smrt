import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  CampaignChannelCollection,
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import type { Campaign } from '../models/Campaign.js';
import type { CampaignMetricSnapshot } from '../models/CampaignMetricSnapshot.js';
import type { BudgetPacingResult, BudgetPacingStatus } from '../types.js';

/** Computes spend-to-budget pacing from immutable snapshots; stores nothing. */
export class BudgetPacingService {
  constructor(
    private readonly campaigns: CampaignCollection,
    private readonly channels: CampaignChannelCollection,
    private readonly snapshots: CampaignMetricSnapshotCollection,
  ) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<BudgetPacingService> {
    return new BudgetPacingService(
      await CampaignCollection.create(classOptions),
      await CampaignChannelCollection.create(classOptions),
      await CampaignMetricSnapshotCollection.create(classOptions),
    );
  }

  async getCampaignPacing(
    campaignId: string,
    at = new Date(),
  ): Promise<BudgetPacingResult> {
    const campaign = await this.campaigns.get({ id: campaignId });
    if (!campaign) throw new Error(`Campaign '${campaignId}' was not found.`);

    const all = await this.snapshots.findByCampaign(campaignId);
    const rollups = all.filter((snapshot) => !snapshot.campaignChannelId);
    const used = this.selectCampaignEvidence(all);
    return this.calculate({
      campaign,
      snapshots: used,
      budgetCents: campaign.budgetCents,
      startAt: campaign.startAt,
      endAt: campaign.endAt,
      at,
      usedCampaignRollups: rollups.length > 0,
    });
  }

  async getChannelPacing(
    campaignChannelId: string,
    at = new Date(),
  ): Promise<BudgetPacingResult> {
    const channel = await this.channels.get({ id: campaignChannelId });
    if (!channel) {
      throw new Error(`CampaignChannel '${campaignChannelId}' was not found.`);
    }
    const campaign = await this.campaigns.get({ id: channel.campaignId });
    if (!campaign) {
      throw new Error(`Campaign '${channel.campaignId}' was not found.`);
    }
    const snapshots = await this.snapshots.findByChannel(campaignChannelId);
    return {
      ...this.calculate({
        campaign,
        snapshots,
        budgetCents: channel.allocatedBudgetCents,
        startAt: channel.startAt ?? campaign.startAt,
        endAt: channel.endAt ?? campaign.endAt,
        at,
        usedCampaignRollups: false,
      }),
      campaignChannelId,
    };
  }

  private calculate({
    campaign,
    snapshots,
    budgetCents,
    startAt,
    endAt,
    at,
    usedCampaignRollups,
  }: {
    campaign: Campaign;
    snapshots: CampaignMetricSnapshot[];
    budgetCents: number;
    startAt: Date | null;
    endAt: Date | null;
    at: Date;
    usedCampaignRollups: boolean;
  }): BudgetPacingResult {
    const spendCents = snapshots.reduce(
      (sum, snapshot) => sum + snapshot.spendCents,
      0,
    );
    const elapsedFraction = this.elapsedFraction(startAt, endAt, at);
    const expectedSpendCents =
      elapsedFraction === null
        ? null
        : Math.round(budgetCents * elapsedFraction);
    const varianceCents =
      expectedSpendCents === null ? null : spendCents - expectedSpendCents;
    const budgetFraction = budgetCents > 0 ? spendCents / budgetCents : null;

    return {
      campaignId: campaign.id ?? '',
      currency: campaign.currency,
      budgetCents,
      spendCents,
      remainingCents: budgetCents - spendCents,
      expectedSpendCents,
      varianceCents,
      budgetFraction,
      elapsedFraction,
      status: this.pacingStatus({
        campaign,
        budgetCents,
        spendCents,
        elapsedFraction,
        varianceCents,
        startAt,
        at,
      }),
      snapshotCount: snapshots.length,
      usedCampaignRollups,
    };
  }

  private pacingStatus({
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
    if (startAt && at.getTime() < startAt.getTime()) {
      return 'not_started';
    }
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

  /**
   * Prefer a campaign rollup for each exact reporting period, while retaining
   * channel evidence for periods that do not yet have a rollup. This prevents
   * double counting without dropping earlier/later channel-only periods.
   */
  private selectCampaignEvidence(
    snapshots: CampaignMetricSnapshot[],
  ): CampaignMetricSnapshot[] {
    const rollupPeriods = new Set(
      snapshots
        .filter((snapshot) => !snapshot.campaignChannelId)
        .map((snapshot) => this.periodKey(snapshot)),
    );
    return snapshots.filter(
      (snapshot) =>
        !snapshot.campaignChannelId ||
        !rollupPeriods.has(this.periodKey(snapshot)),
    );
  }

  private periodKey(snapshot: CampaignMetricSnapshot): string {
    return `${snapshot.periodStart.toISOString()}:${snapshot.periodEnd.toISOString()}`;
  }

  private elapsedFraction(
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
}

export default BudgetPacingService;
