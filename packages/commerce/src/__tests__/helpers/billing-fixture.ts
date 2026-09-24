/**
 * A small reseller world for billing-period close tests (#3060), shared by
 * the SQLite suite and the PostgreSQL lane.
 *
 * PROVIDER sells to NETWORK (a reseller that pays for SITE's usage and plan)
 * and to SOLO (billed for itself). NETWORK resells to SITE (retail usage) and
 * to SITE2 (NETWORK's own flat plan).
 */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  CommercialUsageService,
  PriceBookCollection,
  PricingRuleCollection,
  ResellerBillingService,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
  TenantUsageMetricCollection,
} from '@happyvertical/smrt-subscriptions';
import {
  BillingRelationshipService,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  type BillingLedgerAccounts,
  BillingRuntime,
  type PayerStandingChange,
} from '../../billing/runtime.js';
import { createStripeBillingProvider } from '../../billing/stripe.js';
import { FakeStripe, WEBHOOK_SECRET } from './fake-stripe.js';

export const PROVIDER = '00000000-0000-4000-8000-00000000000a';
export const NETWORK = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
export const SITE = 'cccccccc-3333-4333-8333-cccccccccccc';
export const SITE2 = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
export const SOLO = 'dddddddd-4444-4444-8444-dddddddddddd';
export const STRANGER = 'ffffffff-6666-4666-8666-ffffffffffff';

/** The current UTC calendar month, closable by passing `now: periodEnd + 1d`. */
export function currentMonth(): {
  periodStart: Date;
  periodEnd: Date;
  now: Date;
} {
  const today = new Date();
  const periodStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1),
  );
  return {
    periodStart,
    periodEnd,
    now: new Date(periodEnd.getTime() + 86_400_000),
  };
}

export function nextMonth(period: { periodEnd: Date }) {
  const periodStart = period.periodEnd;
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
  );
  return {
    periodStart,
    periodEnd,
    now: new Date(periodEnd.getTime() + 86_400_000),
  };
}

export interface BillingWorld {
  db: DatabaseInterface;
  stripe: FakeStripe;
  provider: BillingRuntime;
  reseller: BillingRuntime;
  commercial: CommercialUsageService;
  relationships: BillingRelationshipService;
  resellerBilling: ResellerBillingService;
  ledger: BillingLedgerAccounts;
  standingChanges: PayerStandingChange[];
  subscriptions: TenantSubscriptionCollection;
  plans: SubscriptionPlanCollection;
  charges: ClientChargeCollection;
  adjustments: BillingAdjustmentCollection;
  /** Record and rate one usage event (10 tokens) for a tenant. */
  usage(tenantId: string, quantity?: number): Promise<void>;
}

let usageCounter = 0;

