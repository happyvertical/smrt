import { randomUUID } from 'node:crypto';
import { CustomerCollection } from '@happyvertical/smrt-commerce';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignChannelCollection,
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import { CampaignCustomerScopeError } from '../errors.js';

describe('Campaign customer reporting page', () => {
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;
  let channels: CampaignChannelCollection;
  let customers: CustomerCollection;
  let snapshots: CampaignMetricSnapshotCollection;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    campaigns = await CampaignCollection.create({ db });
    channels = await CampaignChannelCollection.create({ db });
    customers = await CustomerCollection.create({ db });
    snapshots = await CampaignMetricSnapshotCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    vi.restoreAllMocks();
    await db?.close?.();
  });

  it('projects 25 campaigns with two grouped reads and canonical pacing', async () => {
    const tenantId = randomUUID();
    const customer = await customers.create({ tenantId });
    const periodOneStart = new Date('2026-08-01T00:00:00.000Z');
    const periodOneEnd = new Date('2026-08-07T23:59:59.000Z');
    const periodTwoStart = new Date('2026-08-08T00:00:00.000Z');
    const periodTwoEnd = new Date('2026-08-14T23:59:59.000Z');
    const created = [];

    for (let index = 0; index < 25; index += 1) {
      const campaign = await campaigns.create({
        tenantId,
        customerId: customer.id,
        campaignKey: `reporting-${index}`,
        name: `Reporting ${index}`,
        status: 'active',
        startAt: new Date(Date.UTC(2026, 7, index + 1)),
        endAt: new Date('2026-09-01T00:00:00.000Z'),
        budgetCents: 10_000,
      });
      created.push(campaign);
      await channels.create({
        tenantId,
        campaignId: campaign.id,
        channelKind: index % 2 === 0 ? 'ad_group' : 'social_post',
        channelRef: `primary-${index}`,
      });
    }

    const newest = created[24];
    const ad = await channels.create({
      tenantId,
      campaignId: newest.id,
      channelKind: 'ad_group',
      channelRef: 'newest-ad-extra',
    });
    const social = await channels.create({
      tenantId,
      campaignId: newest.id,
      channelKind: 'social_post',
      channelRef: 'newest-social-extra',
    });
    await snapshots.create({
      tenantId,
      campaignId: newest.id,
      campaignChannelId: ad.id,
      periodStart: periodOneStart,
      periodEnd: periodOneEnd,
      spendCents: 100,
      impressions: 1_000,
      clicks: 50,
      conversions: 5,
      leads: 4,
      revenueCents: 500,
      source: 'ad',
      dedupeKey: 'reporting-ad-period-one',
    });
    await snapshots.create({
      tenantId,
      campaignId: newest.id,
      campaignChannelId: social.id,
      periodStart: periodOneStart,
      periodEnd: periodOneEnd,
      spendCents: 200,
      impressions: 2_000,
      clicks: 60,
      conversions: 6,
      leads: 5,
      revenueCents: 600,
      source: 'social',
      dedupeKey: 'reporting-social-period-one',
    });
    await snapshots.create({
      tenantId,
      campaignId: newest.id,
      periodStart: periodOneStart,
      periodEnd: periodOneEnd,
      spendCents: 250,
      impressions: 2_500,
      clicks: 100,
      conversions: 10,
      leads: 8,
      revenueCents: 1_000,
      source: 'warehouse',
      dedupeKey: 'reporting-rollup-period-one',
    });
    await snapshots.create({
      tenantId,
      campaignId: newest.id,
      campaignChannelId: social.id,
      periodStart: periodTwoStart,
      periodEnd: periodTwoEnd,
      spendCents: 300,
      impressions: 3_000,
      clicks: 120,
      conversions: 12,
      leads: 9,
      revenueCents: null,
      source: 'social',
      dedupeKey: 'reporting-social-period-two',
    });

    const querySets: string[][] = [];
    const originalTransaction = db.transaction?.bind(db);
    expect(originalTransaction).toBeTypeOf('function');
    vi.spyOn(db, 'transaction').mockImplementation(async (operation) =>
      originalTransaction?.(async (tx) => {
        const query = vi.spyOn(tx, 'query');
        try {
          return await operation(tx);
        } finally {
          querySets.push(
            query.mock.calls
              .map(([sql]) => String(sql))
              .filter((sql) =>
                /FROM (customers|campaigns|campaign_channels|campaign_metric_snapshots)/u.test(
                  sql,
                ),
              ),
          );
        }
      }),
    );

    await campaigns.listReportingByCustomer(tenantId, customer.id ?? '', {
      limit: 1,
      at: new Date('2026-08-16T00:00:00.000Z'),
    });
    const page = await campaigns.listReportingByCustomer(
      tenantId,
      customer.id ?? '',
      {
        limit: 25,
        at: new Date('2026-08-16T00:00:00.000Z'),
      },
    );

    expect(page.items.map((item) => item.campaign.id)).toEqual(
      [...created].reverse().map((campaign) => campaign.id),
    );
    expect(page.nextCursor).toBeNull();
    expect(querySets).toHaveLength(2);
    for (const queries of querySets) {
      expect(
        queries.filter((sql) => sql.includes('FROM customers')),
      ).toHaveLength(1);
      expect(
        queries.filter((sql) =>
          sql.includes('GROUP BY campaign_id, channel_kind'),
        ),
      ).toHaveLength(1);
      expect(
        queries.filter((sql) => sql.includes('WITH scoped_snapshots')),
      ).toHaveLength(1);
    }
    expect(
      querySets.map(
        (queries) =>
          queries.filter(
            (sql) =>
              sql.includes('GROUP BY campaign_id, channel_kind') ||
              sql.includes('WITH scoped_snapshots'),
          ).length,
      ),
    ).toEqual([2, 2]);

    const report = page.items[0];
    expect(report.channelCount).toBe(3);
    expect(report.channelMix).toEqual([
      { channelKind: 'ad_group', count: 2 },
      { channelKind: 'social_post', count: 1 },
    ]);
    expect(report.metricTotals).toEqual({
      spendCents: 550,
      impressions: 5_500,
      clicks: 220,
      conversions: 22,
      leads: 17,
      revenueCents: 1_000,
    });
    expect(report.pacing).toMatchObject({
      campaignId: newest.id,
      spendCents: 550,
      snapshotCount: 2,
      usedCampaignRollups: true,
    });
    expect(page.items[1]).toMatchObject({
      channelCount: 1,
      metricTotals: {
        spendCents: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        leads: 0,
        revenueCents: 0,
      },
      pacing: { snapshotCount: 0, usedCampaignRollups: false },
    });
  });

  it('fails closed for tenant/customer mismatch and rejects invalid bounds', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const customer = await customers.create({ tenantId: tenantA });

    const mismatch = campaigns.listReportingByCustomer(
      tenantB,
      customer.id ?? '',
    );
    await expect(mismatch).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    await expect(mismatch).rejects.toThrow(
      /CampaignCollection\.listReportingByCustomer/,
    );
    await expect(mismatch).rejects.not.toThrow(customer.id);
    await expect(
      campaigns.listReportingByCustomer(tenantA, customer.id ?? '', {
        limit: 101,
      }),
    ).rejects.toThrow(/must not exceed 100/);
    await expect(
      campaigns.listReportingByCustomer(tenantA, customer.id ?? '', {
        at: 'not-a-date',
      }),
    ).rejects.toThrow(/reporting at is invalid/);
  });
});
