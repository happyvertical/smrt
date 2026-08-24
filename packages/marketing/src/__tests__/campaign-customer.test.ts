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
    const emptyGlobalCustomer = await customers.create({});

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
    expect(
      (await campaigns.listByCustomer(null, globalCustomer.id ?? '')).items.map(
        (campaign) => campaign.id,
      ),
    ).toEqual([globalSaved.id]);
    expect(
      await campaigns.summarizeByCustomers(null, [
        globalCustomer.id ?? '',
        emptyGlobalCustomer.id ?? '',
      ]),
    ).toEqual([
      {
        customerId: globalCustomer.id,
        totalCount: 1,
        activeCount: 0,
        latestStartAt: null,
      },
      {
        customerId: emptyGlobalCustomer.id,
        totalCount: 0,
        activeCount: 0,
        latestStartAt: null,
      },
    ]);
    await expect(
      withTenant({ tenantId: tenantA }, () =>
        campaigns.listByCustomer(null, globalCustomer.id ?? ''),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);

    const contextSaved = await withTenant({ tenantId: tenantA }, () =>
      campaigns.create({
        customerId: customerA.id,
        campaignKey: 'context-tenant-campaign',
        name: 'Context tenant campaign',
      }),
    );
    expect(contextSaved.tenantId).toBe(tenantA);
    await expect(
      withTenant({ tenantId: tenantA }, () =>
        campaigns.create({
          customerId: globalCustomer.id,
          campaignKey: 'context-global-campaign',
          name: 'Rejected context global campaign',
        }),
      ),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);

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
    await expect(
      campaigns.create({
        tenantId: tenantA,
        customerId: 'not-a-uuid',
        campaignKey: 'invalid-customer-id',
        name: 'Invalid Customer id',
      }),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    await expect(
      campaigns.create({
        tenantId: 'not-a-uuid',
        customerId: customerA.id,
        campaignKey: 'invalid-tenant-id',
        name: 'Invalid tenant id',
      }),
    ).rejects.toBeInstanceOf(CampaignCustomerScopeError);
  });

  it('validates and persists a Campaign on the same transaction database', async () => {
    const tenantId = randomUUID();
    const customer = await customers.create({ tenantId });
    const rootGet = vi.spyOn(db, 'get');
    const rootQuery = vi.spyOn(db, 'query');
    const rootUpsert = vi.spyOn(db, 'upsert');
    const originalTransaction = db.transaction?.bind(db);
    expect(originalTransaction).toBeTypeOf('function');
    let transactionDb: DatabaseInterface | undefined;
    let transactionGet: ReturnType<typeof vi.spyOn> | undefined;
    let transactionQuery: ReturnType<typeof vi.spyOn> | undefined;
    let transactionUpsert: ReturnType<typeof vi.spyOn> | undefined;
    const transaction = vi
      .spyOn(db, 'transaction')
      .mockImplementation(async (operation) =>
        originalTransaction?.(async (tx) => {
          transactionDb = tx;
          transactionGet = vi.spyOn(tx, 'get');
          transactionQuery = vi.spyOn(tx, 'query');
          transactionUpsert = vi.spyOn(tx, 'upsert');
          return operation(tx);
        }),
      );

    const saved = await campaigns.create({
      tenantId,
      customerId: customer.id,
      campaignKey: 'atomic-customer-scope',
      name: 'Atomic customer scope',
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionDb).toBeDefined();
    expect(transactionDb).not.toBe(db);
    expect(
      transactionGet?.mock.calls.some(([table]) => table === 'campaigns'),
    ).toBe(true);
    expect(
      transactionQuery?.mock.calls.some(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('FROM customers') &&
          sql.includes('WHERE id IN'),
      ),
    ).toBe(true);
    expect(
      transactionUpsert?.mock.calls.some(([table]) => table === 'campaigns'),
    ).toBe(true);
    expect(rootGet).not.toHaveBeenCalled();
    expect(rootQuery).not.toHaveBeenCalled();
    expect(rootUpsert).not.toHaveBeenCalled();
    expect(saved.db).toBe(db);
    expect(saved.options.db).toBe(db);
  });

  it('preserves unassociated saves while failing closed without transactions', async () => {
    const noTransactionDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') return undefined;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const unassociatedCampaigns = await CampaignCollection.create({
      db: noTransactionDb,
    });
    const saved = await unassociatedCampaigns.create({
      campaignKey: 'unassociated-no-transaction',
      name: 'Unassociated without transaction',
    });
    expect(saved.id).toBeDefined();

    const tenantId = randomUUID();
    const customer = await customers.create({ tenantId });
    await expect(
      unassociatedCampaigns.create({
        tenantId,
        customerId: customer.id,
        campaignKey: 'associated-no-transaction',
        name: 'Associated without transaction',
      }),
    ).rejects.toThrow(/requires a database adapter with transaction support/);
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

    const numericFirst = await campaigns.listByCustomer(
      tenantId.toUpperCase(),
      (customer.id ?? '').toUpperCase(),
      { limit: 1 },
    );
    const numericCursor = numericFirst.nextCursor;
    expect(numericCursor?.startAt).toBeInstanceOf(Date);
    const numericSecond = await campaigns.listByCustomer(
      tenantId.toUpperCase(),
      (customer.id ?? '').toUpperCase(),
      {
        limit: 1,
        after: {
          id: (numericCursor?.id ?? '').toUpperCase(),
          startAt: numericCursor?.startAt?.getTime() ?? Number.NaN,
        },
      },
    );
    expect(numericSecond.items[0]?.id).toBe(expectedTiedIds[1]);
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

    const originalTransaction = db.transaction?.bind(db);
    expect(originalTransaction).toBeTypeOf('function');
    let transactionDb: DatabaseInterface | undefined;
    let transactionQuery: ReturnType<typeof vi.spyOn> | undefined;
    const transaction = vi
      .spyOn(db, 'transaction')
      .mockImplementation(async (operation) =>
        originalTransaction?.(async (tx) => {
          transactionDb = tx;
          transactionQuery = vi.spyOn(tx, 'query');
          return operation(tx);
        }),
      );
    const summaries = await campaigns.summarizeByCustomers(tenantId, [
      customerA.id ?? '',
      customerB.id ?? '',
      emptyCustomer.id ?? '',
      customerA.id ?? '',
    ]);
    expect(transaction).toHaveBeenCalledOnce();
    expect(transactionDb).not.toBe(db);
    const transactionSql =
      transactionQuery?.mock.calls.map(([sql]) => String(sql)) ?? [];
    expect(transactionSql).toHaveLength(6);
    expect(
      transactionSql.filter(
        (sql) =>
          sql.includes('FROM customers') || sql.includes('FROM campaigns'),
      ),
    ).toHaveLength(2);
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
      {
        customerId: customerA.id,
        totalCount: 2,
        activeCount: 1,
        latestStartAt: startLatest,
      },
    ]);
  });

  it('keeps framework cross-package failures behind the typed scope error', async () => {
    const tenantId = randomUUID();
    const customer = await customers.create({ tenantId });
    const originalTransaction = db.transaction?.bind(db);
    expect(originalTransaction).toBeTypeOf('function');
    vi.spyOn(db, 'transaction').mockImplementation(async (operation) =>
      originalTransaction?.(async (tx) => {
        const originalGet = tx.get.bind(tx);
        vi.spyOn(tx, 'get').mockImplementation(async (table, where) => {
          if (table === 'customers') return null;
          return originalGet(table, where);
        });
        return operation(tx);
      }),
    );

    const save = campaigns.create({
      tenantId,
      customerId: customer.id,
      campaignKey: 'customer-race',
      name: 'Customer race',
    });
    await expect(save).rejects.toBeInstanceOf(CampaignCustomerScopeError);
    await expect(save).rejects.not.toThrow(customer.id);
    await expect(save).rejects.not.toThrow(/no such row exists/);
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
