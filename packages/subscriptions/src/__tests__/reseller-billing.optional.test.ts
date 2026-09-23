/**
 * PostgreSQL lane for reseller price books and delegated spending (#3059).
 *
 * SQLite cannot catch the failures that matter here: an empty optional
 * foreign key written as '' into a native `uuid` column (22P02), a money
 * column that silently became DECIMAL, or two concurrent ratings of one usage
 * event both committing. Named `*.optional.test.ts` so the package's
 * `test:postgres` script picks it up; it skips itself without PostgreSQL.
 */

import {
  BillingRelationshipService,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  PricingRuleCollection,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  CreditGrantCollection,
  PriceBookCollection,
  RetailChargeCollection,
} from '../models/reseller.js';
import {
  CommercialUsageService,
  SpendingPolicyEvaluator,
} from '../services/commercial.js';
import { ResellerBillingService } from '../services/reseller.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const PROVIDER = '00000000-0000-4000-8000-00000000000a';
const RESELLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const CHILD = 'cccccccc-3333-4333-8333-cccccccccccc';

describePostgres('smrt#3059 reseller billing on PostgreSQL', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let commercial: CommercialUsageService;
  let relationships: BillingRelationshipService;
  let reseller: ResellerBillingService;
  let sourceCounter = 0;

  const record = (tenantId: string, quantity: number) =>
    commercial.record({
      tenantId,
      metricKey: 'ai.tokens',
      quantity,
      windowStart: new Date('2026-07-01T00:00:00Z'),
      windowEnd: new Date('2026-07-01T00:01:00Z'),
      source: 'ai-run',
      sourceId: `pg-run-${++sourceCounter}`,
    });

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'BillingRelationship',
        'TenantUsageMetric',
        'PricingRule',
        'ClientCharge',
        'BillingAdjustment',
        'SpendingPolicy',
        'PriceBook',
        'PriceBookAssignment',
        'RetailCharge',
        'CreditGrant',
      ],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.db;
    commercial = await CommercialUsageService.create({
      db,
      billingStorage: { adapterType: 'postgres' },
    });
    relationships = await BillingRelationshipService.create({
      db,
      tenantExists: async (id) => [PROVIDER, RESELLER, CHILD].includes(id),
    });
    reseller = await ResellerBillingService.create({
      db,
      billingRelationships: relationships,
    });
    const books = await PriceBookCollection.create({ db });
    await withSystemContext(async () => {
      const wholesale = await books.create({
        tenantId: PROVIDER,
        bookKey: 'wholesale',
        kind: 'wholesale',
      });
      const retail = await books.create({
        tenantId: RESELLER,
        bookKey: 'retail',
        kind: 'retail',
      });
      for (const [book, usd, cad] of [
        [wholesale, 2, 3],
        [retail, 5, 7],
      ] as const) {
        await reseller.definePrice({
          priceBookId: String(book.id),
          ruleKey: 'tokens',
          metricKey: 'ai.tokens',
          strategy: 'fixed_unit',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
          prices: [
            { currency: 'USD', terms: { unitPrice: usd } },
            { currency: 'CAD', terms: { unitPrice: cad } },
          ],
        });
      }
      await (await PricingRuleCollection.create({ db })).create({
        tenantId: CHILD,
        ruleKey: 'direct',
        metricKey: 'ai.tokens',
        strategy: 'fixed_unit',
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        terms: JSON.stringify({ unitPrice: 11 }),
      });
      await relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'reseller',
      });
      await reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: { priceBookId: String(wholesale.id), currency: 'USD' },
        retail: { priceBookId: String(retail.id), currency: 'CAD' },
      });
    });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares new money columns INTEGER and tenant references uuid', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_name IN ('_smrt_retail_charges', '_smrt_credit_grants',
                            '_smrt_client_charges', '_smrt_spending_policies',
                            '_smrt_pricing_rules', '_smrt_price_book_assignments')`,
    );
    const types = Object.fromEntries(
      (
        result.rows as {
          table_name: string;
          column_name: string;
          data_type: string;
        }[]
      ).map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
    );
    for (const column of [
      '_smrt_retail_charges.amount',
      '_smrt_credit_grants.amount',
    ]) {
      expect(types[column], column).toMatch(/integer|bigint/);
    }
    expect(types['_smrt_retail_charges.quantity']).toMatch(
      /double precision|real|numeric/,
    );
    for (const column of [
      '_smrt_client_charges.usage_tenant_id',
      '_smrt_client_charges.price_book_id',
      '_smrt_retail_charges.reseller_tenant_id',
      '_smrt_spending_policies.set_by_tenant_id',
      '_smrt_pricing_rules.price_book_id',
      '_smrt_price_book_assignments.child_tenant_id',
    ]) {
      expect(types[column], column).toBe('uuid');
    }
  });

  it('rates both legs, freezes the rating across an owner change, and rates concurrent calls once', async () => {
    const event = await record(CHILD, 10);
    const ratings = await withSystemContext(() =>
      Promise.all(
        Array.from({ length: 4 }, () =>
          commercial.rateUsage({
            usageEventId: String(event.id),
            billingRelationships: relationships,
            approved: true,
          }),
        ),
      ),
    );
    expect(new Set(ratings.map((rating) => rating.charge.id)).size).toBe(1);
    expect(ratings[0]?.charge).toMatchObject({
      tenantId: RESELLER,
      usageTenantId: CHILD,
      amount: 20,
      currency: 'USD',
    });
    expect(ratings[0]?.retailCharge).toMatchObject({
      tenantId: CHILD,
      amount: 70,
      currency: 'CAD',
    });

    await withSystemContext(() =>
      relationships.setRelationship({
        childTenantId: CHILD,
        resellerTenantId: RESELLER,
        billingOwnerMode: 'self',
      }),
    );
    const rerated = await withSystemContext(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
      }),
    );
    expect(rerated.charge.id).toBe(ratings[0]?.charge.id);

    // A direct charge stores empty optional references as NULL, not ''.
    const next = await record(CHILD, 1);
    const direct = await withSystemContext(() =>
      commercial.rateUsage({
        usageEventId: String(next.id),
        billingRelationships: relationships,
      }),
    );
    expect(direct).toMatchObject({ mode: 'direct', retailCharge: null });
    expect(direct.charge.amount).toBe(11);

    const counts = await db.query(
      'SELECT usage_event_id, COUNT(*)::int AS n FROM _smrt_client_charges GROUP BY usage_event_id',
    );
    expect((counts.rows as { n: number }[]).every((row) => row.n === 1)).toBe(
      true,
    );
    const charges = await ClientChargeCollection.create({ db });
    expect(await charges.list({ where: {} })).toHaveLength(2);
    expect(
      await (await RetailChargeCollection.create({ db })).list({ where: {} }),
    ).toHaveLength(1);
  });

  it('serializes concurrent single-leg assignment updates', async () => {
    const assignment = await withSystemContext(() =>
      reseller.getPriceBookAssignment(CHILD),
    );
    const wholesale = assignment?.wholesale;
    const retail = assignment?.retail;
    if (!wholesale || !retail) throw new Error('missing assignment');
    await withSystemContext(() =>
      reseller.assignPriceBooks({
        childTenantId: CHILD,
        wholesale: null,
        retail: null,
      }),
    );
    await withSystemContext(() =>
      Promise.all([
        reseller.assignPriceBooks({ childTenantId: CHILD, wholesale }),
        reseller.assignPriceBooks({ childTenantId: CHILD, retail }),
      ]),
    );
    expect(
      await withSystemContext(() => reseller.getPriceBookAssignment(CHILD)),
    ).toMatchObject({ wholesale, retail });
  });

  it('enforces a delegated prepaid balance with exact minor units', async () => {
    const policy = await withSystemContext(() =>
      reseller.setDelegatedSpendingPolicy({
        parentTenantId: RESELLER,
        childTenantId: CHILD,
        name: 'Prepaid',
        basis: 'retail',
        currency: 'CAD',
        behavior: 'block',
        period: 'balance',
        balanceFrom: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    await withSystemContext(() =>
      reseller.grantChildCredit({
        parentTenantId: RESELLER,
        childTenantId: CHILD,
        spendingPolicyId: String(policy.id),
        amount: 100,
        source: 'order',
        sourceId: 'o-1',
      }),
    );
    const event = await record(CHILD, 10);
    await withSystemContext(() =>
      commercial.rateUsage({
        usageEventId: String(event.id),
        billingRelationships: relationships,
        approved: true,
      }),
    );
    const evaluator = new SpendingPolicyEvaluator(
      await SpendingPolicyCollection.create({ db }),
      await ClientChargeCollection.create({ db }),
      await BillingAdjustmentCollection.create({ db }),
      {
        retailCharges: await RetailChargeCollection.create({ db }),
        credits: await CreditGrantCollection.create({ db }),
      },
    );
    const at = new Date();
    expect(
      await evaluator.evaluate({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 30,
        currency: 'CAD',
        at,
      }),
    ).toMatchObject({ allowed: true, balanceAmount: 30, projectedAmount: 100 });
    expect(
      await evaluator.evaluate({
        tenantId: CHILD,
        metricKey: 'ai.tokens',
        estimatedAmount: 31,
        currency: 'CAD',
        at,
      }),
    ).toMatchObject({ allowed: false, state: 'blocked' });
  });
});
