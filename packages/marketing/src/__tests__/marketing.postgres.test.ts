import { randomUUID } from 'node:crypto';
import { CustomerCollection } from '@happyvertical/smrt-commerce';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignCollection,
  CampaignMetricSnapshotCollection,
} from '../collections/index.js';
import { CampaignCustomerScopeError } from '../errors.js';
import { MetricIngestionService } from '../services/MetricIngestionService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('marketing natural keys on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;
  let customers: CustomerCollection;
  let snapshots: CampaignMetricSnapshotCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'Campaign',
        'CampaignChannel',
        'CampaignMetricSnapshot',
      ],
    });
    db = isolated.db;
    customers = await CustomerCollection.create({ db });
    campaigns = await CampaignCollection.create({ db });
    snapshots = await CampaignMetricSnapshotCollection.create({ db });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it('keeps native Customer scope, pagination, and summaries on PostgreSQL', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const customerA = await customers.create({ tenantId: tenantA });
    const customerB = await customers.create({ tenantId: tenantB });
    const transactionSql: string[] = [];
    const originalTransaction = db.transaction?.bind(db);
    expect(originalTransaction).toBeTypeOf('function');
    vi.spyOn(db, 'transaction').mockImplementation(async (operation) =>
      originalTransaction?.(async (tx) => {
        const query = vi.spyOn(tx, 'query');
        try {
          return await operation(tx);
        } finally {
          transactionSql.push(
            ...query.mock.calls
              .map(([sql]) => sql)
              .filter((sql): sql is string => typeof sql === 'string'),
          );
        }
      }),
    );
    const tiedStart = new Date('2026-08-01T00:00:00.000Z');
    const created = [];
    for (let index = 0; index < 3; index += 1) {
      created.push(
        await campaigns.create({
          tenantId: tenantA,
          customerId: customerA.id,
          campaignKey: `postgres-customer-${index}`,
          name: `PostgreSQL customer campaign ${index}`,
          status: index === 0 ? 'active' : 'draft',
          startAt: tiedStart,
        }),
      );
    }

    const first = await campaigns.listByCustomer(tenantA, customerA.id ?? '', {
      limit: 2,
    });
    const second = await campaigns.listByCustomer(tenantA, customerA.id ?? '', {
      limit: 2,
      after: first.nextCursor ?? undefined,
    });
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual(
      created
        .map((row) => row.id ?? '')
        .sort((left, right) => right.localeCompare(left)),
    );
    expect(
      await campaigns.summarizeByCustomers(tenantA, [customerA.id ?? '']),
    ).toEqual([
      {
        customerId: customerA.id,
        totalCount: 3,
        activeCount: 1,
        latestStartAt: tiedStart,
      },
    ]);
    expect(
      transactionSql.some(
        (sql) => sql.includes('FROM customers') && sql.endsWith('FOR UPDATE'),
      ),
    ).toBe(true);
    expect(
      transactionSql.some(
        (sql) => sql.includes('FROM customers') && sql.endsWith('FOR SHARE'),
      ),
    ).toBe(true);
    await expect(
      campaigns.listByCustomer(tenantA, customerB.id ?? ''),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);

    const column = await db.query(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'campaigns'
         AND column_name = 'customer_id'`,
    );
    expect(column.rows).toEqual([{ data_type: 'uuid' }]);
  });
});
