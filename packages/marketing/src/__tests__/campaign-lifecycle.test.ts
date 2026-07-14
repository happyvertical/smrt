import { randomUUID } from 'node:crypto';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCollection } from '../collections/CampaignCollection.js';
import { CampaignLifecycleService } from '../services/CampaignLifecycleService.js';
import type { CampaignStatus } from '../types.js';
import '../index.js';

describe('Campaign model and lifecycle', () => {
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    campaigns = await CampaignCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await db?.close?.();
  });

  it('registers natural keys, integer money, and explicit surfaces', () => {
    expect(ObjectRegistry.getConfig('Campaign').conflictColumns).toEqual([
      'tenant_id',
      'campaign_key',
    ]);
    expect(ObjectRegistry.getConfig('CampaignChannel').conflictColumns).toEqual(
      ['campaign_id', 'channel_kind', 'channel_ref'],
    );
    expect(
      ObjectRegistry.getConfig('CampaignMetricSnapshot').conflictColumns,
    ).toEqual(['dedupe_key']);

    for (const className of [
      'Campaign',
      'CampaignChannel',
      'CampaignMetricSnapshot',
    ]) {
      const config = ObjectRegistry.getConfig(className);
      expect(config.api).toBeDefined();
      expect(config.mcp).toBeDefined();
      expect(config.cli).toBeDefined();
    }

    const campaignSchema = ObjectRegistry.getSchema('Campaign');
    const channelSchema = ObjectRegistry.getSchema('CampaignChannel');
    const snapshotSchema = ObjectRegistry.getSchema('CampaignMetricSnapshot');
    if (!campaignSchema || !channelSchema || !snapshotSchema) {
      throw new Error('expected marketing schemas');
    }
    expect(campaignSchema.tableName).toBe('campaigns');
    expect(campaignSchema.columns.budget_cents.type).toBe('INTEGER');
    expect(channelSchema.tableName).toBe('campaign_channels');
    expect(channelSchema.columns.allocated_budget_cents.type).toBe('INTEGER');
    expect(snapshotSchema.tableName).toBe('campaign_metric_snapshots');
    expect(snapshotSchema.columns.spend_cents.type).toBe('INTEGER');
  });

  it('runs the guarded lifecycle, including pause and resume', async () => {
    const campaign = await campaigns.create({
      campaignKey: 'summer-launch',
      name: 'Summer launch',
      startAt: new Date('2026-07-01T00:00:00Z'),
      endAt: new Date('2026-07-31T23:59:59Z'),
      budgetCents: 100_000,
      currency: 'CAD',
    });
    const service = new CampaignLifecycleService(campaigns);
    const id = campaign.id ?? '';

    expect((await service.schedule(id)).status).toBe('scheduled');
    expect((await service.activate(id)).status).toBe('active');
    expect((await service.pause(id)).status).toBe('paused');
    expect((await service.resume(id)).status).toBe('active');
    expect((await service.complete(id)).status).toBe('completed');
    expect((await service.archive(id)).status).toBe('archived');
  });

  it('scopes the same natural campaign key independently per tenant', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();

    const firstA = await withTenant({ tenantId: tenantA }, () =>
      campaigns.create({
        campaignKey: 'shared-launch',
        name: 'Tenant A launch',
      }),
    );
    const firstB = await withTenant({ tenantId: tenantB }, () =>
      campaigns.create({
        campaignKey: 'shared-launch',
        name: 'Tenant B launch',
      }),
    );
    await withTenant({ tenantId: tenantA }, () =>
      campaigns.create({
        campaignKey: 'shared-launch',
        name: 'Tenant A launch updated',
      }),
    );

    expect(firstA.tenantId).toBe(tenantA);
    expect(firstB.tenantId).toBe(tenantB);
    expect(firstA.id).not.toBe(firstB.id);

    const seenByA = await withTenant({ tenantId: tenantA }, () =>
      campaigns.list({ where: { campaignKey: 'shared-launch' } }),
    );
    const seenByB = await withTenant({ tenantId: tenantB }, () =>
      campaigns.list({ where: { campaignKey: 'shared-launch' } }),
    );
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]?.name).toBe('Tenant A launch updated');
    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.name).toBe('Tenant B launch');
  });

  it('rejects skipped, reversed, and blind-overwrite transitions', async () => {
    await expect(
      campaigns.create({
        campaignKey: 'unknown-status',
        name: 'Unknown status',
        status: 'invented' as CampaignStatus,
      }),
    ).rejects.toThrow(/unknown status/);

    const campaign = await campaigns.create({
      campaignKey: 'guarded',
      name: 'Guarded campaign',
    });
    campaign.status = 'active';
    await expect(campaign.save()).rejects.toThrow(/illegal status transition/);

    const service = new CampaignLifecycleService(campaigns);
    await service.schedule(campaign.id ?? '');
    await service.activate(campaign.id ?? '');
    await service.complete(campaign.id ?? '');
    await service.archive(campaign.id ?? '');

    const loaded = await campaigns.get({ id: campaign.id });
    if (!loaded) throw new Error('campaign not found');
    loaded.status = 'draft';
    await expect(loaded.save()).rejects.toThrow(/illegal status transition/);

    await expect(
      campaigns.create({
        id: campaign.id,
        _skipLoad: true,
        campaignKey: 'guarded',
        name: 'Blind overwrite',
        status: 'draft',
      }),
    ).rejects.toThrow(/illegal status transition/);

    await expect(
      campaigns.create({
        campaignKey: 'guarded',
        name: 'Natural-key overwrite',
        status: 'draft',
      }),
    ).rejects.toThrow(/illegal status transition/);
  });

  it('round-trips guarded metadata and date values', async () => {
    const campaign = await campaigns.create({
      campaignKey: 'metadata',
      name: 'Metadata campaign',
      startAt: '2026-07-01T00:00:00Z',
      endAt: '2026-08-01T00:00:00Z',
    });
    campaign.setMetadata({ audience: 'builders', nested: { region: 'west' } });
    await campaign.save();

    const loaded = await campaigns.get({ id: campaign.id });
    expect(loaded?.startAt).toBeInstanceOf(Date);
    expect(loaded?.endAt).toBeInstanceOf(Date);
    expect(loaded?.getMetadata()).toEqual({
      audience: 'builders',
      nested: { region: 'west' },
    });
  });
});
