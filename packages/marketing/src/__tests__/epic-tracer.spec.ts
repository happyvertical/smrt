import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeadCollection } from '../../../sales/src/crm/collections/LeadCollection.js';
import {
  CampaignChannelCollection,
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import {
  BudgetPacingService,
  MetricIngestionService,
} from '../services/index.js';

describe('smrt-marketing epic tracer (#1988)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('coordinates two channels, idempotent evidence, pacing, and Lead provenance', async () => {
    const campaigns = await CampaignCollection.create({ db });
    const channels = await CampaignChannelCollection.create({ db });
    const snapshots = await CampaignMetricSnapshotCollection.create({ db });
    const leads = await LeadCollection.create({ db });

    const campaign = await campaigns.create({
      campaignKey: 'summer-demand-2026',
      name: 'Summer demand 2026',
      objective: 'demand_generation',
      status: 'active',
      startAt: new Date('2026-07-01T00:00:00Z'),
      endAt: new Date('2026-07-31T00:00:00Z'),
      budgetCents: 200_000,
      currency: 'CAD',
    });
    const adGroup = await channels.create({
      campaignId: campaign.id ?? '',
      channelKind: 'ad_group',
      channelRef: 'ad-group-42',
      allocatedBudgetCents: 150_000,
      status: 'active',
    });
    const socialPost = await channels.create({
      campaignId: campaign.id ?? '',
      channelKind: 'social_post',
      channelRef: 'social-post-84',
      allocatedBudgetCents: 50_000,
      status: 'active',
    });
    expect(
      (await channels.findByCampaign(campaign.id ?? '')).map(
        (row) => row.channelKind,
      ),
    ).toEqual(['ad_group', 'social_post']);

    const ingestion = new MetricIngestionService(snapshots);
    const adMetric = await ingestion.ingest({
      campaignId: campaign.id ?? '',
      campaignChannelId: adGroup.id ?? '',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-15T23:59:59Z'),
      spendCents: 70_000,
      impressions: 100_000,
      clicks: 3_000,
      conversions: 140,
      leads: 90,
      source: 'ad-platform',
      dedupeKey: 'summer-demand-2026:ads:2026-07-15',
    });
    await ingestion.ingest({
      campaignId: campaign.id ?? '',
      campaignChannelId: socialPost.id ?? '',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-15T23:59:59Z'),
      spendCents: 20_000,
      impressions: 40_000,
      clicks: 1_200,
      conversions: 40,
      leads: 25,
      source: 'social-platform',
      dedupeKey: 'summer-demand-2026:social:2026-07-15',
    });
    const replay = await ingestion.ingest({
      campaignId: campaign.id ?? '',
      campaignChannelId: adGroup.id ?? '',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-15T23:59:59Z'),
      spendCents: 999_999,
      source: 'ad-platform',
      dedupeKey: 'summer-demand-2026:ads:2026-07-15',
    });
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(adMetric.snapshot.id);

    const pacing = new BudgetPacingService(campaigns, channels, snapshots);
    const result = await pacing.getCampaignPacing(
      campaign.id ?? '',
      new Date('2026-07-16T00:00:00Z'),
    );
    expect(result.spendCents).toBe(90_000);
    expect(result.budgetCents).toBe(200_000);

    const lead = await leads.create({
      name: 'Campaign-sourced prospect',
      sourceKind: 'campaign',
      sourceId: campaign.campaignKey,
    });
    expect(lead.sourceKind).toBe('campaign');
    const traced = await campaigns.findByCampaignKey(lead.sourceId, null);
    expect(traced?.id).toBe(campaign.id);
  });
});
