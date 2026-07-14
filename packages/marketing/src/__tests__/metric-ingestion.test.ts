import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CampaignChannelCollection,
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import {
  BudgetPacingService,
  MetricIngestionService,
} from '../services/index.js';
import '../index.js';

describe('metric ingestion and budget pacing', () => {
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;
  let channels: CampaignChannelCollection;
  let snapshots: CampaignMetricSnapshotCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    campaigns = await CampaignCollection.create({ db });
    channels = await CampaignChannelCollection.create({ db });
    snapshots = await CampaignMetricSnapshotCollection.create({ db });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('keeps snapshot surfaces create-only on every generated door', () => {
    const config = ObjectRegistry.getConfig('CampaignMetricSnapshot');
    for (const door of [config.api, config.mcp, config.cli]) {
      if (typeof door === 'boolean' || door === undefined) {
        throw new Error('expected an explicit object surface');
      }
      expect(door.include).toContain('create');
      expect(door.include).not.toContain('update');
      expect(door.include).not.toContain('delete');
    }
  });

  it('ingests idempotently and refuses every evidence rewrite path', async () => {
    const campaign = await campaigns.create({
      campaignKey: 'immutable-evidence',
      name: 'Immutable evidence',
    });
    const ingestion = new MetricIngestionService(snapshots);
    const input = {
      campaignId: campaign.id ?? '',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-01T23:59:59Z'),
      spendCents: 12_345,
      impressions: 5_000,
      clicks: 400,
      conversions: 30,
      leads: 20,
      revenueCents: 75_000,
      source: 'warehouse-rollup',
      dedupeKey: 'immutable-evidence:2026-07-01',
    };

    const first = await ingestion.ingest(input);
    expect(first.created).toBe(true);
    const replay = await ingestion.ingest({ ...input, spendCents: 99_999 });
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.snapshot.spendCents).toBe(12_345);

    first.snapshot.clicks = 999;
    await expect(first.snapshot.save()).rejects.toThrow(/immutable evidence/);
    await expect(first.snapshot.delete()).rejects.toThrow(/cannot be deleted/);

    await expect(
      snapshots.create({
        ...input,
        id: first.snapshot.id,
        _skipLoad: true,
        clicks: 777,
      }),
    ).rejects.toThrow(/immutable evidence/);

    await expect(snapshots.create({ ...input, spendCents: 1 })).rejects.toThrow(
      /idempotent ingestion/,
    );
  });

  it('keeps concurrent retries insert-only and rejects invalid periods', async () => {
    const campaign = await campaigns.create({
      campaignKey: 'concurrent-evidence',
      name: 'Concurrent evidence',
    });
    const ingestion = new MetricIngestionService(snapshots);
    const input = {
      campaignId: campaign.id ?? '',
      periodStart: new Date('2026-07-02T00:00:00Z'),
      periodEnd: new Date('2026-07-02T23:59:59Z'),
      source: 'warehouse-rollup',
      dedupeKey: 'concurrent-evidence:2026-07-02',
    };

    const results = await Promise.all([
      ingestion.ingest({ ...input, spendCents: 1_000 }),
      ingestion.ingest({ ...input, spendCents: 9_000 }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].snapshot.id).toBe(results[1].snapshot.id);
    const persisted = await snapshots.findByDedupeKey(input.dedupeKey);
    expect(persisted?.spendCents).toBe(results[0].snapshot.spendCents);

    await expect(
      ingestion.ingest({
        ...input,
        dedupeKey: 'invalid-period',
        periodStart: 'not-a-date',
      }),
    ).rejects.toThrow(/valid dates/);
  });

  it('uses campaign rollups when present and otherwise sums channel evidence', async () => {
    const campaign = await campaigns.create({
      campaignKey: 'pacing',
      name: 'Pacing campaign',
      status: 'active',
      startAt: new Date('2026-07-01T00:00:00Z'),
      endAt: new Date('2026-07-11T00:00:00Z'),
      budgetCents: 100_000,
      currency: 'CAD',
    });
    const ads = await channels.create({
      campaignId: campaign.id ?? '',
      channelKind: 'ad_group',
      channelRef: 'ads-ag-1',
      allocatedBudgetCents: 60_000,
      status: 'active',
    });
    const social = await channels.create({
      campaignId: campaign.id ?? '',
      channelKind: 'social_post',
      channelRef: 'social-post-1',
      allocatedBudgetCents: 40_000,
      status: 'active',
    });
    const ingestion = new MetricIngestionService(snapshots);
    const period = {
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-05T23:59:59Z'),
      source: 'channel-sync',
    };
    await ingestion.ingest({
      ...period,
      campaignId: campaign.id ?? '',
      campaignChannelId: ads.id ?? '',
      spendCents: 20_000,
      dedupeKey: 'pacing:ads:first-half',
    });
    await ingestion.ingest({
      ...period,
      campaignId: campaign.id ?? '',
      campaignChannelId: social.id ?? '',
      spendCents: 5_000,
      dedupeKey: 'pacing:social:first-half',
    });

    const pacing = new BudgetPacingService(campaigns, channels, snapshots);
    const at = new Date('2026-07-06T00:00:00Z');
    const channelOnly = await pacing.getCampaignPacing(campaign.id ?? '', at);
    expect(channelOnly.spendCents).toBe(25_000);
    expect(channelOnly.expectedSpendCents).toBe(50_000);
    expect(channelOnly.status).toBe('behind');
    expect(channelOnly.usedCampaignRollups).toBe(false);

    await ingestion.ingest({
      ...period,
      campaignId: campaign.id ?? '',
      spendCents: 30_000,
      dedupeKey: 'pacing:campaign:first-half',
      source: 'campaign-rollup',
    });
    const rolledUp = await pacing.getCampaignPacing(campaign.id ?? '', at);
    expect(rolledUp.spendCents).toBe(30_000);
    expect(rolledUp.usedCampaignRollups).toBe(true);

    await ingestion.ingest({
      campaignId: campaign.id ?? '',
      campaignChannelId: social.id ?? '',
      periodStart: new Date('2026-07-06T00:00:00Z'),
      periodEnd: new Date('2026-07-10T23:59:59Z'),
      spendCents: 10_000,
      source: 'channel-sync',
      dedupeKey: 'pacing:social:second-half',
    });
    const mixedPeriods = await pacing.getCampaignPacing(campaign.id ?? '', at);
    expect(mixedPeriods.spendCents).toBe(40_000);
    expect(mixedPeriods.usedCampaignRollups).toBe(true);

    const adsPacing = await pacing.getChannelPacing(ads.id ?? '', at);
    expect(adsPacing.campaignChannelId).toBe(ads.id);
    expect(adsPacing.spendCents).toBe(20_000);
    expect(adsPacing.budgetCents).toBe(60_000);
  });
});