export async function createBillingWorld(
  db: DatabaseInterface,
): Promise<BillingWorld> {
  const options = { db };
  const usageMetrics = await TenantUsageMetricCollection.create(options);
  const rules = await PricingRuleCollection.create(options);
  const charges = await ClientChargeCollection.create(options);
  const adjustments = await BillingAdjustmentCollection.create(options);
  const books = await PriceBookCollection.create(options);
  const plans = await SubscriptionPlanCollection.create(options);
  const subscriptions = await TenantSubscriptionCollection.create(options);
  const commercial = new CommercialUsageService(
    usageMetrics,
    rules,
    charges,
    adjustments,
    { adapterType: db.url?.startsWith('postgres') ? 'postgres' : 'sqlite' },
  );
  const known = new Set([PROVIDER, NETWORK, SITE, SITE2, SOLO, STRANGER]);
  const relationships = await BillingRelationshipService.create({
    db,
    tenantExists: async (id) => known.has(id),
  });
  const resellerBilling = await ResellerBillingService.create({
    db,
    billingRelationships: relationships,
  });

  const ledger = await withTenant({ tenantId: PROVIDER }, async () => {
    const accounts = await AccountCollection.create(options);
    const make = async (number: string, name: string, type: string) =>
      String(
        (
          await accounts.create({
            tenantId: PROVIDER,
            number,
            name,
            type: type as 'asset',
          })
        ).id,
      );
    return {
      arAccountId: await make('1200', 'Accounts receivable', 'asset'),
      cashAccountId: await make('1000', 'Stripe clearing', 'asset'),
      revenueAccountId: await make('4000', 'Revenue', 'revenue'),
      taxAccountId: await make('2100', 'Sales tax payable', 'liability'),
      prepaidCreditAccountId: await make('2200', 'Prepaid credit', 'liability'),
    };
  });
  const resellerLedger = await withTenant({ tenantId: NETWORK }, async () => {
    const accounts = await AccountCollection.create(options);
    const make = async (number: string, name: string, type: string) =>
      String(
        (
          await accounts.create({
            tenantId: NETWORK,
            number: `N${number}`,
            name,
            type: type as 'asset',
          })
        ).id,
      );
    return {
      arAccountId: await make('1200', 'AR', 'asset'),
      cashAccountId: await make('1000', 'Cash', 'asset'),
      revenueAccountId: await make('4000', 'Revenue', 'revenue'),
      taxAccountId: await make('2100', 'Tax', 'liability'),
      prepaidCreditAccountId: await make('2200', 'Prepaid', 'liability'),
    };
  });

  await withSystemContext(async () => {
    const wholesale = await books.create({
      tenantId: PROVIDER,
      bookKey: 'wholesale',
      name: 'Wholesale',
      kind: 'wholesale',
    });
    const retail = await books.create({
      tenantId: NETWORK,
      bookKey: 'retail',
      name: 'Retail',
      kind: 'retail',
    });
    const effectiveFrom = new Date('2026-01-01T00:00:00Z');
    await resellerBilling.definePrice({
      priceBookId: String(wholesale.id),
      ruleKey: 'tokens',
      metricKey: 'ai.tokens',
      strategy: 'fixed_unit',
      effectiveFrom,
      prices: [{ currency: 'USD', terms: { unitPrice: 2 } }],
    });
    await resellerBilling.definePrice({
      priceBookId: String(retail.id),
      ruleKey: 'tokens',
      metricKey: 'ai.tokens',
      strategy: 'fixed_unit',
      effectiveFrom,
      prices: [{ currency: 'USD', terms: { unitPrice: 5 } }],
    });
    await rules.create({
      tenantId: SOLO,
      ruleKey: 'direct',
      metricKey: 'ai.tokens',
      strategy: 'fixed_unit',
      effectiveFrom,
      terms: JSON.stringify({ unitPrice: 7 }),
    });
    for (const child of [SITE, SITE2]) {
      await relationships.setRelationship({
        childTenantId: child,
        resellerTenantId: NETWORK,
        billingOwnerMode: child === SITE ? 'reseller' : 'self',
      });
    }
    await resellerBilling.assignPriceBooks({
      childTenantId: SITE,
      wholesale: { priceBookId: String(wholesale.id), currency: 'USD' },
      retail: { priceBookId: String(retail.id), currency: 'USD' },
    });

    const sitePlan = await plans.create({
      planKey: 'site',
      name: 'Site plan',
      priceAmount: 2500,
      currency: 'USD',
      billingInterval: 'month',
    });
    const resellerPlan = await plans.create({
      tenantId: NETWORK,
      planKey: 'network-site',
      name: 'Network site plan',
      priceAmount: 1000,
      currency: 'USD',
      billingInterval: 'month',
    });
    const started = new Date(Date.now() - 60 * 86_400_000);
    for (const [tenantId, planId] of [
      [SITE, sitePlan.id],
      [SOLO, sitePlan.id],
      [SITE2, resellerPlan.id],
    ] as const) {
      await subscriptions.create({
        tenantId,
        planId: String(planId),
        status: 'active',
        startedAt: started,
        externalProvider: 'smrt',
      });
    }
  });

  const stripe = new FakeStripe();
  const sdk = await stripe.provider();
  const billingProvider = createStripeBillingProvider({
    stripe: sdk,
    webhookSecret: WEBHOOK_SECRET,
  });
  const standingChanges: PayerStandingChange[] = [];
  const provider = await BillingRuntime.create({
    db,
    sellerTenantId: PROVIDER,
    kind: 'provider',
    provider: billingProvider,
    billingRelationships: relationships,
    ledger,
    onPayerStanding: (change) => {
      standingChanges.push(change);
    },
  });
  const reseller = await BillingRuntime.create({
    db,
    sellerTenantId: NETWORK,
    kind: 'reseller',
    provider: billingProvider,
    billingRelationships: relationships,
    ledger: resellerLedger,
    invoiceNumberPrefix: 'NET',
  });
  await withSystemContext(async () => {
    await provider.upsertAccount({
      payerTenantId: NETWORK,
      name: 'Network Co',
      email: 'billing@network.test',
      billingAddress: { country: 'CA', postalCode: 'T0L 0A0', state: 'AB' },
    });
    await provider.upsertAccount({
      payerTenantId: SOLO,
      name: 'Solo LLC',
      email: 'ap@solo.test',
      billingAddress: { country: 'US', postalCode: '94107', state: 'CA' },
    });
    await reseller.upsertAccount({
      payerTenantId: SITE,
      name: 'Site',
      billingAddress: { country: 'CA', postalCode: 'T0L 0A0' },
    });
    await reseller.upsertAccount({
      payerTenantId: SITE2,
      name: 'Site Two',
      billingAddress: { country: 'US', postalCode: '10001' },
    });
  });

  return {
    db,
    stripe,
    provider,
    reseller,
    commercial,
    relationships,
    resellerBilling,
    ledger,
    standingChanges,
    subscriptions,
    plans,
    charges,
    adjustments,
    async usage(tenantId: string, quantity = 10) {
      usageCounter += 1;
      await withSystemContext(async () => {
        const event = await commercial.record({
          tenantId,
          metricKey: 'ai.tokens',
          quantity,
          windowStart: new Date(Date.now() - 60_000),
          windowEnd: new Date(),
          source: 'ai-run',
          sourceId: `run-${usageCounter}-${crypto.randomUUID()}`,
        });
        await commercial.rateUsage({
          usageEventId: String(event.id),
          billingRelationships: relationships,
          approved: true,
        });
      });
    },
  };
}
