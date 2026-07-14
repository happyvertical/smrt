import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import { MetricIngestionService } from '../services/MetricIngestionService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('marketing natural keys on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;
  let snapshots: CampaignMetricSnapshotCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Campaign', 'CampaignChannel', 'CampaignMetricSnapshot'],
    });
    db = isolated.db;
    campaigns = await CampaignCollection.create({ db });
    snapshots = await CampaignMetricSnapshotCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('upserts the nullable-tenant campaign key and dedupes ingestion', async () => {
    await campaigns.create({
      campaignKey: 'postgres-global-campaign',
      name: 'First name',
    });
    const second = await campaigns.create({
      campaignKey: 'postgres-global-campaign',
      name: 'Updated name',
    });
    expect(
      await campaigns.list({
        where: { campaignKey: 'postgres-global-campaign' },
      }),
    ).toHaveLength(1);
    second.transitionTo('scheduled');
    await second.save();
    second.transitionTo('active');
    await second.save();
    await expect(
      campaigns.create({
        campaignKey: 'postgres-global-campaign',
        name: 'Lifecycle bypass attempt',
      }),
    ).rejects.toThrow(/illegal status transition/);

    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const tenantCampaignA = await campaigns.create({
      tenantId: tenantA,
      campaignKey: 'postgres-shared-campaign',
      name: 'Tenant A campaign',
    });
    const tenantCampaignB = await campaigns.create({
      tenantId: tenantB,
      campaignKey: 'postgres-shared-campaign',
      name: 'Tenant B campaign',
    });
    expect(tenantCampaignA.tenantId).toBe(tenantA);
    expect(tenantCampaignB.tenantId).toBe(tenantB);
    expect(
      await campaigns.list({
        where: { campaignKey: 'postgres-shared-campaign' },
      }),
    ).toHaveLength(2);

    const ingestion = new MetricIngestionService(snapshots);
    const input = {
      campaignId: second.id ?? '',
      periodStart: new Date('2026-07-01T00:00:00Z'),
      periodEnd: new Date('2026-07-01T23:59:59Z'),
      spendCents: 1_000,
      source: 'postgres-test',
      dedupeKey: 'postgres-global-campaign:2026-07-01',
    };
    const first = await ingestion.ingest(input);
    const replay = await ingestion.ingest({ ...input, spendCents: 2_000 });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.snapshot.id).toBe(first.snapshot.id);
    expect(replay.snapshot.spendCents).toBe(1_000);
  });
});
