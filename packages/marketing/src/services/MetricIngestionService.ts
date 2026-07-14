import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CampaignMetricSnapshotCollection } from '../collections/CampaignMetricSnapshotCollection.js';
import type { CampaignMetricSnapshot } from '../models/CampaignMetricSnapshot.js';
import type { CampaignMetricSnapshotOptions } from '../types.js';

/** Idempotent, validation-first ingestion for immutable metric evidence. */
export class MetricIngestionService {
  constructor(private readonly snapshots: CampaignMetricSnapshotCollection) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<MetricIngestionService> {
    return new MetricIngestionService(
      await CampaignMetricSnapshotCollection.create(classOptions),
    );
  }

  async ingest(
    options: CampaignMetricSnapshotOptions,
  ): Promise<{ snapshot: CampaignMetricSnapshot; created: boolean }> {
    if (!options.campaignId) {
      throw new Error('Metric ingestion requires campaignId.');
    }
    if (!options.source?.trim()) {
      throw new Error('Metric ingestion requires source.');
    }
    if (!options.dedupeKey?.trim()) {
      throw new Error('Metric ingestion requires dedupeKey.');
    }
    if (options.periodStart == null || options.periodEnd == null) {
      throw new Error('Metric ingestion requires periodStart and periodEnd.');
    }
    return await this.snapshots.getOrCreateByDedupeKey(options);
  }
}

export default MetricIngestionService;
