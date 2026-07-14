import { SmrtCollection } from '@happyvertical/smrt-core';
import { CampaignMetricSnapshot } from '../models/CampaignMetricSnapshot.js';
import type { CampaignMetricSnapshotOptions } from '../types.js';

export class CampaignMetricSnapshotCollection extends SmrtCollection<CampaignMetricSnapshot> {
  static readonly _itemClass = CampaignMetricSnapshot;

  async findByDedupeKey(
    dedupeKey: string,
  ): Promise<CampaignMetricSnapshot | null> {
    if (!dedupeKey) return null;
    const rows = await this.list({ where: { dedupeKey }, limit: 1 });
    return rows[0] ?? null;
  }

  async getOrCreateByDedupeKey(
    options: CampaignMetricSnapshotOptions,
  ): Promise<{ snapshot: CampaignMetricSnapshot; created: boolean }> {
    const dedupeKey = options.dedupeKey ?? '';
    if (!dedupeKey) {
      throw new Error(
        'CampaignMetricSnapshotCollection.getOrCreateByDedupeKey requires a dedupeKey.',
      );
    }
    const existing = await this.findByDedupeKey(dedupeKey);
    if (existing) return { snapshot: existing, created: false };

    try {
      const snapshot = await this.create({
        ...options,
        // Keep runtime values uncoerced so the model rejects null/invalid
        // periods instead of allowing Date(null) to become the Unix epoch.
        periodStart: options.periodStart as Date | undefined,
        periodEnd: options.periodEnd as Date | undefined,
        _insertOnly: true,
      });
      return { snapshot, created: true };
    } catch (error) {
      // A concurrent ingest may have won the unique dedupe-key insert after
      // our initial read. Re-read the immutable winner instead of allowing a
      // natural-key upsert to replace its evidence in place.
      const concurrent = await this.findByDedupeKey(dedupeKey);
      if (concurrent) return { snapshot: concurrent, created: false };
      throw error;
    }
  }

  async findByCampaign(campaignId: string): Promise<CampaignMetricSnapshot[]> {
    return await this.list({
      where: { campaignId },
      orderBy: 'period_start ASC',
    });
  }

  async findByChannel(
    campaignChannelId: string,
  ): Promise<CampaignMetricSnapshot[]> {
    return await this.list({
      where: { campaignChannelId },
      orderBy: 'period_start ASC',
    });
  }
}

export default CampaignMetricSnapshotCollection;
