/**
 * PostgreSQL lane for the crypto payment rail (#3138): native uuid ids for
 * the deterministic attempt, payment, and allocation rows, JSON timeline and
 * payment columns, BIGINT satoshi amounts, and settlement exactly once across
 * two connections claiming the same inbox. Named `*.optional.test.ts` so the
 * package's `test:postgres` script runs it; it skips itself without
 * PostgreSQL.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
} from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingRuntime } from '../billing/runtime.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { InvoiceStatus, PaymentMethod } from '../types/index.js';
import { currentMonth, PROVIDER, SOLO } from './helpers/billing-fixture.js';
import { createRailWorld } from './helpers/crypto-rail.js';

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
  'BillingPaymentAttempt',
  'ForgeDelivery',
  'ForgeProjectionCheckpoint',
  'SmrtJob',
];

describePostgres('smrt#3138 crypto payment rail on PostgreSQL', () => {
  const connections: DatabaseInterface[] = [];
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
    databaseName = `smrt_rail_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
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

  it('settles credit and an invoice exactly once across two connections', async () => {
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
    const world = await createRailWorld(firstDb);
    const peer = await BillingRuntime.create({
      db: secondDb,
      sellerTenantId: PROVIDER,
      kind: 'provider',
      provider: world.runtime.provider,
      paymentProviders: [world.rail],
      billingRelationships: world.relationships,
      ledger: world.railLedger,
    });

    // Prepaid credit on the rail.
    const policy = await withSystemContext(async () =>
      (await SpendingPolicyCollection.create({ db: firstDb })).create({
        tenantId: SOLO,
        name: 'credit',
        period: 'balance',
        currency: 'USD',
        behavior: 'block',
      }),
    );
    const credit = await withTenant({ tenantId: SOLO }, () =>
      world.runtime.createCreditCheckout({
        spendingPolicyId: String(policy.id),
        amount: 5000,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/cancel',
        purchaseId: 'cart-1',
        provider: 'btcpay',
      }),
    );
    world.gateway.set(credit.sessionId, 'confirming');
    await world.railEvent(credit.sessionId);
    world.gateway.set(credit.sessionId, 'settled');
    // Two deliveries, each worker drains: exactly one grant and payment.
    for (const eventId of ['evt-a', 'evt-b']) {
      await world.runtime.acceptWebhook(
        JSON.stringify({
          id: eventId,
          checkoutId: credit.sessionId,
          type: 'x',
        }),
        '',
        { provider: 'btcpay', headers: { 'x-rail-sig': 'fake-rail-ok' } },
      );
    }
    await Promise.all([world.runtime.processEvents(), peer.processEvents()]);

    const grants = await withSystemContext(async () =>
      (await CreditGrantCollection.create({ db: firstDb })).list({
        where: { tenantId: SOLO },
      }),
    );
    expect(grants.map((grant) => grant.amount)).toEqual([5000]);

    // An issued invoice paid on the rail.
    await world.usage(SOLO);
    await world.runtime.closePeriod(currentMonth());
    const account = await world.runtime.getAccount(SOLO);
    const [invoice] = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db: firstDb })).list({
        where: { customerId: account?.customerId },
      }),
    );
    const payment = await withTenant({ tenantId: SOLO }, () =>
      world.runtime.createInvoicePayment({
        invoiceId: String(invoice?.id),
        provider: 'btcpay',
        purchaseId: 'pay-1',
        successUrl: 'https://app.test/paid',
        cancelUrl: 'https://app.test/cancel',
      }),
    );
    world.gateway.set(payment.sessionId, 'settled');
    await world.railEvent(payment.sessionId);

    const [paid] = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceCollection.create({ db: firstDb })).list({
        where: { id: String(invoice?.id) },
      }),
    );
    expect(paid?.status).toBe(InvoiceStatus.PAID);
    const payments = await withTenant({ tenantId: PROVIDER }, async () =>
      (await PaymentCollection.create({ db: firstDb })).list({}),
    );
    expect(payments).toHaveLength(2);
    expect(payments.every((row) => row.method === PaymentMethod.CRYPTO)).toBe(
      true,
    );
    expect(payments.map((row) => row.nativeAmount).sort()).toEqual(
      [5_000_000, (invoice?.totalAmount ?? 0) * 1000].sort(),
    );

    const attempts = await world.runtime.listPaymentAttempts({});
    expect(attempts).toHaveLength(2);
    const creditAttempt = attempts.find(
      (row) => row.checkoutId === credit.sessionId,
    );
    expect(creditAttempt?.transitions.map((entry) => entry.status)).toEqual([
      'open',
      'confirming',
      'settled',
    ]);
    expect(creditAttempt?.paymentRecords[0]).toMatchObject({
      rail: 'onchain',
      amount: 5_000_000,
    });
  });
});
