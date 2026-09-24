/**
 * Billing-period close, provider events, and prepaid credit (#3060).
 *
 * The provider side runs through the real `@happyvertical/accounting` Stripe
 * provider against an in-memory Stripe double, so the SDK's idempotency and
 * reconciliation behaviour is part of what is tested.
 */

import {
  isBackgroundEligibleMethod,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
  TenantUsageMetricCollection,
} from '@happyvertical/smrt-subscriptions';
import {
  disableTenancy,
  enableTenancy,
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  enqueueBillingEvents,
  enqueueBillingPeriodClose,
  registerBillingRuntime,
  unregisterBillingRuntime,
} from '../billing/jobs.js';
import {
  BillingPeriodCloseError,
  previousCalendarMonth,
} from '../billing/period-close.js';
import { BillingWebhookVerificationError } from '../billing/provider.js';
import { BillingRuntime } from '../billing/runtime.js';
import {
  currencyMinorUnitExponent,
  majorToMinorUnits,
  minorToMajorUnits,
} from '../billing/units.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import * as commerceRoot from '../index.js';
import {
  BillingLineSourceCollection,
  BillingPeriodClose,
  BillingPeriodCloseCollection,
} from '../models/billing.js';
import { InvoiceStatus, PaymentStatus } from '../types/index.js';
import {
  type BillingWorld,
  createBillingWorld,
  currentMonth,
  NETWORK,
  nextMonth,
  PROVIDER,
  SITE,
  SITE2,
  SOLO,
  STRANGER,
} from './helpers/billing-fixture.js';
import {
  checkoutEvent,
  invoiceEvent,
  signedEvent,
  subscriptionEvent,
} from './helpers/fake-stripe.js';

const system = <T>(fn: () => Promise<T>) => withSystemContext(fn);

async function invoiceFor(
  world: BillingWorld,
  seller: string,
  customerOf: string,
) {
  const runtime = seller === PROVIDER ? world.provider : world.reseller;
  const account = await runtime.getAccount(customerOf);
  if (!account) return [];
  return withTenant({ tenantId: seller }, async () => {
    const invoices = await InvoiceCollection.create({ db: world.db });
    return invoices.list({ where: { customerId: account?.customerId } });
  });
}

async function deliver(
  world: BillingWorld,
  event: Record<string, unknown>,
  runtime = world.provider,
) {
  const { payload, signature } = signedEvent(event);
  const accepted = await runtime.acceptWebhook(payload, signature);
  const processed = await runtime.processEvents();
  return { accepted, processed };
}

