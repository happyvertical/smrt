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
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
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
import { InvoiceStatus, PaymentStatus } from '../types/index.js';
import {
  createBillingWorld,
  currentMonth,
  NETWORK,
  PROVIDER,
  SITE,
  SOLO,
} from './helpers/billing-fixture.js';
import {
  checkoutEvent,
  invoiceEvent,
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
    const session = world.stripe.sessions.get(checkout.sessionId);
    if (!session) throw new Error('missing session');
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
});
