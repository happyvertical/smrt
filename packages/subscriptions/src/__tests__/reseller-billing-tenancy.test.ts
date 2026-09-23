/**
 * Reseller billing with the tenancy interceptor registered (#3059): the
 * host-authorized paths must work from a parent's own tenant context, and a
 * child's own-context spend check must enforce its parent's caps.
 */
import {
  BillingRelationshipService,
  disableTenancy,
  enableTenancy,
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  PricingRuleCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  CreditGrantCollection,
  type PriceBook,
  PriceBookCollection,
  RetailChargeCollection,
} from '../models/reseller.js';
import {
  CommercialUsageService,
  SpendingPolicyEvaluator,
} from '../services/commercial.js';
import { ResellerBillingService } from '../services/reseller.js';

const PROVIDER = '00000000-0000-4000-8000-00000000000a';
const RESELLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHILD = 'cccccccc-3333-4333-8333-cccccccccccc';

describe('smrt#3059 reseller billing under the tenancy interceptor', () => {
  let usage: TenantUsageMetricCollection;
  let policies: SpendingPolicyCollection;
  let charges: ClientChargeCollection;
  let adjustments: BillingAdjustmentCollection;
  let commercial: CommercialUsageService;
  let relationships: BillingRelationshipService;
  let reseller: ResellerBillingService;
  let wholesaleBook: PriceBook;
  let retailBook: PriceBook;

  beforeAll(() => enableTenancy());
  afterAll(() => disableTenancy());

  beforeEach(async () => {
    usage = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const options = { db: usage.db };
    const rules = await PricingRuleCollection.create(options);
    charges = await ClientChargeCollection.create(options);
    adjustments = await BillingAdjustmentCollection.create(options);
    policies = await SpendingPolicyCollection.create(options);
    const books = await PriceBookCollection.create(options);
    commercial = new CommercialUsageService(
      usage,
      rules,
      charges,
      adjustments,
      { adapterType: 'sqlite' },
    );
    relationships = await BillingRelationshipService.create({
      db: usage.db,
      tenantExists: async (id) => [PROVIDER, RESELLER, CHILD].includes(id),
    });
    // The host lets a parent manage its own children and lets the provider
    // authorize wholesale assignments.
    reseller = await ResellerBillingService.create({
      db: usage.db,
      billingRelationships: relationships,
      authorize: async ({ action, tenantId }) =>
        action === 'manage_child_spending' ||
        action === 'assign_retail_price_book'
          ? tenantId === RESELLER
          : action === 'assign_wholesale_price_book' && tenantId === PROVIDER,
    });
    await withSystemContext(async () => {
      wholesaleBook = await books.create({
        tenantId: PROVIDER,
        bookKey: 'wholesale',
        kind: 'wholesale',
      });
      retailBook = await books.create({
        tenantId: RESELLER,
        bookKey: 'retail',
        kind: 'retail',
      });
      for (const [book, unitPrice] of [
        [wholesaleBook, 2],
        [retailBook, 5],
      ] as const) {
        await reseller.definePrice({
          priceBookId: String(book.id),
          ruleKey: 'tokens',
          metricKey: 'ai.tokens',
          strategy: 'fixed_unit',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          prices: [
            { currency: 'USD', terms: { unitPrice } },
            { currency: 'CAD', terms: { unitPrice: unitPrice + 1 } },
          ],
        });
      }
      await relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'reseller',
      });
    });
  });

  it('runs host-authorized mutations from the parent context', async () => {
    await withTenant({ tenantId: RESELLER }, async () => {
      await reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'USD' },
        retail: { priceBookId: String(retailBook.id), currency: 'USD' },
      });
      const balance = await reseller.setDelegatedSpendingPolicy({
        parentTenantId: RESELLER,
        childTenantId: CHILD,
        name: 'Prepaid',
        basis: 'retail',
        currency: 'USD',
        behavior: 'block',
        period: 'balance',
      });
      const grant = await reseller.grantChildCredit({
        parentTenantId: RESELLER,
        childTenantId: CHILD,
        spendingPolicyId: String(balance.id),
        amount: 75,
        source: 'order',
        sourceId: 'o-1',
      });
      expect(grant).toMatchObject({ tenantId: CHILD, amount: 75 });
    });
    // The child cannot fund or rewrite its parent's balance.
    await withTenant({ tenantId: CHILD }, async () => {
      const [balance] = await policies.list({ where: { name: 'Prepaid' } });
      if (!balance) throw new Error('missing policy');
      balance.active = false;
      await expect(balance.save()).rejects.toBeInstanceOf(TenantIsolationError);
    });
  });

  it('enforces parent caps in the child context, including wholesale basis', async () => {
    await withSystemContext(async () => {
      await reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'USD' },
        retail: { priceBookId: String(retailBook.id), currency: 'USD' },
      });
      await reseller.setDelegatedSpendingPolicy({
        parentTenantId: RESELLER,
        childTenantId: CHILD,
        name: 'Wholesale cap',
        basis: 'wholesale',
        currency: 'USD',
        behavior: 'block',
        limitAmount: 25,
      });
      const event = await commercial.record({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        quantity: 10,
        windowStart: new Date('2026-07-01T00:00:00Z'),
        windowEnd: new Date('2026-07-01T00:01:00Z'),
        source: 'ai-run',
        sourceId: 'run-1',
      });
      await commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
        approved: true,
      });
    });
    const evaluator = new SpendingPolicyEvaluator(
      policies,
      charges,
      adjustments,
      {
        retailCharges: await RetailChargeCollection.create({ db: usage.db }),
        credits: await CreditGrantCollection.create({ db: usage.db }),
        billingRelationships: relationships,
      },
    );
    const decision = await withTenant({ tenantId: CHILD }, () =>
      evaluator.evaluate({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 6,
        currency: 'USD',
      }),
    );
    // 20 wholesale already billed to the parent for this child + 6 > 25.
    expect(decision).toMatchObject({ state: 'blocked', projectedAmount: 26 });
  });

  it('refuses a wholesale book published by the child it would charge', async () => {
    const own = await withSystemContext(async () =>
      (await PriceBookCollection.create({ db: usage.db })).create({
        tenantId: CHILD,
        bookKey: 'child-wholesale',
        kind: 'wholesale',
      }),
    );
    await expect(
      withTenant({ tenantId: RESELLER }, () =>
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: { priceBookId: String(own.id), currency: 'USD' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_BOOK_OWNER_MISMATCH' });
  });
});