describe('smrt#3060 billing-period close', () => {
  let world: BillingWorld;
  const period = currentMonth();

  beforeEach(async () => {
    const usage = await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    world = await createBillingWorld(usage.db);
  });

  it('exports every billing manifest model from the package root', () => {
    for (const name of [
      'BillingAccount',
      'BillingPeriodClose',
      'BillingLineSource',
      'BillingRuntime',
      'createStripeBillingProvider',
      'registerBillingRuntime',
    ]) {
      expect(commerceRoot, name).toHaveProperty(name);
    }
    expect('BillingLineSourceCollection' in commerceRoot).toBe(false);
  });

  it('invoices flat and usage lines per billing owner, pushes them with provider tax, and posts revenue', async () => {
    await world.usage(SITE);
    await world.usage(SITE);
    await world.usage(SOLO);
    const soloCharge = (
      await system(() => world.charges.list({ where: { tenantId: SOLO } }))
    )[0];
    await system(() =>
      world.commercial.adjust(String(soloCharge?.id), -10, 'goodwill'),
    );

    const result = await world.provider.closePeriod(period);
    expect(
      result.groups.map((group) => [group.payerTenantId, group.outcome]),
    ).toEqual([
      [NETWORK, 'completed'],
      [SOLO, 'completed'],
    ]);

    // NETWORK pays for SITE: flat plan + wholesale usage on one invoice.
    const [network] = await invoiceFor(world, PROVIDER, NETWORK);
    expect(network).toMatchObject({
      status: InvoiceStatus.SENT,
      currency: 'USD',
      subtotal: 2540,
      providerTaxAmount: 330,
      taxAmount: 330,
      totalAmount: 2870,
      externalProvider: 'stripe',
    });
    const lines = await withTenant({ tenantId: PROVIDER }, async () =>
      (await InvoiceLineItemCollection.create({ db: world.db })).findByInvoice(
        String(network?.id),
      ),
    );
    expect(
      lines
        .map((line) => [line.description.split(' — ')[0], line.amount])
        .sort(),
    ).toEqual([
      [`Site plan for tenant ${SITE}`, 2500],
      [`Usage: ai.tokens for tenant ${SITE}`, 40],
    ]);
    const stripeNetwork = world.stripe.invoices.get(
      String(network?.externalId),
    );
    expect(stripeNetwork).toMatchObject({
      status: 'open',
      subtotal: 2540,
      tax: 330,
      automatic_tax: true,
    });
    expect(stripeNetwork?.metadata.local_id).toBe(network?.id);

    // SOLO: its own plan, usage, and the adjustment.
    const [solo] = await invoiceFor(world, PROVIDER, SOLO);
    expect(solo).toMatchObject({
      subtotal: 2560,
      providerTaxAmount: 128,
      totalAmount: 2688,
    });

    // The provider runtime never bills the reseller's own plan (SITE2).
    expect(await invoiceFor(world, PROVIDER, SITE2)).toEqual([]);

    // Revenue is recognized once: AR = revenue + tax payable.
    const journal = await withTenant({ tenantId: PROVIDER }, async () =>
      (await JournalCollection.create({ db: world.db })).get(
        String(network?.arJournalId),
      ),
    );
    expect(journal?.status).toBe('posted');
    expect(await journal?.getTotalDebits()).toBe(2870);
  });

  it('is idempotent: a re-run bills nothing twice and makes no new provider objects', async () => {
    await world.usage(SOLO);
    const first = await world.provider.closePeriod(period);
    const requests = world.stripe.requests.length;
    const second = await world.provider.closePeriod(period);
    expect(second.groups.map((group) => group.invoiceId)).toEqual(
      first.groups.map((group) => group.invoiceId),
    );
    expect(world.stripe.invoices.size).toBe(2);
    // Completed closes make no provider writes at all.
    expect(
      world.stripe.requests
        .slice(requests)
        .filter((request) => request.method === 'POST'),
    ).toEqual([]);
    expect(await invoiceFor(world, PROVIDER, SOLO)).toHaveLength(1);
  });

  it('resumes after a provider failure without duplicating invoice items or invoices', async () => {
    await world.usage(SITE);
    // NETWORK closes first. Its invoice create succeeds at Stripe but the
    // response is lost.
    world.stripe.fail('POST', /^\/v1\/invoices$/, 'after');
    await expect(world.provider.closePeriod(period)).rejects.toBeInstanceOf(
      BillingPeriodCloseError,
    );
    const closes = await BillingPeriodCloseCollection.create({ db: world.db });
    const [pending] = await closes.list({ where: { payerTenantId: NETWORK } });
    expect(pending?.status).toBe('invoiced');
    expect(pending?.lastError).toContain('injected failure');

    // Sending fails too on the next attempt, before any side effect.
    world.stripe.fail('POST', /\/send$/, 'before');
    await expect(world.provider.closePeriod(period)).rejects.toBeInstanceOf(
      BillingPeriodCloseError,
    );
    await world.provider.closePeriod(period);

    const networkInvoices = [...world.stripe.invoices.values()].filter(
      (invoice) => invoice.metadata.local_id === pending?.invoiceId,
    );
    expect(networkInvoices).toHaveLength(1);
    expect(
      world.stripe.lineItemsOf(String(networkInvoices[0]?.id)),
    ).toHaveLength(2);
    expect(world.stripe.invoiceItems.size).toBe(3); // + SOLO's flat line
    expect(networkInvoices[0]?.sent).toBe(1);
    const [done] = await closes.list({ where: { payerTenantId: NETWORK } });
    expect(done).toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('lets only one of two concurrent closes bill a payer', async () => {
    await world.usage(SOLO);
    const results = await Promise.allSettled([
      world.provider.closePeriod(period),
      world.provider.closePeriod(period),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    await world.provider.closePeriod(period);
    expect(await invoiceFor(world, PROVIDER, SOLO)).toHaveLength(1);
    expect(world.stripe.invoices.size).toBe(2);
    const sources = await BillingLineSourceCollection.create({ db: world.db });
    const claims = await sources.list({});
    expect(new Set(claims.map((row) => row.sourceId)).size).toBe(claims.length);
  });

  it('bills later charges and late adjustments in the next period only', async () => {
    await world.usage(SOLO);
    await world.provider.closePeriod(period);
    const [charge] = await system(() =>
      world.charges.list({ where: { tenantId: SOLO } }),
    );
    await system(() =>
      world.commercial.adjust(String(charge?.id), -5, 'late credit'),
    );
    await world.usage(SOLO);
    const next = nextMonth(period);
    await world.provider.closePeriod(next);
    const invoices = await invoiceFor(world, PROVIDER, SOLO);
    expect(invoices).toHaveLength(2);
    const later = invoices.find((invoice) =>
      invoice.reference.startsWith(
        `billing-period:${next.periodStart.toISOString()}`,
      ),
    );
    // The flat plan again, the new usage (70) and the late adjustment (-5).
    expect(later?.subtotal).toBe(2500 + 70 - 5);
  });

  it('bills a plan for the month it is canceled in, and not after', async () => {
    const [solo] = await system(() =>
      world.subscriptions.list({ where: { tenantId: SOLO } }),
    );
    await system(async () => {
      if (!solo) throw new Error('missing subscription');
      solo.status = 'canceled';
      solo.canceledAt = new Date(period.periodStart.getTime() + 86_400_000);
      await solo.save();
    });
    await world.provider.closePeriod(period);
    const [canceledMonth] = await invoiceFor(world, PROVIDER, SOLO);
    expect(canceledMonth?.subtotal).toBe(2500);
    await world.provider.closePeriod(nextMonth(period));
    expect(await invoiceFor(world, PROVIDER, SOLO)).toHaveLength(1);
  });

  it('carries a net credit forward instead of invoicing it', async () => {
    await world.usage(SOLO);
    const [charge] = await system(() =>
      world.charges.list({ where: { tenantId: SOLO } }),
    );
    await system(() =>
      world.commercial.adjust(String(charge?.id), -3000, 'refund'),
    );
    const result = await world.provider.closePeriod(period);
    expect(
      result.groups.find((group) => group.payerTenantId === SOLO)?.outcome,
    ).toBe('carried_forward');
    expect(await invoiceFor(world, PROVIDER, SOLO)).toEqual([]);
    // A re-run keeps the credit; nothing is re-collected.
    await world.provider.closePeriod(period);
    // The plan is canceled before the next month: the credit must survive
    // the source that offset it becoming ineligible.
    const [solo] = await system(() =>
      world.subscriptions.list({ where: { tenantId: SOLO } }),
    );
    await system(async () => {
      if (!solo) throw new Error('missing subscription');
      solo.status = 'canceled';
      solo.canceledAt = period.periodEnd;
      await solo.save();
    });
    // A month with no activity leaves the credit where it is: no new close.
    const next = nextMonth(period);
    const quiet = await world.provider.closePeriod(next);
    expect(
      quiet.groups.find((group) => group.payerTenantId === SOLO),
    ).toBeUndefined();
    const closes = await BillingPeriodCloseCollection.create({ db: world.db });
    expect(await closes.list({ where: { payerTenantId: SOLO } })).toHaveLength(
      1,
    );
    // The next billed month absorbs it, and the credit is consumed.
    const third = nextMonth(next);
    await world.usage(SOLO, 100);
    await world.provider.closePeriod(third);
    const [invoice] = await invoiceFor(world, PROVIDER, SOLO);
    // 2500 + 70 - 3000 = -430 carried, then 700 of usage.
    expect(invoice?.subtotal).toBe(700 - 430);
    const statuses = (
      await closes.list({ where: { payerTenantId: SOLO } })
    ).map((close) => close.status);
    expect(statuses.sort()).toEqual(['completed', 'completed']);
    // Nothing is carried twice.
    await world.provider.closePeriod(nextMonth(third));
    expect(await invoiceFor(world, PROVIDER, SOLO)).toHaveLength(1);
  });

  it('reports a payer without an account and still closes the others', async () => {
    await world.usage(SOLO);
    await world.usage(SITE);
    const accounts = world.provider.accounts;
    const account = await world.provider.getAccount(NETWORK);
    await accounts.db.query(
      'DELETE FROM _smrt_billing_accounts WHERE id = ?',
      String(account?.id),
    );
    const error = await world.provider
      .closePeriod(period)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BillingPeriodCloseError);
    const groups = (error as BillingPeriodCloseError).result.groups;
    expect(
      groups.find((group) => group.payerTenantId === NETWORK),
    ).toMatchObject({ outcome: 'failed' });
    expect(groups.find((group) => group.payerTenantId === SOLO)?.outcome).toBe(
      'completed',
    );
    // Nothing of NETWORK's was claimed, so it bills once the account exists.
    const closes = await BillingPeriodCloseCollection.create({ db: world.db });
    expect(await closes.list({ where: { payerTenantId: NETWORK } })).toEqual(
      [],
    );
  });

  it('refuses to push an automatic-tax invoice without a tax location', async () => {
    await world.usage(SOLO);
    await system(() =>
      world.provider.upsertAccount({
        payerTenantId: SOLO,
        name: 'Solo LLC',
        billingAddress: {},
      }),
    );
    await expect(world.provider.closePeriod(period)).rejects.toThrow(
      /no tax location/,
    );
    expect(world.stripe.invoices.size).toBe(1); // NETWORK's only
  });

  it('closes a reseller period: retail usage and the reseller plan, billed to children', async () => {
    await world.usage(SITE);
    await world.reseller.closePeriod(period);
    const [site] = await invoiceFor(world, NETWORK, SITE);
    expect(site).toMatchObject({ subtotal: 50, taxAmount: 7, totalAmount: 57 });
    const [site2] = await invoiceFor(world, NETWORK, SITE2);
    expect(site2).toMatchObject({ subtotal: 1000 });
    expect(site?.invoiceNumber).toMatch(/^NET-\d{6}-[0-9A-F]{8}$/);
  });

  it('bills a 100% comp account through the real path as a zero invoice', async () => {
    await system(() =>
      world.provider.upsertAccount({
        payerTenantId: SOLO,
        name: 'Solo LLC',
        flatDiscountBasisPoints: 10_000,
      }),
    );
    await world.provider.closePeriod(period);
    const [solo] = await invoiceFor(world, PROVIDER, SOLO);
    expect(solo).toMatchObject({ subtotal: 0, totalAmount: 0 });
    const items = world.stripe.lineItemsOf(String(solo?.externalId));
    expect(items.map((item) => item.unit_amount)).toEqual([2500, -2500]);
    expect(world.stripe.invoices.get(String(solo?.externalId))?.status).toBe(
      'paid',
    );
    await deliver(
      world,
      invoiceEvent('invoice.paid', String(solo?.externalId)),
    );
    const [paid] = await invoiceFor(world, PROVIDER, SOLO);
    expect(paid?.status).toBe(InvoiceStatus.PAID);
  });

  describe('provider events', () => {
    it('rejects a bad signature and deduplicates deliveries', async () => {
      const foreign = (await (
        await world.stripe.fetch('https://stripe.test/v1/invoices', {
          method: 'POST',
          body: 'customer=cus_elsewhere',
        })
      ).json()) as { id: string };
      const event = invoiceEvent('invoice.paid', foreign.id);
      const { payload } = signedEvent(event);
      await expect(
        world.provider.acceptWebhook(payload, 't=1,v1=00'),
      ).rejects.toBeInstanceOf(BillingWebhookVerificationError);
      const { signature } = signedEvent(event);
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(true);
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(false);
      // A provider invoice this runtime did not issue is acknowledged
      // without effect.
      expect(await world.provider.processEvents()).toBe(1);
      const rows = await world.db.query(
        'SELECT status FROM _smrt_forge_deliveries',
      );
      expect(rows.rows).toEqual([{ status: 'completed' }]);
      const ignored = signedEvent({
        id: 'evt_unhandled',
        type: 'charge.refunded',
        data: { object: { id: 'ch_1' } },
      });
      expect(
        await world.provider.acceptWebhook(ignored.payload, ignored.signature),
      ).toMatchObject({ accepted: false, kind: 'ignored' });
    });

    it('keeps each seller runtime to its own events in a shared inbox', async () => {
      await world.usage(SITE);
      await world.provider.closePeriod(period);
      await world.reseller.closePeriod(period);
      const [site] = await invoiceFor(world, NETWORK, SITE);
      const [network] = await invoiceFor(world, PROVIDER, NETWORK);
      for (const invoice of [site, network]) {
        world.stripe.pay(String(invoice?.externalId));
      }
      const resellerEvent = signedEvent(
        invoiceEvent('invoice.paid', String(site?.externalId)),
      );
      await world.reseller.acceptWebhook(
        resellerEvent.payload,
        resellerEvent.signature,
      );
      const providerEvent = signedEvent(
        invoiceEvent('invoice.paid', String(network?.externalId)),
      );
      await world.provider.acceptWebhook(
        providerEvent.payload,
        providerEvent.signature,
      );
      // The provider polls first and must not consume the reseller's event.
      expect(await world.provider.processEvents()).toBe(1);
      expect((await invoiceFor(world, NETWORK, SITE))[0]?.status).toBe(
        InvoiceStatus.SENT,
      );
      expect(await world.reseller.processEvents()).toBe(1);
      expect((await invoiceFor(world, NETWORK, SITE))[0]?.status).toBe(
        InvoiceStatus.PAID,
      );
      expect((await invoiceFor(world, PROVIDER, NETWORK))[0]?.status).toBe(
        InvoiceStatus.PAID,
      );
    });

    it('ignores a checkout carrying forged credit metadata', async () => {
      const policy = await system(async () =>
        (await SpendingPolicyCollection.create({ db: world.db })).create({
          tenantId: SOLO,
          name: 'credit',
          period: 'balance',
          currency: 'USD',
          behavior: 'block',
        }),
      );
      const account = await world.provider.getAccount(SOLO);
      const forged = signedEvent(
        checkoutEvent({
          id: 'cs_forged',
          currency: 'usd',
          amount_subtotal: 100,
          metadata: {
            smrt_purpose: 'credit_purchase',
            smrt_seller: PROVIDER,
            smrt_payer: SOLO,
            smrt_account: String(account?.id),
            smrt_policy: String(policy.id),
            smrt_granted_by: '',
            smrt_amount: '100',
            smrt_currency: 'USD',
            smrt_sig: 'f'.repeat(64),
          },
        }),
      );
      expect(
        await world.provider.acceptWebhook(forged.payload, forged.signature),
      ).toMatchObject({
        accepted: false,
        kind: 'ignored',
        type: 'checkout.session.completed:unverified_credit_purchase',
      });
    });

    it('acknowledges checkouts it did not create without storing them', async () => {
      const foreign = signedEvent(
        checkoutEvent({
          id: 'cs_foreign',
          currency: 'jpy',
          amount_subtotal: 1200,
          metadata: { order_id: 'o-1', email: 'person@example.test' },
        }),
      );
      expect(
        await world.provider.acceptWebhook(foreign.payload, foreign.signature),
      ).toMatchObject({
        accepted: false,
        kind: 'ignored',
        type: 'checkout.session.completed',
      });
      const malformed = signedEvent({
        id: 'evt_no_invoice',
        type: 'invoice.paid',
        data: { object: {} },
      });
      expect(
        await world.provider.acceptWebhook(
          malformed.payload,
          malformed.signature,
        ),
      ).toMatchObject({ accepted: false, kind: 'ignored' });
      const rows = await world.db.query(
        'SELECT COUNT(*) AS count FROM _smrt_forge_deliveries',
      );
      expect(Number(rows.rows[0]?.count)).toBe(0);
    });

    it('settles a paid invoice once: payment, allocation, cash journal, PAID', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [solo] = await invoiceFor(world, PROVIDER, SOLO);
      world.stripe.pay(String(solo?.externalId));
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(solo?.externalId)),
      );
      // The companion event and a duplicate replay change nothing further.
      await deliver(
        world,
        invoiceEvent('invoice.payment_succeeded', String(solo?.externalId)),
      );
      const [paid] = await invoiceFor(world, PROVIDER, SOLO);
      expect(paid).toMatchObject({
        status: InvoiceStatus.PAID,
        amountPaid: paid?.totalAmount,
      });
      const payments = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentCollection.create({ db: world.db })).list({}),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        status: PaymentStatus.COMPLETED,
        amount: paid?.totalAmount,
        externalId: solo?.externalId,
      });
      expect(payments[0]?.journalId).toBeTruthy();
    });

    it('marks a payer past due on failure, reinstates on payment, and ignores stale failures', async () => {
      await world.usage(SITE);
      await world.provider.closePeriod(period);
      const [network] = await invoiceFor(world, PROVIDER, NETWORK);
      const externalId = String(network?.externalId);

      await deliver(world, invoiceEvent('invoice.payment_failed', externalId));
      expect((await world.provider.getAccount(NETWORK))?.standing).toBe(
        'past_due',
      );
      const siteSubscription = async () =>
        (
          await system(() =>
            world.subscriptions.list({ where: { tenantId: SITE } }),
          )
        )[0];
      expect((await siteSubscription())?.status).toBe('past_due');
      expect(world.standingChanges).toHaveLength(1);
      expect(world.standingChanges[0]).toMatchObject({
        payerTenantId: NETWORK,
        previous: 'current',
        standing: 'past_due',
      });

      // Repeated failure notices do not re-fire the host hook.
      await deliver(world, invoiceEvent('invoice.payment_failed', externalId));
      expect(world.standingChanges).toHaveLength(1);

      world.stripe.pay(externalId);
      await deliver(world, invoiceEvent('invoice.paid', externalId));
      expect((await world.provider.getAccount(NETWORK))?.standing).toBe(
        'current',
      );
      expect((await siteSubscription())?.status).toBe('active');

      // A failure delivered late is resolved against current provider state.
      await deliver(world, invoiceEvent('invoice.payment_failed', externalId));
      expect((await world.provider.getAccount(NETWORK))?.standing).toBe(
        'current',
      );
      expect(world.standingChanges.map((change) => change.standing)).toEqual([
        'past_due',
        'current',
      ]);
    });

    it('rolls the standing change back when the host hook fails, then retries', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [solo] = await invoiceFor(world, PROVIDER, SOLO);
      const failing = await BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: world.provider.provider,
        billingRelationships: world.relationships,
        ledger: world.ledger,
        onPayerStanding: () => {
          throw new Error('suspension service unavailable');
        },
      });
      await deliver(
        world,
        invoiceEvent('invoice.payment_failed', String(solo?.externalId)),
        failing,
      );
      // Nothing the event wrote survived the failed hook.
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');
      const [subscription] = await system(() =>
        world.subscriptions.list({ where: { tenantId: SOLO } }),
      );
      expect(subscription?.status).toBe('active');
      const rows = await world.db.query(
        'SELECT status, last_error FROM _smrt_forge_deliveries',
      );
      expect(rows.rows[0]).toMatchObject({ status: 'retry' });

      await world.db.query(
        "UPDATE _smrt_forge_deliveries SET next_attempt_at = ? WHERE status = 'retry'",
        new Date(0).toISOString(),
      );
      await world.provider.processEvents();
      expect((await world.provider.getAccount(SOLO))?.standing).toBe(
        'past_due',
      );
      expect(world.standingChanges).toHaveLength(1);
    });

    it('marks uncollectible and voided invoices', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [solo] = await invoiceFor(world, PROVIDER, SOLO);
      const externalId = String(solo?.externalId);
      await deliver(
        world,
        invoiceEvent('invoice.marked_uncollectible', externalId),
      );
      expect((await world.provider.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );
      const [soloSubscription] = await system(() =>
        world.subscriptions.list({ where: { tenantId: SOLO } }),
      );
      expect(soloSubscription?.status).toBe('unpaid');
      world.stripe.setInvoiceStatus(externalId, 'void');
      await deliver(world, invoiceEvent('invoice.voided', externalId));
      const [voided] = await invoiceFor(world, PROVIDER, SOLO);
      expect(voided?.status).toBe(InvoiceStatus.CANCELLED);
    });

    it('retries a paid event that arrives before the send is recorded', async () => {
      // NETWORK closes first; reading its pushed invoice back fails once.
      world.stripe.fail('GET', /^\/v1\/invoices\/in_/, 'before', 1);
      await expect(world.provider.closePeriod(period)).rejects.toBeInstanceOf(
        BillingPeriodCloseError,
      );
      const [draft] = await invoiceFor(world, PROVIDER, NETWORK);
      expect(draft?.status).toBe(InvoiceStatus.DRAFT);
      // The customer pays before period close records the send.
      await world.stripe.fetch(
        `https://stripe.test/v1/invoices/${draft?.externalId}/send`,
        { method: 'POST' },
      );
      world.stripe.pay(String(draft?.externalId));
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(draft?.externalId)),
      );
      expect((await invoiceFor(world, PROVIDER, NETWORK))[0]?.status).toBe(
        InvoiceStatus.DRAFT,
      );
      await world.provider.closePeriod(period);
      // The retried delivery settles it once the invoice is sent.
      await world.db.query(
        "UPDATE _smrt_forge_deliveries SET next_attempt_at = ? WHERE status = 'retry'",
        new Date(0).toISOString(),
      );
      await world.provider.processEvents();
      expect((await invoiceFor(world, PROVIDER, NETWORK))[0]?.status).toBe(
        InvoiceStatus.PAID,
      );
    });

    it('syncs provider-managed subscription status', async () => {
      const [solo] = await system(() =>
        world.subscriptions.list({ where: { tenantId: SOLO } }),
      );
      await system(async () => {
        if (!solo) throw new Error('missing');
        solo.externalProvider = 'stripe';
        solo.stripeSubscriptionId = 'sub_123';
        await solo.save();
      });
      world.stripe.subscriptions.set('sub_123', {
        id: 'sub_123',
        status: 'past_due',
        customer: 'cus_x',
        current_period_start: 1_780_000_000,
        current_period_end: 1_782_600_000,
        cancel_at_period_end: true,
      });
      await deliver(
        world,
        subscriptionEvent('customer.subscription.updated', 'sub_123'),
      );
      const [updated] = await system(() =>
        world.subscriptions.list({ where: { tenantId: SOLO } }),
      );
      expect(updated).toMatchObject({
        status: 'past_due',
        cancelAtPeriodEnd: true,
      });
      // A provider-managed subscription is not billed by period close.
      await world.provider.closePeriod(period);
      expect(await invoiceFor(world, PROVIDER, SOLO)).toEqual([]);
    });
  });

  describe('provider events under strict tenancy (#3100)', () => {
    // Production hosts enable the tenancy interceptor with rawQueryPolicy
    // 'throw'. Webhook intake and event processing must work there without
    // any caller-supplied bypass.
    beforeEach(() => {
      enableTenancy({ rawQueryPolicy: 'throw' });
    });
    afterEach(() => {
      disableTenancy();
    });

    it('accepts, deduplicates and settles a paid invoice with the interceptor enforcing', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [solo] = await invoiceFor(world, PROVIDER, SOLO);
      world.stripe.pay(String(solo?.externalId));
      const { payload, signature } = signedEvent(
        invoiceEvent('invoice.paid', String(solo?.externalId)),
      );
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(true);
      expect(
        (await world.provider.acceptWebhook(payload, signature)).accepted,
      ).toBe(false);
      expect(await world.provider.processEvents()).toBe(1);
      expect(await world.provider.processEvents()).toBe(0);

      const [paid] = await invoiceFor(world, PROVIDER, SOLO);
      expect(paid).toMatchObject({
        status: InvoiceStatus.PAID,
        amountPaid: paid?.totalAmount,
      });
      const payments = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentCollection.create({ db: world.db })).list({}),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe(PaymentStatus.COMPLETED);
    });
  });

  describe('prepaid credit purchases', () => {
    async function balancePolicy(tenantId: string, setBy = '') {
      return system(async () => {
        const policies = await SpendingPolicyCollection.create({
          db: world.db,
        });
        return policies.create({
          tenantId,
          name: setBy ? 'delegated credit' : 'credit',
          period: 'balance',
          currency: 'USD',
          behavior: 'block',
          ...(setBy ? { setByTenantId: setBy } : {}),
        });
      });
    }

    async function grants(tenantId: string) {
      return system(async () =>
        (await CreditGrantCollection.create({ db: world.db })).list({
          where: { tenantId },
        }),
      );
    }

    it('credits a balance once when the checkout is paid', async () => {
      const policy = await balancePolicy(SOLO);
      const checkout = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 5000,
          successUrl: 'https://app.test/ok',
          cancelUrl: 'https://app.test/cancel',
          purchaseId: 'cart-1',
        }),
      );
      // The same purchase id returns the same provider session.
      const again = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 5000,
          successUrl: 'https://app.test/ok',
          cancelUrl: 'https://app.test/cancel',
          purchaseId: 'cart-1',
        }),
      );
      expect(again.sessionId).toBe(checkout.sessionId);
      const session = world.stripe.sessions.get(checkout.sessionId);
      if (!session) throw new Error('missing session');

      await deliver(
        world,
        checkoutEvent(
          { ...session, metadata: { ...session.metadata, note: 'not ours' } },
          'unpaid',
        ),
      );
      const stored = await world.db.query(
        'SELECT payload FROM _smrt_forge_deliveries',
      );
      expect(String(stored.rows[0]?.payload)).not.toContain('not ours');
      expect(await grants(SOLO)).toEqual([]);
      await deliver(world, checkoutEvent(session));
      await deliver(
        world,
        checkoutEvent(
          session,
          'paid',
          'checkout.session.async_payment_succeeded',
        ),
      );
      const credited = await grants(SOLO);
      expect(credited).toHaveLength(1);
      expect(credited[0]).toMatchObject({
        amount: 5000,
        source: 'stripe-checkout',
        sourceId: checkout.sessionId,
      });
      const payments = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentCollection.create({ db: world.db })).list({}),
      );
      expect(payments).toHaveLength(1);
      expect(payments[0]?.status).toBe(PaymentStatus.COMPLETED);
    });

    it('lets only the payer buy credit: the parent for a delegated balance', async () => {
      const own = await balancePolicy(SOLO);
      await expect(
        withTenant({ tenantId: STRANGER }, () =>
          world.provider.createCreditCheckout({
            spendingPolicyId: String(own.id),
            amount: 100,
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
            purchaseId: 'x',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);

      const delegated = await balancePolicy(SITE, NETWORK);
      await expect(
        withTenant({ tenantId: SITE }, () =>
          world.provider.createCreditCheckout({
            spendingPolicyId: String(delegated.id),
            amount: 100,
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
            purchaseId: 'x',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      const checkout = await withTenant({ tenantId: NETWORK }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(delegated.id),
          amount: 2000,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
          purchaseId: 'network-topup',
        }),
      );
      const session = world.stripe.sessions.get(checkout.sessionId);
      if (!session) throw new Error('missing session');
      await deliver(world, checkoutEvent(session));
      expect(await grants(SITE)).toMatchObject([
        { amount: 2000, grantedByTenantId: NETWORK },
      ]);
    });

    it('dead-letters a checkout whose collected amount does not match', async () => {
      const policy = await balancePolicy(SOLO);
      const checkout = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 700,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
          purchaseId: 'p',
        }),
      );
      const session = world.stripe.sessions.get(checkout.sessionId);
      if (!session) throw new Error('missing session');
      await deliver(world, checkoutEvent({ ...session, amount_subtotal: 1 }));
      expect(await grants(SOLO)).toEqual([]);
      // A discounted session reports the full subtotal but collects less.
      await deliver(
        world,
        checkoutEvent({ ...session, id: 'cs_discounted', amount_total: 0 }),
      );
      expect(await grants(SOLO)).toEqual([]);
      const rows = await world.db.query(
        'SELECT status, last_error FROM _smrt_forge_deliveries',
      );
      expect(rows.rows[0]).toMatchObject({ status: 'retry' });
      expect(String(rows.rows[0]?.last_error)).toContain('expected 700 USD');
    });

    it('refuses zero-decimal checkout currencies', async () => {
      await expect(
        world.provider.provider.createCheckout({
          idempotencyKey: 'k',
          currency: 'JPY',
          amount: 100,
          description: 'x',
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
          metadata: {},
        }),
      ).rejects.toThrow(/two-decimal/);
    });
  });

  describe('smrt-jobs integration', () => {
    it('runs a queued period close for a registered runtime', async () => {
      // The job has no clock override, so close last month: only the flat
      // plans (started two months ago) are billable in it.
      const lastMonth = previousCalendarMonth();
      registerBillingRuntime('test-provider', world.provider);
      try {
        const job = await enqueueBillingPeriodClose({
          runtime: 'test-provider',
          periodStart: lastMonth.periodStart,
          periodEnd: lastMonth.periodEnd,
        });
        expect(job.method).toBe('runPeriodClose');
        await expect(
          enqueueBillingEvents({ runtime: 'test-provider', limit: 0 }),
        ).rejects.toThrow('limit must be a positive integer');
        expect(
          isBackgroundEligibleMethod(BillingPeriodClose, 'runPeriodClose'),
        ).toBe(true);
        expect(isBackgroundEligibleMethod(BillingPeriodClose, 'save')).toBe(
          false,
        );
        const target = new BillingPeriodClose({ db: world.db });
        await target.initialize();
        const result = (await target.runPeriodClose(job.args)) as {
          groups: unknown[];
        };
        expect(result.groups).toHaveLength(2);
        const jobs = await SmrtJobCollection.create({ db: world.db });
        expect(await jobs.list({})).toHaveLength(1);
      } finally {
        unregisterBillingRuntime('test-provider');
      }
    });
  });

  describe('accounting-provider input', () => {
    it('converts invoice money to the major units the SDK expects', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [solo] = await invoiceFor(world, PROVIDER, SOLO);
      const input = await withTenant({ tenantId: PROVIDER }, async () =>
        solo?.toAccountingInput(),
      );
      expect(input).toMatchObject({
        subtotal: 25.7,
        taxAmount: 1.29,
        totalAmount: 26.99,
        currency: 'USD',
      });
      expect(
        input?.lineItems.map((line) => line.unitPrice).sort((a, b) => a - b),
      ).toEqual([0.7, 25]);
    });
  });

  describe('minor-unit conversion', () => {
    it('converts with the ISO exponent and rejects fractional provider amounts', () => {
      expect(currencyMinorUnitExponent('usd')).toBe(2);
      expect(currencyMinorUnitExponent('JPY')).toBe(0);
      expect(currencyMinorUnitExponent('KWD')).toBe(3);
      expect(minorToMajorUnits(1999, 'USD')).toBe(19.99);
      expect(minorToMajorUnits(1200, 'JPY')).toBe(1200);
      expect(majorToMinorUnits(19.99, 'USD')).toBe(1999);
      expect(majorToMinorUnits(0.29, 'USD')).toBe(29);
      expect(() => majorToMinorUnits(19.995, 'USD')).toThrow(/whole number/);
      expect(() => minorToMajorUnits(1.5, 'USD')).toThrow(/safe integer/);
      expect(() => currencyMinorUnitExponent('usdx')).toThrow();
    });
  });
});
