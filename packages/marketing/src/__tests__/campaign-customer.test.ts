import { randomUUID } from 'node:crypto';
import { CustomerCollection } from '@happyvertical/smrt-commerce';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignCollection,
  MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE,
} from '../collections/CampaignCollection.js';
import { CampaignCustomerScopeError } from '../errors.js';
import * as marketing from '../index.js';
import type { CampaignCustomerCursor } from '../types.js';

describe('Campaign customer scope', () => {
  let db: DatabaseInterface;
  let campaigns: CampaignCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    customers = await CustomerCollection.create({ db });
    campaigns = await CampaignCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    vi.restoreAllMocks();
    await db?.close?.();
  });

  it('publishes a native Customer UUID and the bounded composite index', () => {
    const schema = ObjectRegistry.getSchema('Campaign');
    expect(schema?.columns.customer_id).toMatchObject({
      type: 'UUID',
      referenceKind: 'crossPackageRef',
    });
    expect(schema?.columns.customer_id?.required).not.toBe(true);
    expect(
      schema?.indexes.find(
        (index) =>
          index.name === 'campaigns_tenant_id_customer_id_start_at_id_idx',
      ),
    ).toMatchObject({
      columns: ['tenant_id', 'customer_id', 'start_at', 'id'],
    });
    expect(marketing.CampaignCustomerScopeError).toBe(
      CampaignCustomerScopeError,
    );
    expect(marketing.MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE).toBe(100);
    expect(typeof marketing.CampaignCollection.prototype.listByCustomer).toBe(
      'function',
    );
    expect(
      typeof marketing.CampaignCollection.prototype.summarizeByCustomers,
    ).toBe('function');
  });

  it('requires exact Campaign and Customer tenant agreement before save', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const customerA = await customers.create({ tenantId: tenantA });
    const customerB = await customers.create({ tenantId: tenantB });
    const globalCustomer = await customers.create({});

    const saved = await campaigns.create({
      tenantId: tenantA,
      customerId: customerA.id,
      campaignKey: 'tenant-a-campaign',
      name: 'Tenant A campaign',
    });
    expect(saved.customerId).toBe(customerA.id);
    const globalSaved = await campaigns.create({
      customerId: globalCustomer.id,
      campaignKey: 'global-campaign',
      name: 'Global campaign',
    });
    expect(globalSaved.tenantId).toBeNull();

    for (const input of [
      { tenantId: tenantA, customerId: customerB.id },
      { tenantId: tenantA, customerId: globalCustomer.id },
      { tenantId: null, customerId: customerA.id },
      { tenantId: tenantA, customerId: randomUUID() },
    ]) {
      await expect(
        campaigns.create({
          ...input,
          campaignKey: randomUUID(),
          name: 'Rejected campaign',
        }),
      ).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    }
  });

  it('paginates equal and null start times without duplicates', async () => {
    const tenantId = randomUUID();
    const customer = await customers.create({ tenantId });
    const otherCustomer = await customers.create({ tenantId });
    const tiedStart = new Date('2026-08-01T00:00:00.000Z');
    const tied = [];
    for (let index = 0; index < 5; index += 1) {
      tied.push(
        await campaigns.create({
          tenantId,
          customerId: customer.id,
          campaignKey: `tied-${index}`,
          name: `Tied ${index}`,
          startAt: tiedStart,
        }),
      );
    }
    const nullStart = await campaigns.create({
      tenantId,
      customerId: customer.id,
      campaignKey: 'null-start',
      name: 'Null start',
    });
    const olderStart = new Date('2026-07-01T00:00:00.000Z');
    const older = await campaigns.create({
      tenantId,
      customerId: customer.id,
      campaignKey: 'older-start',
      name: 'Older start',
      startAt: olderStart,
    });
    await campaigns.create({
      tenantId,
      customerId: otherCustomer.id,
      campaignKey: 'other-customer',
      name: 'Other customer',
      startAt: tiedStart,
    });

    const seen = [];
    let after: CampaignCustomerCursor | undefined;
    do {
      const page = await campaigns.listByCustomer(tenantId, customer.id ?? '', {
        limit: 2,
        after,
      });
      seen.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);

    const expectedTiedIds = tied
      .map((campaign) => campaign.id ?? '')
      .sort((left, right) => right.localeCompare(left));
    expect(seen.map((campaign) => campaign.id)).toEqual([
      ...expectedTiedIds,
      older.id,
      nullStart.id,
    ]);
    expect(new Set(seen.map((campaign) => campaign.id)).size).toBe(7);
  });

  it('resolves multi-Customer summaries in two bounded queries', async () => {
    const tenantId = randomUUID();
    const customerA = await customers.create({ tenantId });
    const customerB = await customers.create({ tenantId });
    const emptyCustomer = await customers.create({ tenantId });
    const startEarly = new Date('2026-07-01T00:00:00.000Z');
    const startLatest = new Date('2026-08-01T00:00:00.000Z');
    await campaigns.create({
      tenantId,
      customerId: customerA.id,
      campaignKey: 'a-active',
      name: 'A active',
      status: 'active',
      startAt: startEarly,
    });
    await campaigns.create({
      tenantId,
      customerId: customerA.id,
      campaignKey: 'a-draft',
      name: 'A draft',
      startAt: startLatest,
    });
    await campaigns.create({
      tenantId,
      customerId: customerB.id,
      campaignKey: 'b-active',
      name: 'B active',
      status: 'active',
      startAt: startEarly,
    });

    const query = vi.spyOn(db, 'query');
    query.mockClear();
    const summaries = await campaigns.summarizeByCustomers(tenantId, [
      customerA.id ?? '',
      customerB.id ?? '',
      emptyCustomer.id ?? '',
      customerA.id ?? '',
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(summaries).toEqual([
      {
        customerId: customerA.id,
        totalCount: 2,
        activeCount: 1,
        latestStartAt: startLatest,
      },
      {
        customerId: customerB.id,
        totalCount: 1,
        activeCount: 1,
        latestStartAt: startEarly,
      },
      {
        customerId: emptyCustomer.id,
        totalCount: 0,
        activeCount: 0,
        latestStartAt: null,
      },
    ]);
  });

  it('fails closed for cross-tenant lookup and rejects oversized inputs', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const customerA = await customers.create({ tenantId: tenantA });

    await expect(
      campaigns.listByCustomer(tenantB, customerA.id ?? ''),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    await expect(
      campaigns.summarizeByCustomers(tenantB, [customerA.id ?? '']),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    await expect(
      withTenant({ tenantId: tenantA }, () =>
        campaigns.listByCustomer(tenantB, customerA.id ?? ''),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    await expect(
      campaigns.listByCustomer(tenantA, customerA.id ?? '', { limit: 101 }),
    ).rejects.toThrow(/must not exceed 100/);
    await expect(
      campaigns.listByCustomer(tenantA, customerA.id ?? '', { limit: 0 }),
    ).rejects.toThrow(/at least 1/);
    await expect(
      campaigns.summarizeByCustomers(
        tenantA,
        Array.from(
          { length: MAX_CAMPAIGN_CUSTOMER_BATCH_SIZE + 1 },
          () => customerA.id ?? '',
        ),
      ),
    ).rejects.toThrow(/at most 100/);

    const query = vi.spyOn(db, 'query');
    query.mockClear();
    await expect(
      campaigns.listByCustomer(tenantA, customerA.id ?? '', {
        limit: Number.NaN,
      }),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      campaigns.listByCustomer(tenantA, customerA.id ?? '', {
        after: { id: randomUUID(), startAt: 'not-a-date' },
      }),
    ).rejects.toThrow(/cursor startAt is invalid/);
    expect(query).not.toHaveBeenCalled();
  });
});
