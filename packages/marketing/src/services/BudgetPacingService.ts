import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  CampaignChannelCollection,
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import type { CampaignMetricSnapshot } from '../models/CampaignMetricSnapshot.js';
import type { BudgetPacingResult } from '../types.js';
import {
  calculateCampaignPacing,
  calculatePacing,
} from './pacing-calculation.js';

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
    return calculateCampaignPacing(
      campaign,
      {
        spendCents: used.reduce(
          (sum, snapshot) => sum + snapshot.spendCents,
          0,
        ),
        snapshotCount: used.length,
        usedCampaignRollups: rollups.length > 0,
      },
      at,
    );
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
      ...calculatePacing({
        campaign,
        evidence: {
          spendCents: snapshots.reduce(
            (sum, snapshot) => sum + snapshot.spendCents,
            0,
          ),
          snapshotCount: snapshots.length,
          usedCampaignRollups: false,
        },
        budgetCents: channel.allocatedBudgetCents,
        startAt: channel.startAt ?? campaign.startAt,
        endAt: channel.endAt ?? campaign.endAt,
        at,
      }),
      campaignChannelId,
    };
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
}

export default BudgetPacingService;
