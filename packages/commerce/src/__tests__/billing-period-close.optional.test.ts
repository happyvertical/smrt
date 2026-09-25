/**
 * PostgreSQL lane for billing-period close (#3060).
 *
 * SQLite cannot catch what matters here: native `uuid` columns receiving the
 * deterministic ids, BIGINT money columns, the lease compare-and-set and the
 * provider-filtered `FOR UPDATE SKIP LOCKED` inbox claim across two real
 * connections, and the event transaction rolling back. Named
 * `*.optional.test.ts` so the package's `test:postgres` script runs it; it
 * skips itself without PostgreSQL.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
  SpendingPolicyEvaluator,
} from '@happyvertical/smrt-subscriptions';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingRuntime } from '../billing/runtime.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentInstrumentCollection } from '../collections/PaymentInstrumentCollection.js';
import { InvoiceStatus, PaymentStatus } from '../types/index.js';
import {
  addNetworkSite,
  at,
  claimedWindows,
  holdFlatClaim,
  invoicesOf,
  overlappingClaims,
  parkNetwork,
  updateSubscription,
} from './helpers/anchor-fixture.js';
import {
  type BillingWorld,
  createBillingWorld,
  currentMonth,
  NETWORK,
  PROVIDER,
  SITE,
  SOLO,
  STRANGER,
} from './helpers/billing-fixture.js';
import {
  checkoutEvent,
  invoiceEvent,
  paymentIntentEvent,
  signedEvent,
} from './helpers/fake-stripe.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const OBJECTS = [
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
  'SubscriptionPlan',
  'TenantSubscription',
  'Account',
  'Journal',
  'JournalEntry',
  'Customer',
  'Invoice',
  'InvoiceLineItem',
  'Payment',
  'PaymentAllocation',
  'PaymentInstrument',
  'BillingAccount',
  'BillingPeriodClose',
  'BillingLineSource',
  'ForgeDelivery',
  'ForgeProjectionCheckpoint',
  'SmrtJob',
];

describePostgres('smrt#3060 billing-period close on PostgreSQL', () => {
  const connections: DatabaseInterface[] = [];
  // This lane commits real rows across connections, so it runs in a database
  // of its own rather than in the package lane's shared one.
  let admin: DatabaseInterface | undefined;
  let baseUrl = '';
  let databaseName = '';

  beforeEach(async () => {
    baseUrl = process.env.DATABASE_URL ?? '';
    admin = await getTestDatabase({
      type: 'postgres',
      url: baseUrl,
      classes: [],
      includeSystemTables: false,
    });
    databaseName = `smrt_billing_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(baseUrl);
    url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
  });

  afterEach(async () => {
    for (const db of connections.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
    process.env.DATABASE_URL = baseUrl;
    await admin?.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
  });

  it('closes, settles, and credits replay-safely across two connections', async () => {
    // Committed writes on real connections: the lease and inbox claims must
    // hold across sessions, which a single rolled-back transaction cannot show.
    const url = String(process.env.DATABASE_URL);
    const firstDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: OBJECTS,
    });
    connections.push(firstDb);
    const secondDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: [],
      includeSystemTables: false,
    });
    connections.push(secondDb);
    const first = { baseDb: firstDb };
    const world = await createBillingWorld(firstDb);
    const peer = await BillingRuntime.create({
      db: secondDb,
      sellerTenantId: PROVIDER,
      kind: 'provider',
      provider: world.provider.provider,
      billingRelationships: world.relationships,
      ledger: world.ledger,
    });
    const period = currentMonth();

    await world.usage(SITE);
    await world.usage(SOLO);
    const [soloCharge] = await withSystemContext(() =>
      world.charges.list({ where: { tenantId: SOLO } }),
    );
    await withSystemContext(() =>
      world.commercial.adjust(String(soloCharge?.id), -10, 'goodwill'),
    );

    // Two workers on two connections close the same period at once.
    const results = await Promise.all([
      world.provider.closePeriod(period),
      peer.closePeriod(period),
    ]);
    const outcomes = results.flatMap((result) =>
      result.groups.map((group) => group.outcome),
    );
    expect(outcomes.filter((outcome) => outcome === 'failed')).toEqual([]);
    await world.provider.closePeriod(period);
    expect(world.stripe.invoices.size).toBe(2);

    const invoices = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db: first.baseDb })).list({
        orderBy: 'invoiceNumber ASC',
      }),
    );
    expect(invoices).toHaveLength(2);
    const byTotal = invoices.map((invoice) => [
      invoice.subtotal,
      invoice.providerTaxAmount,
      invoice.totalAmount,
      invoice.status,
    ]);
    expect(byTotal).toEqual(
      expect.arrayContaining([
        [2520, 328, 2848, InvoiceStatus.SENT],
        [2560, 128, 2688, InvoiceStatus.SENT],
      ]),
    );
    const typed = await first.baseDb.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = '_smrt_billing_line_sources' AND column_name = 'amount'`,
    );
    expect(typed.rows[0]).toMatchObject({ data_type: 'bigint' });

    // A paid event, delivered twice, settles once inside one transaction.
    const network = invoices.find((invoice) => invoice.subtotal === 2520);
    const externalId = String(network?.externalId);
    world.stripe.pay(externalId);
    const paid = invoiceEvent('invoice.paid', externalId);
    for (const runtime of [world.provider, peer]) {
      const { payload, signature } = signedEvent(paid);
      await runtime.acceptWebhook(payload, signature);
    }
    await Promise.all([world.provider.processEvents(), peer.processEvents()]);
    const settled = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db: first.baseDb })).get(
        String(network?.id),
      ),
    );
    expect(settled?.status).toBe(InvoiceStatus.PAID);
    const payments = await withTenant({ tenantId: PROVIDER }, async () =>
      (await PaymentCollection.create({ db: first.baseDb })).list({}),
    );
    expect(payments).toHaveLength(1);
    expect(payments[0]?.status).toBe(PaymentStatus.COMPLETED);

    // A prepaid credit purchase credits the balance once.
    const policy = await withSystemContext(async () =>
      (await SpendingPolicyCollection.create({ db: first.baseDb })).create({
        tenantId: SOLO,
        name: 'credit',
        period: 'balance',
        currency: 'USD',
        behavior: 'block',
      }),
    );
    const checkout = await withTenant({ tenantId: SOLO }, () =>
      world.provider.createCreditCheckout({
        spendingPolicyId: String(policy.id),
        amount: 5000,
        successUrl: 'https://a.test',
        cancelUrl: 'https://a.test',
        purchaseId: 'pg-cart',
      }),
    );
    const session = world.stripe.completeSession(checkout.sessionId, {
      address: { country: 'US' },
    });
    for (const event of [
      checkoutEvent(session),
      checkoutEvent(
        session,
        'paid',
        'checkout.session.async_payment_succeeded',
      ),
    ]) {
      const { payload, signature } = signedEvent(event);
      await world.provider.acceptWebhook(payload, signature);
    }
    await Promise.all([world.provider.processEvents(), peer.processEvents()]);
    const grants = await withSystemContext(async () =>
      (await CreditGrantCollection.create({ db: first.baseDb })).list({
        where: { tenantId: SOLO },
      }),
    );
    expect(grants.map((grant) => grant.amount)).toEqual([5000]);
    expect((await world.provider.getAccount(NETWORK))?.standing).toBe(
      'current',
    );
  });

  /** A world on one connection and a peer runtime on a second. */
  async function twoWorkers(): Promise<{
    world: BillingWorld;
    peer: BillingRuntime;
  }> {
    const url = String(process.env.DATABASE_URL);
    const firstDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: OBJECTS,
    });
    connections.push(firstDb);
    const secondDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: [],
      includeSystemTables: false,
    });
    connections.push(secondDb);
    const world = await createBillingWorld(firstDb);
    const peer = await BillingRuntime.create({
      db: secondDb,
      sellerTenantId: PROVIDER,
      kind: 'provider',
      provider: world.provider.provider,
      billingRelationships: world.relationships,
      ledger: world.ledger,
    });
    // Sync provider customers up front so racing workers never write the
    // accounts themselves.
    for (const payer of [NETWORK, SOLO]) {
      const account = await world.provider.getAccount(payer);
      if (account) await world.provider.ensureProviderCustomer(account);
    }
    return { world, peer };
  }

  it('closes payers on different anchors and a calendar-to-anchor transition concurrently, once (#3116)', async () => {
    const { world, peer } = await twoWorkers();
    const networkAnchor = at('2030-03-23T09:30:00Z');
    await withSystemContext(async () => {
      await world.provider.upsertAccount({
        payerTenantId: NETWORK,
        name: 'Network Co',
        billingAnchorAt: networkAnchor,
        prorateFlatPlans: true,
      });
    });
    await updateSubscription(world, SITE, { startedAt: networkAnchor });
    const added = await addNetworkSite(
      world,
      STRANGER,
      at('2030-04-08T00:00:00Z'),
    );
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-01-01T00:00:00Z'),
    });
    const race = async (now: Date) => {
      const results = await Promise.all([
        world.provider.closePeriod({ now }),
        peer.closePeriod({ now }),
        peer.closePeriod({ now }),
      ]);
      expect(
        results.flatMap((result) =>
          result.groups.filter((group) => group.outcome === 'failed'),
        ),
      ).toEqual([]);
    };

    // SOLO is billed February on calendar months, then moves to an anchor.
    await race(at('2030-03-02T00:00:00Z'));
    await withSystemContext(() =>
      peer.upsertAccount({
        payerTenantId: SOLO,
        name: 'Solo LLC',
        billingAnchorAt: at('2030-03-20T00:00:00Z'),
      }),
    );
    for (const day of [
      '2030-03-21T00:00:00Z',
      '2030-04-21T00:00:00Z',
      '2030-04-24T00:00:00Z',
      '2030-04-25T00:00:00Z',
    ]) {
      await race(at(day));
    }
    // Retry any close a racing worker found busy.
    await world.provider.closePeriod({ now: at('2030-04-25T00:00:00Z') });

    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-02-01T00:00:00.000Z', '2030-03-01T00:00:00.000Z', 2500],
      ['2030-03-01T00:00:00.000Z', '2030-03-20T00:00:00.000Z', 1532],
      ['2030-03-20T00:00:00.000Z', '2030-04-20T00:00:00.000Z', 2500],
    ]);
    expect(await claimedWindows(world, String(added.id))).toEqual([
      ['2030-04-08T00:00:00.000Z', '2030-04-23T09:30:00.000Z', 1242],
    ]);
    expect(await overlappingClaims(world)).toEqual([]);
    expect((await invoicesOf(world, SOLO)).map((i) => i.subtotal)).toEqual([
      2500, 1532, 2500,
    ]);
    expect((await invoicesOf(world, NETWORK)).map((i) => i.subtotal)).toEqual([
      2500 + 1242,
    ]);
    expect(world.stripe.invoices.size).toBe(4);
  });

  it('serializes flat-plan claims across connections when a schedule changes mid-close (#3116)', async () => {
    const { world, peer } = await twoWorkers();
    await parkNetwork(world);
    await withSystemContext(() =>
      world.provider.upsertAccount({
        payerTenantId: SOLO,
        name: 'Solo LLC',
        billingAnchorAt: at('2030-02-15T00:00:00Z'),
      }),
    );
    const solo = await updateSubscription(world, SOLO, {
      startedAt: at('2030-01-01T00:00:00Z'),
    });
    const now = at('2030-03-16T00:00:00Z');
    const hold = holdFlatClaim(world.provider, `subscription|${solo.id}`);
    try {
      const stale = world.provider.closePeriod({ now });
      await hold.reached;
      await withSystemContext(() =>
        peer.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          billingAnchorAt: null,
        }),
      );
      await peer.closePeriod({ now });
      hold.release();
      await stale;
    } finally {
      hold.restore();
    }
    expect(await claimedWindows(world, String(solo.id))).toEqual([
      ['2030-02-01T00:00:00.000Z', '2030-03-01T00:00:00.000Z', 2500],
      ['2030-03-01T00:00:00.000Z', '2030-03-15T00:00:00.000Z', 1250],
    ]);
    const typed = await world.db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE (table_name = '_smrt_billing_accounts'
               AND column_name IN ('billing_anchor_at', 'prorate_flat_plans'))
           OR (table_name = '_smrt_billing_line_sources'
               AND column_name = 'chain_sequence')
        ORDER BY column_name`,
    );
    expect(typed.rows.map((row) => row.data_type)).toEqual([
      'timestamp with time zone',
      'bigint',
      'boolean',
    ]);
    const index = await world.db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = '_smrt_billing_line_sources_line_key_chain_sequence_idx'`,
    );
    expect(String(index.rows[0]?.indexdef)).toContain(
      '(line_key, chain_sequence)',
    );
  });

  it('accepts and applies a verified webhook under strict tenancy (#3100)', async () => {
    const db = await getTestDatabase({
      type: 'postgres',
      url: String(process.env.DATABASE_URL),
      classes: OBJECTS,
    });
    connections.push(db);
    const world = await createBillingWorld(db);
    const period = currentMonth();
    await world.usage(SOLO);
    await world.provider.closePeriod(period);
    const [invoice] = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db })).list({}),
    );
    world.stripe.pay(String(invoice?.externalId));
    const { payload, signature } = signedEvent(
      invoiceEvent('invoice.paid', String(invoice?.externalId)),
    );

    // The production host setting: the interceptor refuses unflagged raw SQL
    // on tenant-scoped classes.
    enableTenancy({ rawQueryPolicy: 'throw' });
    try {
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(true);
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(false);
      expect(await world.provider.processEvents()).toBe(1);
    } finally {
      disableTenancy();
    }
    const settled = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db })).get(String(invoice?.id)),
    );
    expect(settled?.status).toBe(InvoiceStatus.PAID);
  });
  it('tops up a balance exactly once across connections (#3139)', async () => {
    const { world, peer } = await twoWorkers();
    const firstDb = world.db;
    const secondDb = peer.db;
    const policies = await SpendingPolicyCollection.create({ db: firstDb });
    const policyFor = (tenantId: string) =>
      withSystemContext(() =>
        policies.create({
          tenantId,
          name: 'Prepaid',
          period: 'balance',
          currency: 'USD',
          behavior: 'block',
        }),
      );
    const saveCard = async (payer: string, method: string) => {
      const setup = await withTenant({ tenantId: payer }, () =>
        world.provider.createCardSetupCheckout({
          payerTenantId: payer,
          currency: 'USD',
          setupId: method,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      const session = world.stripe.completeSession(setup.sessionId, {
        paymentMethod: method,
      });
      const { payload, signature } = signedEvent(checkoutEvent(session));
      await world.provider.acceptWebhook(payload, signature);
      await world.provider.processEvents();
    };
    const evaluators = async (recheckAfterMs?: number) => [
      await SpendingPolicyEvaluator.create({
        db: firstDb,
        autoTopUp: world.provider.autoTopUpHook({ recheckAfterMs }),
      }),
      await SpendingPolicyEvaluator.create({
        db: secondDb,
        autoTopUp: peer.autoTopUpHook({ recheckAfterMs }),
      }),
    ];
    const spend = (
      evaluator: SpendingPolicyEvaluator,
      tenantId: string,
      estimatedAmount: number,
    ) =>
      withSystemContext(() =>
        evaluator.evaluate({
          tenantId,
          metricKey: 'ai.tokens',
          estimatedAmount,
          currency: 'USD',
        }),
      );
    const topUpJournals = async (paymentId: string) =>
      withTenant({ tenantId: PROVIDER }, async () =>
        (await JournalCollection.create({ db: firstDb })).list({
          where: { sourceRef: paymentId, status: 'posted' },
        }),
      );
    const grantsOf = (tenantId: string) =>
      withSystemContext(async () =>
        (await CreditGrantCollection.create({ db: firstDb })).list({
          where: { tenantId },
        }),
      );

    // Untaxed payers: taxed accounts are not topped up by default.
    await withSystemContext(async () => {
      await world.provider.upsertAccount({
        payerTenantId: SOLO,
        name: 'Solo LLC',
        automaticTax: false,
      });
      await world.provider.upsertAccount({
        payerTenantId: NETWORK,
        name: 'Network Co',
        automaticTax: false,
      });
    });
    // Racing evaluations on two connections charge the card once.
    await policyFor(SOLO);
    await saveCard(SOLO, 'pm_pg_solo');
    const [one, two] = await evaluators();
    if (!one || !two) throw new Error('missing evaluators');
    await Promise.all([
      spend(one, SOLO, 600),
      spend(two, SOLO, 600),
      spend(one, SOLO, 600),
      spend(two, SOLO, 600),
    ]);
    expect(world.stripe.paymentIntents.size).toBe(1);
    expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([600]);
    const soloAttempts = (
      await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentCollection.create({ db: firstDb })).list({}),
      )
    ).filter((row) => row.reference.startsWith('auto-top-up:'));
    const [soloAttempt] = soloAttempts.filter(
      (row) => row.status === PaymentStatus.COMPLETED,
    );
    expect(soloAttempts).toHaveLength(1);
    expect(await topUpJournals(String(soloAttempt?.id))).toHaveLength(1);
    const instruments = await PaymentInstrumentCollection.create({
      db: firstDb,
    });
    const typed = await firstDb.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = ? AND column_name = 'id'`,
      instruments.tableName,
    );
    expect(typed.rows[0]).toMatchObject({ data_type: 'uuid' });

    // A processing charge settled at once by a re-drive on one connection
    // and by its webhook on the other is credited and booked once.
    await policyFor(NETWORK);
    await saveCard(NETWORK, 'pm_pg_bank');
    world.stripe.cards.set('pm_pg_bank', 'processing');
    const [first] = await evaluators();
    if (!first) throw new Error('missing evaluator');
    await spend(first, NETWORK, 900);
    expect(await grantsOf(NETWORK)).toEqual([]);
    const intent = [...world.stripe.paymentIntents.values()].find(
      (row) => row.payment_method === 'pm_pg_bank',
    );
    const settled = world.stripe.settlePaymentIntent(
      String(intent?.id),
      'succeeded',
    );
    const { payload, signature } = signedEvent(
      paymentIntentEvent('payment_intent.succeeded', settled),
    );
    await peer.acceptWebhook(payload, signature);
    const [redrive] = await evaluators(0);
    if (!redrive) throw new Error('missing evaluator');
    await Promise.all([spend(redrive, NETWORK, 900), peer.processEvents()]);
    await peer.processEvents(); // a webhook that lost the race retries
    expect((await grantsOf(NETWORK)).map((grant) => grant.amount)).toEqual([
      900,
    ]);
    const bankAttempt = (
      await withTenant({ tenantId: PROVIDER }, async () =>
        (
          await PaymentCollection.create({ db: firstDb })
        ).list({
          where: { externalId: String(intent?.id) },
        }),
      )
    )[0];
    expect(bankAttempt?.status).toBe(PaymentStatus.COMPLETED);
    expect(await topUpJournals(String(bankAttempt?.id))).toHaveLength(1);
    expect(world.stripe.paymentIntents.size).toBe(2);
  });
});
