import {
  BillingRelationshipService,
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TenantUsageMetricCollection } from '../collections/TenantUsageMetricCollection.js';
import * as subscriptionsRoot from '../index.js';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  PricingRuleCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  CreditGrantCollection,
  type PriceBook,
  PriceBookAssignment,
  PriceBookCollection,
  RetailChargeCollection,
} from '../models/reseller.js';
import {
  type AutoTopUpHook,
  CommercialUsageService,
  SpendingPolicyEvaluator,
} from '../services/commercial.js';
import { ResellerBillingService } from '../services/reseller.js';

const PROVIDER = '00000000-0000-4000-8000-00000000000a';
const RESELLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_RESELLER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CHILD = 'cccccccc-3333-4333-8333-cccccccccccc';
const SOLO = 'dddddddd-4444-4444-8444-dddddddddddd';
const AT = new Date('2026-07-10T12:00:00Z');

describe('smrt#3059 reseller price books and delegated spending', () => {
  let usage: TenantUsageMetricCollection;
  let rules: PricingRuleCollection;
  let charges: ClientChargeCollection;
  let adjustments: BillingAdjustmentCollection;
  let policies: SpendingPolicyCollection;
  let books: PriceBookCollection;
  let retailCharges: RetailChargeCollection;
  let credits: CreditGrantCollection;
  let commercial: CommercialUsageService;
  let relationships: BillingRelationshipService;
  let reseller: ResellerBillingService;
  let wholesaleBook: PriceBook;
  let retailBook: PriceBook;
  let eventCounter = 0;

  const system = <T>(fn: () => Promise<T>) => withSystemContext(fn);

  const recordUsage = (tenantId: string, quantity = 10) =>
    commercial.record({
      tenantId,
      metricKey: 'ai.tokens',
      quantity,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: `run-${++eventCounter}`,
      projectId: 'project-1',
    });

  const evaluator = (autoTopUp?: AutoTopUpHook) =>
    new SpendingPolicyEvaluator(policies, charges, adjustments, {
      retailCharges,
      credits,
      autoTopUp,
    });

  beforeEach(async () => {
    usage = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const options = { db: usage.db };
    rules = await PricingRuleCollection.create(options);
    charges = await ClientChargeCollection.create(options);
    adjustments = await BillingAdjustmentCollection.create(options);
    policies = await SpendingPolicyCollection.create(options);
    books = await PriceBookCollection.create(options);
    retailCharges = await RetailChargeCollection.create(options);
    credits = await CreditGrantCollection.create(options);
    commercial = new CommercialUsageService(
      usage,
      rules,
      charges,
      adjustments,
      { adapterType: 'sqlite' },
    );
    const known = new Set([PROVIDER, RESELLER, OTHER_RESELLER, CHILD, SOLO]);
    relationships = await BillingRelationshipService.create({
      db: usage.db,
      tenantExists: async (id) => known.has(id),
    });
    reseller = await ResellerBillingService.create({
      db: usage.db,
      billingRelationships: relationships,
    });

    await system(async () => {
      wholesaleBook = await books.create({
        tenantId: PROVIDER,
        bookKey: 'wholesale-2026',
        name: 'Wholesale 2026',
        kind: 'wholesale',
      });
      retailBook = await books.create({
        tenantId: RESELLER,
        bookKey: 'retail-standard',
        name: 'Retail standard',
        kind: 'retail',
      });
      await reseller.definePrice({
        priceBookId: String(wholesaleBook.id),
        ruleKey: 'tokens',
        metricKey: 'ai.tokens',
        strategy: 'fixed_unit',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        prices: [
          { currency: 'USD', terms: { unitPrice: 2 } },
          { currency: 'CAD', terms: { unitPrice: 3 } },
        ],
      });
      await reseller.definePrice({
        priceBookId: String(retailBook.id),
        ruleKey: 'tokens',
        metricKey: 'ai.tokens',
        strategy: 'fixed_unit',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        prices: [
          { currency: 'USD', terms: { unitPrice: 5 } },
          { currency: 'EUR', terms: { unitPrice: 4.55 } },
        ],
      });
      // The child's and solo tenant's own direct pricing.
      for (const tenantId of [CHILD, SOLO]) {
        await rules.create({
          tenantId,
          ruleKey: 'direct',
          metricKey: 'ai.tokens',
          strategy: 'fixed_unit',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          terms: JSON.stringify({ unitPrice: 7 }),
        });
      }
      await relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'reseller',
      });
      await reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'USD' },
        retail: { priceBookId: String(retailBook.id), currency: 'USD' },
      });
    });
  });

  it('exports every manifest model from the package root', () => {
    for (const name of [
      'PriceBook',
      'PriceBookAssignment',
      'RetailCharge',
      'CreditGrant',
      'ResellerBillingService',
      'ResellerBillingError',
    ]) {
      expect(subscriptionsRoot, name).toHaveProperty(name);
    }
    expect(subscriptionsRoot.PriceBookAssignment).toBe(PriceBookAssignment);
    // Assignments are managed only through the service's checks.
    expect('PriceBookAssignmentCollection' in subscriptionsRoot).toBe(false);
  });

  it('stores one rule per currency for a multi-currency price', async () => {
    const bookRules = await rules.list({
      where: { priceBookId: String(wholesaleBook.id) },
    });
    expect(bookRules.map((rule) => rule.currency).sort()).toEqual([
      'CAD',
      'USD',
    ]);
    expect(new Set(bookRules.map((rule) => rule.tenantId))).toEqual(
      new Set([PROVIDER]),
    );
    // Re-defining the same rule key, currency, and date replaces its terms.
    await system(() =>
      reseller.definePrice({
        priceBookId: String(wholesaleBook.id),
        ruleKey: 'tokens',
        metricKey: 'ai.tokens',
        strategy: 'fixed_unit',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        prices: [{ currency: 'USD', terms: { unitPrice: 9 } }],
      }),
    );
    const usd = await rules.list({
      where: { priceBookId: String(wholesaleBook.id), currency: 'USD' },
    });
    expect(usd).toHaveLength(1);
    expect(usd[0]?.getTerms()).toEqual({ unitPrice: 9 });
    await expect(
      system(() =>
        reseller.definePrice({
          priceBookId: String(wholesaleBook.id),
          ruleKey: 'bad',
          metricKey: 'ai.tokens',
          strategy: 'fixed_unit',
          prices: [
            { currency: 'USD', terms: {} },
            { currency: 'USD', terms: {} },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
    await expect(
      system(() =>
        reseller.definePrice({
          priceBookId: String(wholesaleBook.id),
          ruleKey: 'bad',
          metricKey: 'ai.tokens',
          strategy: 'fixed_unit',
          prices: [{ currency: 'usd', terms: {} }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURRENCY' });
  });

  it('keeps service-specific prices with the same rule key distinct', async () => {
    const define = (serviceKey: string, unitPrice: number) =>
      system(() =>
        reseller.definePrice({
          priceBookId: String(retailBook.id),
          ruleKey: 'svc',
          metricKey: 'ai.requests',
          serviceKey,
          strategy: 'fixed_unit',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          prices: [{ currency: 'USD', terms: { unitPrice } }],
        }),
      );
    const [a] = await define('chat', 1);
    const [b] = await define('images', 2);
    expect(a?.id).not.toBe(b?.id);
    const rows = await rules.list({
      where: { priceBookId: String(retailBook.id), metricKey: 'ai.requests' },
    });
    expect(
      rows.map((rule) => [rule.serviceKey, rule.getTerms().unitPrice]).sort(),
    ).toEqual([
      ['chat', 1],
      ['images', 2],
    ]);
  });

  it('merges concurrent single-leg assignment updates without losing a leg', async () => {
    await system(() =>
      reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: null,
        retail: null,
      }),
    );
    await system(() =>
      Promise.all([
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: { priceBookId: String(wholesaleBook.id), currency: 'CAD' },
        }),
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          retail: { priceBookId: String(retailBook.id), currency: 'EUR' },
        }),
      ]),
    );
    expect(
      await system(() => reseller.getPriceBookAssignment(CHILD)),
    ).toMatchObject({
      wholesale: { priceBookId: wholesaleBook.id, currency: 'CAD' },
      retail: { priceBookId: retailBook.id, currency: 'EUR' },
    });
  });

  it('rates reseller-billed usage as wholesale to the reseller and retail to the child', async () => {
    const event = await recordUsage(CHILD, 10);
    const rating = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
        approved: true,
      }),
    );
    expect(rating).toMatchObject({
      usageTenantId: CHILD,
      billingOwnerTenantId: RESELLER,
      mode: 'wholesale',
    });
    expect(rating.charge).toMatchObject({
      tenantId: RESELLER,
      usageTenantId: CHILD,
      amount: 20,
      currency: 'USD',
      priceBookId: wholesaleBook.id,
      status: 'approved',
    });
    expect(rating.retailCharge).toMatchObject({
      tenantId: CHILD,
      resellerTenantId: RESELLER,
      clientChargeId: rating.charge.id,
      amount: 50,
      currency: 'USD',
      priceBookId: retailBook.id,
      status: 'approved',
    });
    expect(rating.charge.getPricingSnapshot()).toMatchObject({
      priceBookKey: 'wholesale-2026',
      priceBookKind: 'wholesale',
      billingOwnerTenantId: RESELLER,
    });

    // Idempotent: a second rating returns the same records.
    const again = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
      }),
    );
    expect(again.charge.id).toBe(rating.charge.id);
    expect(again.retailCharge?.id).toBe(rating.retailCharge?.id);
    expect(await charges.list({ where: {} })).toHaveLength(1);
    expect(await retailCharges.list({ where: {} })).toHaveLength(1);
  });

  it('approves both legs of a draft rating together, then freezes them', async () => {
    const event = await recordUsage(CHILD, 2);
    const draft = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
      }),
    );
    expect(draft.charge.status).toBe('draft');
    expect(draft.retailCharge?.status).toBe('draft');
    const approved = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
        approved: true,
      }),
    );
    expect(approved.charge.status).toBe('approved');
    expect(approved.retailCharge?.status).toBe('approved');
    const retail = approved.retailCharge;
    if (!retail) throw new Error('missing retail charge');
    retail.amount = 1;
    await expect(retail.save()).rejects.toThrow();
  });

  it('charges each leg in the currency selected for the relationship', async () => {
    await system(() =>
      reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'CAD' },
        retail: { priceBookId: String(retailBook.id), currency: 'EUR' },
      }),
    );
    const event = await recordUsage(CHILD, 3);
    const rating = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
      }),
    );
    expect(rating.charge).toMatchObject({ amount: 9, currency: 'CAD' });
    // 3 * 4.55 = 13.65 minor units, rounded once at the money boundary.
    expect(rating.retailCharge).toMatchObject({ amount: 14, currency: 'EUR' });
    expect(Number.isInteger(rating.retailCharge?.amount)).toBe(true);
  });

  it('prices self-billed and unrelated tenants directly and ignores book rules there', async () => {
    const solo = await recordUsage(SOLO, 2);
    const soloRating = await system(() =>
      commercial.rateUsage({
        usageEventId: String(solo.id),
        billingRelationships: relationships,
      }),
    );
    expect(soloRating).toMatchObject({
      mode: 'direct',
      billingOwnerTenantId: SOLO,
      retailCharge: null,
    });
    expect(soloRating.charge).toMatchObject({
      tenantId: SOLO,
      usageTenantId: SOLO,
      amount: 14,
    });

    // The reseller's own usage never matches its published retail rules.
    const own = await recordUsage(RESELLER, 1);
    await expect(
      system(() =>
        commercial.rateUsage({
          usageEventId: String(own.id),
          billingRelationships: relationships,
        }),
      ),
    ).rejects.toThrow(/No effective pricing rule/);
  });

  it('never double-charges an event when the billing owner changes', async () => {
    const first = await recordUsage(CHILD, 1);
    const firstRating = await system(() =>
      commercial.rateUsage({
        usageEventId: String(first.id),
        billingRelationships: relationships,
      }),
    );
    expect(firstRating.mode).toBe('wholesale');

    await system(() =>
      relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'self',
      }),
    );
    // Frozen at first rating: still the reseller's wholesale charge.
    const rerated = await system(() =>
      commercial.rateUsage({
        usageEventId: String(first.id),
        billingRelationships: relationships,
      }),
    );
    expect(rerated.charge.id).toBe(firstRating.charge.id);
    expect(rerated).toMatchObject({
      mode: 'wholesale',
      billingOwnerTenantId: RESELLER,
    });
    // price() also returns the existing charge rather than a direct one.
    expect(
      (await commercial.price({ usageEventId: String(first.id) })).id,
    ).toBe(firstRating.charge.id);

    const second = await recordUsage(CHILD, 1);
    const direct = await system(() =>
      commercial.rateUsage({
        usageEventId: String(second.id),
        billingRelationships: relationships,
      }),
    );
    expect(direct).toMatchObject({
      mode: 'direct',
      billingOwnerTenantId: CHILD,
      retailCharge: null,
    });

    await system(() =>
      relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'reseller',
      }),
    );
    const back = await system(() =>
      commercial.rateUsage({
        usageEventId: String(second.id),
        billingRelationships: relationships,
      }),
    );
    expect(back).toMatchObject({ mode: 'direct', billingOwnerTenantId: CHILD });

    for (const event of [first, second]) {
      expect(
        await charges.list({ where: { usageEventId: String(event.id) } }),
      ).toHaveLength(1);
    }
    expect(await retailCharges.list({ where: {} })).toHaveLength(1);
  });

  it('rates concurrent requests for one event exactly once', async () => {
    const event = await recordUsage(CHILD, 4);
    const ratings = await system(() =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          commercial.rateUsage({
            usageEventId: String(event.id),
            billingRelationships: relationships,
          }),
        ),
      ),
    );
    expect(new Set(ratings.map((rating) => rating.charge.id)).size).toBe(1);
    expect(await charges.list({ where: {} })).toHaveLength(1);
    expect(await retailCharges.list({ where: {} })).toHaveLength(1);
  });

  it('refuses to rate without a valid assignment under the current reseller', async () => {
    const event = await recordUsage(CHILD, 1);
    await system(() =>
      relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: OTHER_RESELLER,
        billingOwnerMode: 'reseller',
      }),
    );
    await expect(
      system(() =>
        commercial.rateUsage({
          usageEventId: String(event.id),
          billingRelationships: relationships,
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_BOOK_NOT_ASSIGNED' });
    expect(await system(() => reseller.getPriceBookAssignment(CHILD))).toBe(
      null,
    );
    // The old reseller's retail book cannot be assigned under the new one.
    await expect(
      system(() =>
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: {
            priceBookId: String(wholesaleBook.id),
            currency: 'USD',
          },
          retail: { priceBookId: String(retailBook.id), currency: 'USD' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_BOOK_OWNER_MISMATCH' });
    await expect(
      system(() =>
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: { priceBookId: String(retailBook.id), currency: 'USD' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_BOOK_KIND_MISMATCH' });
    // A currency the book has no price in fails at rating time.
    await system(() =>
      reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'JPY' },
      }),
    );
    await expect(
      system(() =>
        commercial.rateUsage({
          usageEventId: String(event.id),
          billingRelationships: relationships,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NO_EFFECTIVE_PRICE' });
    expect(await charges.list({ where: {} })).toHaveLength(0);
  });

  it('ignores a rule filed under a book by a tenant that does not own it', async () => {
    await system(async () => {
      await rules.create({
        tenantId: CHILD,
        priceBookId: String(wholesaleBook.id),
        ruleKey: 'cheap',
        metricKey: 'ai.tokens',
        strategy: 'fixed_unit',
        currency: 'USD',
        priority: 100,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        terms: JSON.stringify({ unitPrice: 0 }),
      });
    });
    const event = await recordUsage(CHILD, 10);
    const rating = await system(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
      }),
    );
    expect(rating.charge.amount).toBe(20);
  });

  it('never lets the reseller or child publish the wholesale book that charges it', async () => {
    const own = await system(() =>
      books.create({
        tenantId: RESELLER,
        bookKey: 'self-wholesale',
        kind: 'wholesale',
      }),
    );
    await expect(
      system(() =>
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: { priceBookId: String(own.id), currency: 'USD' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'PRICE_BOOK_OWNER_MISMATCH' });
  });

  it('requires system context or host authorization for reseller mutations', async () => {
    await expect(
      withTenant({ tenantId: RESELLER }, () =>
        reseller.assignPriceBooks({
          childTenantId: CHILD,
          wholesale: null,
        }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    const authorize = vi.fn(async () => true);
    const authorized = await ResellerBillingService.create({
      db: usage.db,
      billingRelationships: relationships,
      authorize,
    });
    await withTenant({ tenantId: RESELLER }, () =>
      authorized.assignPriceBooks({ childTenantId: CHILD, retail: null }),
    );
    expect(authorize).toHaveBeenCalledWith({
      action: 'assign_retail_price_book',
      tenantId: RESELLER,
      childTenantId: CHILD,
      resellerTenantId: RESELLER,
    });
    // The wholesale leg is authorized by the book's publisher, not the reseller.
    authorize.mockClear();
    await withTenant({ tenantId: RESELLER }, () =>
      authorized.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesaleBook.id), currency: 'CAD' },
      }),
    );
    expect(authorize).toHaveBeenCalledWith({
      action: 'assign_wholesale_price_book',
      tenantId: PROVIDER,
      childTenantId: CHILD,
      resellerTenantId: RESELLER,
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(
      await system(() => reseller.getPriceBookAssignment(CHILD)),
    ).toMatchObject({
      wholesale: { priceBookId: wholesaleBook.id, currency: 'CAD' },
      retail: null,
    });
    // A seller may define prices in its own book under its own context.
    await withTenant({ tenantId: RESELLER }, () =>
      reseller.definePrice({
        priceBookId: String(retailBook.id),
        ruleKey: 'requests',
        metricKey: 'ai.requests',
        strategy: 'flat',
        prices: [{ currency: 'USD', terms: { amount: 1 } }],
      }),
    );
    await expect(
      withTenant({ tenantId: CHILD }, () =>
        reseller.definePrice({
          priceBookId: String(retailBook.id),
          ruleKey: 'requests',
          metricKey: 'ai.requests',
          strategy: 'flat',
          prices: [{ currency: 'USD', terms: { amount: 0 } }],
        }),
      ),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });

  describe('delegated spending policies', () => {
    const rateApproved = async (quantity: number) => {
      const event = await recordUsage(CHILD, quantity);
      return system(() =>
        commercial.rateUsage({
          usageEventId: String(event.id),
          billingRelationships: relationships,
          approved: true,
          at: AT,
        }),
      );
    };

    it('enforces a parent-set retail limit on the child through the evaluator', async () => {
      const policy = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Monthly retail cap',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          limitAmount: 100,
          metricKey: 'ai.tokens',
        }),
      );
      expect(policy).toMatchObject({
        tenantId: CHILD,
        setByTenantId: RESELLER,
        basis: 'retail',
      });
      await rateApproved(10); // 50 retail, 20 wholesale

      const at = new Date();
      const allowed = await evaluator().evaluate({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 50,
        currency: 'USD',
        at,
      });
      expect(allowed).toMatchObject({ allowed: true, projectedAmount: 100 });
      const blocked = await evaluator().evaluate({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 1,
        estimatedAmounts: { retail: 51 },
        currency: 'USD',
        at,
      });
      expect(blocked).toMatchObject({
        allowed: false,
        state: 'blocked',
        projectedAmount: 101,
        matchedPolicyId: policy.id,
      });
    });

    it('enforces a parent-set wholesale limit and counts it in the parent billed spend', async () => {
      await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Wholesale cost cap',
          basis: 'wholesale',
          currency: 'USD',
          behavior: 'warn',
          limitAmount: 30,
        }),
      );
      await rateApproved(10); // 20 wholesale
      const at = new Date();
      expect(
        await evaluator().evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 11,
          currency: 'USD',
          at,
        }),
      ).toMatchObject({ state: 'warned', projectedAmount: 31 });

      // The reseller's own billed policy sees its children's wholesale cost.
      await system(() =>
        policies.create({
          tenantId: RESELLER,
          name: 'Reseller cap',
          period: 'month',
          limitAmount: 25,
          currency: 'USD',
          behavior: 'block',
        }),
      );
      expect(
        await evaluator().evaluate({
          tenantId: RESELLER,
          metricKey: 'ai.tokens',
          estimatedAmount: 6,
          currency: 'USD',
          at,
        }),
      ).toMatchObject({ state: 'blocked', projectedAmount: 26 });
    });

    it('locks delegated policies against the child', async () => {
      const policy = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Cap',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          limitAmount: 100,
        }),
      );
      await withTenant({ tenantId: CHILD }, async () => {
        const mine = await policies.get(String(policy.id));
        if (!mine) throw new Error('missing policy');
        mine.limitAmount = 1_000_000;
        await expect(mine.save()).rejects.toThrow();
        await expect(mine.delete()).rejects.toBeInstanceOf(
          TenantIsolationError,
        );
        await expect(
          policies.create({
            tenantId: CHILD,
            name: 'Forged',
            basis: 'retail',
            currency: 'USD',
            behavior: 'observe',
            setByTenantId: RESELLER,
          }),
        ).rejects.toThrow();
        // An upsert onto the parent's conflict key is refused too.
        await expect(
          policies.create({
            tenantId: CHILD,
            name: 'Cap',
            currency: 'USD',
            behavior: 'observe',
            limitAmount: 1_000_000,
          }),
        ).rejects.toThrow();
      });
      expect((await policies.get(String(policy.id)))?.limitAmount).toBe(100);

      // The parent (its own context) may change it.
      await withTenant({ tenantId: RESELLER }, async () => {
        const row = await policies.get(String(policy.id));
        if (!row) throw new Error('missing policy');
        row.limitAmount = 200;
        await row.save();
      });
      expect((await policies.get(String(policy.id)))?.limitAmount).toBe(200);

      // The parent cannot take over a policy the child set for itself.
      await system(() =>
        policies.create({
          tenantId: CHILD,
          name: 'Own cap',
          currency: 'USD',
          behavior: 'warn',
          limitAmount: 5,
        }),
      );
      await expect(
        system(() =>
          reseller.setDelegatedSpendingPolicy({
            parentTenantId: RESELLER,
            childTenantId: CHILD,
            name: 'Own cap',
            basis: 'retail',
            currency: 'USD',
            behavior: 'block',
            limitAmount: 1,
          }),
        ),
      ).rejects.toMatchObject({ code: 'POLICY_CONFLICT' });
      await expect(
        system(() =>
          reseller.setDelegatedSpendingPolicy({
            parentTenantId: OTHER_RESELLER,
            childTenantId: CHILD,
            name: 'Not mine',
            basis: 'retail',
            currency: 'USD',
            behavior: 'block',
          }),
        ),
      ).rejects.toMatchObject({ code: 'RELATIONSHIP_REQUIRED' });
      await expect(
        system(() =>
          policies.create({
            tenantId: CHILD,
            name: 'Undelegated wholesale',
            basis: 'wholesale',
            currency: 'USD',
          }),
        ),
      ).rejects.toThrow();
    });

    it('blocks on an exhausted prepaid balance and credits grants idempotently', async () => {
      const balance = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Prepaid',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          period: 'balance',
          balanceFrom: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      const grant = () =>
        system(() =>
          reseller.grantChildCredit({
            parentTenantId: RESELLER,
            childTenantId: CHILD,
            spendingPolicyId: String(balance.id),
            amount: 60,
            source: 'order',
            sourceId: 'order-1',
          }),
        );
      const [a, b] = [await grant(), await grant()];
      expect(a.id).toBe(b.id);
      expect(a).toMatchObject({
        tenantId: CHILD,
        amount: 60,
        grantedByTenantId: RESELLER,
      });

      await rateApproved(10); // 50 retail consumed
      const at = new Date();
      expect(
        await evaluator().evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 10,
          currency: 'USD',
          at,
        }),
      ).toMatchObject({
        allowed: true,
        balanceAmount: 10,
        projectedAmount: 60,
      });
      expect(
        await evaluator().evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 11,
          currency: 'USD',
          at,
        }),
      ).toMatchObject({ allowed: false, state: 'blocked', balanceAmount: 10 });

      // Only the parent can fund a delegated balance.
      await expect(
        withTenant({ tenantId: CHILD }, () =>
          evaluator().grantCredit({
            spendingPolicyId: String(balance.id),
            amount: 1000,
          }),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      await expect(
        system(() =>
          reseller.grantChildCredit({
            parentTenantId: RESELLER,
            childTenantId: CHILD,
            spendingPolicyId: String(balance.id),
            amount: 1.5,
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
      await expect(
        system(() =>
          policies.create({
            tenantId: CHILD,
            name: 'Bad balance',
            period: 'balance',
            limitAmount: 10,
            currency: 'USD',
          }),
        ),
      ).rejects.toThrow();
    });

    it("retires a former parent's delegated policy when the child changes reseller", async () => {
      const staleCap = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Cap',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          limitAmount: 60,
        }),
      );
      await rateApproved(10); // 50 retail owed to RESELLER
      await system(async () => {
        await relationships.setRelationship({
          childTenantId: CHILD,
          resellerTenantId: OTHER_RESELLER,
          billingOwnerMode: 'reseller',
        });
      });
      const at = new Date();
      const input = {
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 20,
        currency: 'USD',
        at,
      };
      // Without a relationship reader delegated policies fail closed.
      expect(await evaluator().evaluate(input)).toMatchObject({
        state: 'blocked',
        matchedPolicyId: staleCap.id,
      });
      const aware = new SpendingPolicyEvaluator(
        policies,
        charges,
        adjustments,
        { retailCharges, credits, billingRelationships: relationships },
      );
      expect(await system(() => aware.evaluate(input))).toMatchObject({
        state: 'ok',
        matchedPolicyId: null,
      });
      // The new parent may take over the name; its cap ignores retail owed to
      // the former reseller.
      const replaced = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: OTHER_RESELLER,
          childTenantId: CHILD,
          name: 'Cap',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          limitAmount: 30,
        }),
      );
      expect(replaced.id).toBe(staleCap.id);
      expect(await system(() => aware.evaluate(input))).toMatchObject({
        state: 'ok',
        projectedAmount: 20,
      });
    });

    it("keeps a former parent's balance and its credit out of reach of a new parent", async () => {
      const balance = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Prepaid',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          period: 'balance',
          balanceFrom: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      await system(() =>
        reseller.grantChildCredit({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          spendingPolicyId: String(balance.id),
          amount: 500,
          source: 'order',
          sourceId: 'r1-order',
        }),
      );
      await system(() =>
        relationships.setRelationship({
          childTenantId: CHILD,
          resellerTenantId: OTHER_RESELLER,
          billingOwnerMode: 'reseller',
        }),
      );
      await expect(
        system(() =>
          reseller.setDelegatedSpendingPolicy({
            parentTenantId: OTHER_RESELLER,
            childTenantId: CHILD,
            name: 'Prepaid',
            basis: 'retail',
            currency: 'USD',
            behavior: 'block',
            period: 'balance',
          }),
        ),
      ).rejects.toMatchObject({ code: 'POLICY_CONFLICT' });
      // The former parent's credit stays attributed and reversible.
      const reversal = await system(() =>
        new SpendingPolicyEvaluator(policies, charges, adjustments, {
          retailCharges,
          credits,
        }).grantCredit({
          spendingPolicyId: String(balance.id),
          amount: -500,
          grantedByTenantId: RESELLER,
          source: 'refund',
          sourceId: 'r1-order',
        }),
      );
      expect(reversal).toMatchObject({
        amount: -500,
        grantedByTenantId: RESELLER,
      });
    });

    it('refuses to move a balance policy to another currency or period', async () => {
      await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Prepaid',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          period: 'balance',
        }),
      );
      await expect(
        system(() =>
          reseller.setDelegatedSpendingPolicy({
            parentTenantId: RESELLER,
            childTenantId: CHILD,
            name: 'Prepaid',
            basis: 'retail',
            currency: 'CAD',
            behavior: 'block',
            period: 'balance',
          }),
        ),
      ).rejects.toThrow();
      const [row] = await policies.list({ where: { name: 'Prepaid' } });
      if (!row) throw new Error('missing policy');
      row.period = 'month';
      await expect(system(() => row.save())).rejects.toThrow();
      // An upsert onto the same conflict key cannot change it either.
      await expect(
        system(() =>
          policies.create({
            tenantId: CHILD,
            name: 'Prepaid',
            basis: 'retail',
            currency: 'EUR',
            behavior: 'block',
            period: 'balance',
            setByTenantId: RESELLER,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await policies.list({ where: { name: 'Prepaid' } }))[0],
      ).toMatchObject({ currency: 'USD', period: 'balance' });
    });

    it('guards delegated credit grants at the model', async () => {
      const balance = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Prepaid',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          period: 'balance',
        }),
      );
      await withTenant({ tenantId: CHILD }, async () => {
        await expect(
          credits.create({
            tenantId: CHILD,
            spendingPolicyId: String(balance.id),
            amount: 1000,
            currency: 'USD',
            grantedByTenantId: RESELLER,
          }),
        ).rejects.toThrow();
      });
      await expect(
        system(() =>
          credits.create({
            tenantId: CHILD,
            spendingPolicyId: String(balance.id),
            amount: 1000,
            currency: 'EUR',
            grantedByTenantId: RESELLER,
          }),
        ),
      ).rejects.toThrow();
      expect(await credits.list({ where: {} })).toHaveLength(0);
      const grant = await system(() =>
        reseller.grantChildCredit({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          spendingPolicyId: String(balance.id),
          amount: 10,
        }),
      );
      await expect(system(() => grant.delete())).rejects.toThrow(/append-only/);
      expect(await credits.list({ where: {} })).toHaveLength(1);
    });

    it('rejects credit on a non-balance policy', async () => {
      const capped = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Monthly',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          limitAmount: 10,
        }),
      );
      await expect(
        system(() =>
          reseller.grantChildCredit({
            parentTenantId: RESELLER,
            childTenantId: CHILD,
            spendingPolicyId: String(capped.id),
            amount: 5,
          }),
        ),
      ).rejects.toMatchObject({ code: 'POLICY_NOT_BALANCE' });
    });

    it('calls the auto top-up hook on exhaustion and credits what it returns once', async () => {
      const balance = await system(() =>
        reseller.setDelegatedSpendingPolicy({
          parentTenantId: RESELLER,
          childTenantId: CHILD,
          name: 'Prepaid',
          basis: 'retail',
          currency: 'USD',
          behavior: 'block',
          period: 'balance',
          balanceFrom: new Date('2026-01-01T00:00:00Z'),
        }),
      );
      const hook = vi.fn(async () => ({ amount: 500, sourceId: 'topup-1' }));
      const decision = await system(() =>
        evaluator(hook).evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 40,
          currency: 'USD',
          at: new Date(),
        }),
      );
      expect(hook).toHaveBeenCalledWith({
        policyId: balance.id,
        tenantId: CHILD,
        setByTenantId: RESELLER,
        currency: 'USD',
        balanceAmount: 0,
        estimatedAmount: 40,
        shortfall: 40,
      });
      expect(decision).toMatchObject({ allowed: true, balanceAmount: 500 });
      // The same top-up source id is never credited twice.
      await system(() =>
        evaluator(hook).evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 600,
          currency: 'USD',
          at: new Date(),
        }),
      );
      const grants = await credits.list({
        where: { spendingPolicyId: String(balance.id) },
      });
      expect(grants.map((grant) => grant.amount)).toEqual([500]);

      const declined = await system(() =>
        evaluator(async () => null).evaluate({
          tenantId: CHILD,
          metricKey: 'ai.tokens',
          estimatedAmount: 600,
          currency: 'USD',
          at: new Date(),
        }),
      );
      expect(declined).toMatchObject({ allowed: false, state: 'blocked' });
    });
  });
});
