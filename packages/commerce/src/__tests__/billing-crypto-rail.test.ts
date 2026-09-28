/**
 * Crypto payment rail (#3138): a seller runtime with Stripe issuing invoices
 * and a crypto checkout rail paying them and buying prepaid credit.
 */
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
} from '@happyvertical/smrt-subscriptions';
import {
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBtcPayBillingProvider } from '../billing/btcpay.js';
import { createCryptoBillingProvider } from '../billing/crypto.js';
import {
  decideAttempt,
  normalizePaymentPolicy,
} from '../billing/payment-attempts.js';
import {
  BillingPaymentRefusedError,
  BillingProviderUnsupportedError,
  BillingWebhookVerificationError,
} from '../billing/provider.js';
import { BillingRuntime } from '../billing/runtime.js';
import { createStripeBillingProvider } from '../billing/stripe.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { InvoiceStatus, PaymentMethod, PaymentStatus } from '../types/index.js';
import {
  currentMonth,
  PROVIDER,
  SOLO,
  STRANGER,
} from './helpers/billing-fixture.js';
import {
  createRailWorld,
  FakeCryptoGateway,
  RAIL_SIGNATURE,
  type RailWorld,
} from './helpers/crypto-rail.js';
import {
  invoiceEvent,
  signedEvent,
  WEBHOOK_SECRET,
} from './helpers/fake-stripe.js';

const system = <T>(fn: () => Promise<T>) => withSystemContext(fn);
/** A payer-facing refusal with a stable code (#3185). */
const refused = (code: string) =>
  expect.objectContaining({
    name: 'BillingPaymentRefusedError',
    code,
  });
const memory = async () => {
  const { TenantUsageMetricCollection } = await import(
    '@happyvertical/smrt-subscriptions'
  );
  return (
    await TenantUsageMetricCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    })
  ).db;
};

async function balancePolicy(world: RailWorld, tenantId: string) {
  return system(async () =>
    (await SpendingPolicyCollection.create({ db: world.db })).create({
      tenantId,
      name: 'credit',
      period: 'balance',
      currency: 'USD',
      behavior: 'block',
    }),
  );
}

async function grants(world: RailWorld, tenantId: string) {
  return system(async () =>
    (await CreditGrantCollection.create({ db: world.db })).list({
      where: { tenantId },
    }),
  );
}

async function sellerPayments(world: RailWorld) {
  return withTenant({ tenantId: PROVIDER }, async () =>
    (await PaymentCollection.create({ db: world.db })).list({}),
  );
}

async function buyCredit(
  world: RailWorld,
  policyId: string,
  amount = 5000,
  purchaseId = 'cart-1',
) {
  return withTenant({ tenantId: SOLO }, () =>
    world.runtime.createCreditCheckout({
      spendingPolicyId: policyId,
      amount,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
      purchaseId,
      provider: 'btcpay',
      // The rail cannot charge tax; selling untaxed credit is explicit.
      automaticTax: false,
    }),
  );
}

async function soloInvoice(world: RailWorld) {
  const account = await world.runtime.getAccount(SOLO);
  const [invoice] = await withTenant({ tenantId: PROVIDER }, async () =>
    (await InvoiceCollection.create({ db: world.db })).list({
      where: { customerId: account?.customerId },
    }),
  );
  if (!invoice) throw new Error('no invoice');
  return invoice;
}

async function deliverStripe(world: RailWorld, event: Record<string, unknown>) {
  const { payload, signature } = signedEvent(event);
  await world.runtime.acceptWebhook(payload, signature);
  await world.runtime.processEvents();
}

describe('smrt#3138 crypto payment rail', () => {
  let world: RailWorld;

  beforeEach(async () => {
    world = await createRailWorld(await memory());
  });

  describe('runtime wiring', () => {
    it('keeps a rail out of the issuing seat and names unique', async () => {
      const rail = createCryptoBillingProvider({
        gateway: new FakeCryptoGateway(),
        metadataSecret: 'x',
      });
      const base = {
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider' as const,
        billingRelationships: world.relationships,
        ledger: world.ledger,
      };
      await expect(
        BillingRuntime.create({ ...base, provider: rail }),
      ).rejects.toThrow(/does not issue invoices/);
      await expect(
        BillingRuntime.create({
          ...base,
          provider: world.runtime.provider,
          paymentProviders: [rail, rail],
        }),
      ).rejects.toThrow(/unique/);
      expect(world.runtime.providerFor('btcpay').name).toBe('btcpay');
      expect(world.runtime.providerFor().name).toBe('stripe');
      expect(world.runtime.eventProviders).toEqual([
        `stripe-billing:${PROVIDER}`,
        `btcpay-billing:${PROVIDER}`,
      ]);
      await expect(world.rail.pushInvoice({} as never)).rejects.toBeInstanceOf(
        BillingProviderUnsupportedError,
      );
    });

    it('rejects rail webhooks without a valid signature and ignores foreign events', async () => {
      await expect(
        world.runtime.acceptWebhook('{"id":"e","checkoutId":"x"}', '', {
          provider: 'btcpay',
          headers: { 'x-rail-sig': 'forged' },
        }),
      ).rejects.toBeInstanceOf(BillingWebhookVerificationError);
      const ignored = await world.runtime.acceptWebhook(
        '{"id":"e2","type":"PayoutCreated"}',
        '',
        { provider: 'btcpay', headers: { 'x-rail-sig': RAIL_SIGNATURE } },
      );
      expect(ignored).toMatchObject({ accepted: false, kind: 'ignored' });
    });

    it('refuses a taxed credit purchase or a saved card on the rail', async () => {
      const policy = await balancePolicy(world, SOLO);
      const base = {
        spendingPolicyId: String(policy.id),
        amount: 5000,
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/cancel',
        purchaseId: 'taxed',
        provider: 'btcpay',
      };
      await expect(
        withTenant({ tenantId: SOLO }, () =>
          world.runtime.createCreditCheckout(base),
        ),
      ).rejects.toThrow(/cannot charge tax/);
      await expect(
        withTenant({ tenantId: SOLO }, () =>
          world.runtime.createCreditCheckout({
            ...base,
            automaticTax: false,
            savePaymentMethod: true,
          }),
        ),
      ).rejects.toThrow(/cannot save a card/);
    });

    it('enforces the rail minimum', async () => {
      const policy = await balancePolicy(world, SOLO);
      await expect(buyCredit(world, String(policy.id), 50)).rejects.toThrow(
        /at least 100 USD/,
      );
      await expect(
        buyCredit(world, String(policy.id), 50),
      ).rejects.toBeInstanceOf(BillingPaymentRefusedError);
      await expect(buyCredit(world, String(policy.id), 50)).rejects.toEqual(
        refused('below_minimum'),
      );
    });
  });

  describe('prepaid credit', () => {
    it('refreshes confirming attempts before open ones, oldest first (#3183)', async () => {
      const policy = await balancePolicy(world, SOLO);
      const paid = await buyCredit(world, String(policy.id), 5000, 'cart-paid');
      world.gateway.set(paid.sessionId, 'confirming');
      await world.railEvent(paid.sessionId);
      // Newer open checkouts outnumber the refresh limit.
      await buyCredit(world, String(policy.id), 5000, 'cart-open-1');
      await buyCredit(world, String(policy.id), 5000, 'cart-open-2');
      // The settlement webhook is missed; only the polling fallback sees it.
      world.gateway.set(paid.sessionId, 'settled');

      expect(await world.runtime.refreshPaymentAttempts(1)).toBe(1);
      await world.runtime.processEvents();

      expect(await grants(world, SOLO)).toEqual([
        expect.objectContaining({ amount: 5000, sourceId: paid.sessionId }),
      ]);
    });

    it('filters flagged and unresolved attempts before the limit (#3186)', async () => {
      const policy = await balancePolicy(world, SOLO);
      const sessions = [];
      for (const cart of ['old', 'mid', 'new-1', 'new-2']) {
        sessions.push(await buyCredit(world, String(policy.id), 5000, cart));
      }
      const table = world.runtime.attempts.tableName;
      for (const [index, session] of sessions.entries()) {
        const id = await world.runtime.paymentAttemptId(
          'btcpay',
          session.sessionId,
        );
        await world.db.query(
          `UPDATE ${table} SET created_at = ? WHERE id = ?`,
          new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
          id,
        );
      }
      const idOf = (index: number) =>
        world.runtime.paymentAttemptId(
          'btcpay',
          sessions[index]?.sessionId ?? '',
        );
      // The oldest attempt carries an open flag; the middle one was resolved.
      await world.db.query(
        `UPDATE ${table} SET flag = 'underpaid' WHERE id = ?`,
        await idOf(0),
      );
      await world.db.query(
        `UPDATE ${table} SET flag = 'paid_late' WHERE id = ?`,
        await idOf(1),
      );
      await world.runtime.resolvePaymentAttempt(await idOf(1), 'refunded');

      const ids = (rows: { id?: unknown }[]) => rows.map((row) => row.id);
      // Newer unflagged rows fill the limit, yet the flags are still found.
      expect(
        ids(
          await world.runtime.listPaymentAttempts({ flagged: true, limit: 2 }),
        ),
      ).toEqual([await idOf(1), await idOf(0)]);
      expect(
        ids(
          await world.runtime.listPaymentAttempts({
            unresolved: true,
            limit: 1,
          }),
        ),
      ).toEqual([await idOf(0)]);
      expect(
        ids(
          await world.runtime.listPaymentAttempts({ flagged: false, limit: 5 }),
        ),
      ).toEqual([await idOf(3), await idOf(2)]);
      expect(
        ids(await world.runtime.listPaymentAttempts({ limit: 1 })),
      ).toEqual([await idOf(3)]);
      // Paging reaches every flag, oldest last.
      expect(
        ids(
          await world.runtime.listPaymentAttempts({
            flagged: true,
            limit: 1,
            offset: 1,
          }),
        ),
      ).toEqual([await idOf(0)]);
      await expect(
        world.runtime.listPaymentAttempts({ flagged: false, unresolved: true }),
      ).rejects.toThrow(/always flagged/);
    });

    it('grants once only when the rail settles, recording everything', async () => {
      const policy = await balancePolicy(world, SOLO);
      const session = await buyCredit(world, String(policy.id));
      expect(session.url).toBe(`https://pay.test/${session.sessionId}`);
      // A retry returns the same checkout.
      expect((await buyCredit(world, String(policy.id))).sessionId).toBe(
        session.sessionId,
      );
      const [started] = await world.runtime.listPaymentAttempts({});
      expect(started).toMatchObject({
        purpose: 'credit_purchase',
        provider: 'btcpay',
        status: 'open',
        amount: 5000,
        currency: 'USD',
      });

      // 0-conf: seen but not settled — nothing granted.
      world.gateway.set(session.sessionId, 'confirming');
      await world.railEvent(session.sessionId);
      expect(await grants(world, SOLO)).toEqual([]);

      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      await world.railEvent(session.sessionId); // redelivery
      await world.runtime.refreshPaymentAttempt('btcpay', session.sessionId);
      await world.runtime.processEvents();

      const credited = await grants(world, SOLO);
      expect(credited).toHaveLength(1);
      expect(credited[0]).toMatchObject({
        amount: 5000,
        source: 'btcpay-checkout',
        sourceId: session.sessionId,
      });
      const payments = await sellerPayments(world);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        status: PaymentStatus.COMPLETED,
        amount: 5000,
        currency: 'USD',
        method: PaymentMethod.CRYPTO,
        externalProvider: 'btcpay',
        externalId: session.sessionId,
        backendId: 'btc',
        backendTxRef: 'a'.repeat(64),
        nativeCurrency: 'BTC',
        nativeAmount: 5_000_000,
      });
      expect(payments[0]?.notes).toContain('rate 100000.00 USD/BTC');
      expect(payments[0]?.notes).toContain('source fake-exchange');

      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt).toMatchObject({
        status: 'settled',
        flag: '',
        amountPaid: 5000,
        nativeAmountPaid: 5_000_000,
        rate: '100000.00',
        paymentId: payments[0]?.id,
      });
      expect(attempt?.settledAt).toBeTruthy();
      expect(attempt?.transitions.map((t) => t.status)).toEqual([
        'open',
        'confirming',
        'settled',
      ]);
      expect(attempt?.paymentRecords[0]).toMatchObject({
        rail: 'onchain',
        amount: 5_000_000,
        fee: 141,
        transactionId: 'a'.repeat(64),
      });

      // Held crypto: the cash side lands in the holdings account.
      const entries = await withTenant({ tenantId: PROVIDER }, async () => {
        const journals = await JournalCollection.create({ db: world.db });
        const [journal] = await journals.list({
          where: { sourceRef: String(payments[0]?.id) },
        });
        return journal ? journal.getEntries() : [];
      });
      expect(
        entries.map((entry) => [entry.accountId, entry.debit, entry.credit]),
      ).toEqual(
        expect.arrayContaining([
          [world.railLedger.cryptoHoldingsAccountId, 5000, 0],
          [world.railLedger.prepaidCreditAccountId, 0, 5000],
        ]),
      );
    });

    it('never grants on forged metadata or another seller', async () => {
      const policy = await balancePolicy(world, SOLO);
      const session = await buyCredit(world, String(policy.id));
      const checkout = world.gateway.checkouts.get(session.sessionId);
      if (!checkout) throw new Error('missing');
      checkout.metadata.smrt_amount = '999999';
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      expect(await grants(world, SOLO)).toEqual([]);

      // Unsigned metadata in an asset the rail cannot record: ignored, not
      // a failing delivery.
      checkout.asset = 'LTC';
      await world.railEvent(session.sessionId);
      const failed = await world.db.query(
        "SELECT status FROM _smrt_forge_deliveries WHERE status <> 'completed'",
      );
      expect(failed.rows).toEqual([]);

      // A checkout the rail did not create is acknowledged and ignored.
      checkout.owned = false;
      await world.railEvent(session.sessionId);
      expect(await sellerPayments(world)).toEqual([]);
    });

    it.each([
      [
        'underpaid after expiry',
        'expired',
        { exception: 'underpaid' as const, paid: 4000 },
        'underpaid',
      ],
      [
        'manually marked',
        'settled',
        { exception: 'manually_marked' as const, paid: 0 },
        'manually_marked',
      ],
      [
        'paid late',
        'expired',
        { exception: 'paid_late' as const },
        'paid_late',
      ],
    ])('flags %s without granting', async (_label, status, options, flag) => {
      const policy = await balancePolicy(world, SOLO);
      const session = await buyCredit(world, String(policy.id));
      world.gateway.set(
        session.sessionId,
        status as 'expired' | 'settled',
        options,
      );
      await world.railEvent(session.sessionId);
      expect(await grants(world, SOLO)).toEqual([]);
      const [attempt] = await world.runtime.listPaymentAttempts({
        flagged: true,
      });
      expect(attempt?.flag).toBe(flag);
      const resolved = await world.runtime.resolvePaymentAttempt(
        String(attempt?.id),
        'refunded to payer off-platform',
      );
      expect(resolved.resolvedAt).toBeTruthy();
    });

    it('grants the ordered amount on overpayment and flags the excess', async () => {
      const policy = await balancePolicy(world, SOLO);
      const session = await buyCredit(world, String(policy.id));
      world.gateway.set(session.sessionId, 'settled', {
        exception: 'overpaid',
        paid: 6000,
      });
      await world.railEvent(session.sessionId);
      expect((await grants(world, SOLO)).map((g) => g.amount)).toEqual([5000]);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt).toMatchObject({
        flag: 'overpaid',
        amountPaid: 6000,
        excessAmount: 1000,
      });
      // More money after settlement is booked and refundable too.
      world.gateway.set(session.sessionId, 'settled', {
        exception: 'overpaid',
        paid: 6500,
      });
      await world.railEvent(session.sessionId);
      const [later] = await world.runtime.listPaymentAttempts({});
      expect(later?.excessAmount).toBe(1500);
      // A payment reversed after settlement unbooks its excess and flags it.
      world.gateway.set(session.sessionId, 'settled', {
        exception: 'overpaid',
        paid: 6000,
      });
      await world.railEvent(session.sessionId);
      const [reversed] = await world.runtime.listPaymentAttempts({});
      expect(reversed).toMatchObject({
        excessAmount: 1000,
        flag: 'invalidated_after_settlement',
      });
      // Back up again: each change gets its own journal (no key reuse).
      world.gateway.set(session.sessionId, 'settled', {
        exception: 'overpaid',
        paid: 6500,
      });
      await world.railEvent(session.sessionId);
      const excessJournals = await world.db.query(
        "SELECT source_ref FROM journals WHERE source_ref LIKE 'overpayment:%'",
      );
      expect(excessJournals.rows).toHaveLength(4);
      // Refund basis comes from the settlement, not the (changed) flag.
      const [back] = await world.runtime.listPaymentAttempts({});
      expect(back).toMatchObject({
        excessAmount: 1500,
        settlementOutcome: 'credit',
      });
      // The excess is refunded first and leaves the credit alone.
      await world.runtime.recordManualRefund({
        paymentId: attempt?.paymentId ?? '',
        fiatAmount: 1500,
        reference: 'excess-1',
        reason: 'overpayment',
      });
      expect((await grants(world, SOLO)).map((g) => g.amount)).toEqual([5000]);
    });

    it('records a manual refund once: journal and negative credit', async () => {
      const policy = await balancePolicy(world, SOLO);
      const session = await buyCredit(world, String(policy.id));
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      const [payment] = await sellerPayments(world);
      const refund = {
        paymentId: String(payment?.id),
        fiatAmount: 2000,
        nativeAmount: 2_000_000,
        reference: 'refund-tx-1',
        reason: 'customer request',
      };
      const first = await world.runtime.recordManualRefund(refund);
      const again = await world.runtime.recordManualRefund(refund);
      expect(again.journalId).toBe(first.journalId);
      expect(again.creditGrantId).toBe(first.creditGrantId);
      expect((await grants(world, SOLO)).map((g) => g.amount).sort()).toEqual([
        -2000, 5000,
      ]);
      // The cap is cumulative across references.
      await expect(
        world.runtime.recordManualRefund({
          ...refund,
          reference: 'refund-tx-2',
          fiatAmount: 3001,
        }),
      ).rejects.toThrow(/exceed the 3000 USD still refundable/);
      await world.runtime.recordManualRefund({
        ...refund,
        reference: 'refund-tx-2',
        fiatAmount: 3000,
      });
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt).toMatchObject({
        refundedAmount: 5000,
        refundedPrincipal: 5000,
      });
      expect(attempt?.refundRecords.map((r) => r.reference)).toEqual([
        'refund-tx-1',
        'refund-tx-2',
      ]);
      expect(attempt?.resolution).toContain('original_native');
    });
  });

  describe('paying an issued invoice', () => {
    const period = currentMonth();

    async function openInvoice() {
      await world.usage(SOLO);
      await world.runtime.closePeriod(period);
      return soloInvoice(world);
    }

    async function payWithRail(invoiceId: string, tenant = SOLO) {
      return withTenant({ tenantId: tenant }, () =>
        world.runtime.createInvoicePayment({
          invoiceId,
          provider: 'btcpay',
          purchaseId: 'pay-1',
          successUrl: 'https://app.test/paid',
          cancelUrl: 'https://app.test/cancel',
        }),
      );
    }

    it('settles the invoice, closes it at the issuer, and records one payment', async () => {
      const invoice = await openInvoice();
      await expect(
        payWithRail(String(invoice.id), STRANGER),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      const session = await payWithRail(String(invoice.id));
      const checkout = world.gateway.checkouts.get(session.sessionId);
      expect(checkout?.amount).toBe(invoice.totalAmount);

      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      expect(world.outOfBand).toEqual([invoice.externalId]);
      const paid = await soloInvoice(world);
      expect(paid.status).toBe(InvoiceStatus.PAID);

      // Stripe's own paid event for the out-of-band close records nothing.
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      const payments = await sellerPayments(world);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        method: PaymentMethod.CRYPTO,
        amount: invoice.totalAmount,
        reference: invoice.invoiceNumber,
      });
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      // Nothing is due any more.
      await expect(payWithRail(String(invoice.id))).rejects.toThrow(
        /only sent, unpaid invoices/,
      );
      await expect(payWithRail(String(invoice.id))).rejects.toEqual(
        refused('not_payable'),
      );
      // An applied invoice payment is not refundable here.
      await expect(
        world.runtime.recordManualRefund({
          paymentId: String(payments[0]?.id),
          fiatAmount: 1,
          reference: 'r',
          reason: 'x',
        }),
      ).rejects.toThrow(/exceed the 0 USD/);
    });

    async function latch(checkoutId: string) {
      const id = await world.runtime.paymentAttemptId('btcpay', checkoutId);
      await world.db.query(
        `UPDATE ${world.runtime.attempts.tableName} SET out_of_band_requested_at = ? WHERE id = ?`,
        new Date().toISOString(),
        id,
      );
    }

    it("skips the issuer's paid event for an invoice this rail closed, and records the rail payment once", async () => {
      const invoice = await openInvoice();
      await deliverStripe(
        world,
        invoiceEvent('invoice.overdue', String(invoice.externalId)),
      );
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('past_due');
      const session = await payWithRail(String(invoice.id));
      await latch(session.sessionId);
      world.outOfBand.push(String(invoice.externalId));
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect(await sellerPayments(world)).toEqual([]);
      // Nothing is recorded yet, so the standing waits for the rail.
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('past_due');
      const open = await world.db.query(
        "SELECT status FROM _smrt_forge_deliveries WHERE status <> 'completed'",
      );
      expect(open.rows).toEqual([]);
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      const payments = await sellerPayments(world);
      expect(payments.map((row) => row.method)).toEqual([PaymentMethod.CRYPTO]);
      expect((await soloInvoice(world)).status).toBe(InvoiceStatus.PAID);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
    });

    it('closes a Stripe invoice out of band through the accounting SDK', async () => {
      const invoice = await openInvoice();
      const stripe = createStripeBillingProvider({
        stripe: await world.stripe.provider(),
        webhookSecret: WEBHOOK_SECRET,
      });
      expect(stripe.markInvoicePaidOutOfBand).toBeTypeOf('function');
      await stripe.markInvoicePaidOutOfBand?.(String(invoice.externalId));
      // Idempotent: already closed out of band.
      await stripe.markInvoicePaidOutOfBand?.(String(invoice.externalId));
      expect(await stripe.getInvoice(String(invoice.externalId))).toMatchObject(
        {
          status: 'paid',
          paidOutOfBand: true,
          amountPaid: invoice.totalAmount,
          amountDue: 0,
        },
      );
    });

    async function writeOff(externalId: string) {
      world.stripe.setInvoiceStatus(externalId, 'uncollectible');
      await deliverStripe(
        world,
        invoiceEvent('invoice.marked_uncollectible', externalId),
      );
    }

    it('pays a written-off invoice and reinstates the payer (#3188)', async () => {
      const invoice = await openInvoice();
      await writeOff(String(invoice.externalId));
      expect((await soloInvoice(world)).status).toBe(InvoiceStatus.WRITTEN_OFF);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );

      const session = await payWithRail(String(invoice.id));
      expect(world.gateway.checkouts.get(session.sessionId)?.amount).toBe(
        invoice.totalAmount,
      );
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      expect(world.outOfBand).toEqual([invoice.externalId]);
      // The status stays written off, as after a late card payment.
      const paid = await soloInvoice(world);
      expect(paid.status).toBe(InvoiceStatus.WRITTEN_OFF);
      expect(paid.amountPaid).toBe(invoice.totalAmount);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt?.flag).toBe('');

      // Stripe's paid event for the out-of-band close records nothing more.
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect(await sellerPayments(world)).toHaveLength(1);
      await expect(payWithRail(String(invoice.id))).rejects.toEqual(
        refused('nothing_due'),
      );
    });

    it('keeps rail money as credit when a written-off invoice was paid by card meanwhile (#3188)', async () => {
      const invoice = await openInvoice();
      await writeOff(String(invoice.externalId));
      const session = await payWithRail(String(invoice.id));
      // The payer pays the hosted invoice page by card first.
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt?.flag).toBe('invoice_already_paid');
      expect(world.outOfBand).toEqual([]);
    });

    it('closes a written-off Stripe invoice out of band through the accounting SDK (#3188)', async () => {
      const invoice = await openInvoice();
      world.stripe.setInvoiceStatus(
        String(invoice.externalId),
        'uncollectible',
      );
      const stripe = createStripeBillingProvider({
        stripe: await world.stripe.provider(),
        webhookSecret: WEBHOOK_SECRET,
      });
      await stripe.markInvoicePaidOutOfBand?.(String(invoice.externalId));
      expect(await stripe.getInvoice(String(invoice.externalId))).toMatchObject(
        { status: 'paid', paidOutOfBand: true, amountDue: 0 },
      );
    });

    it('records an out-of-band close made by someone else as an other-method payment', async () => {
      const invoice = await openInvoice();
      world.outOfBand.push(String(invoice.externalId));
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      const payments = await sellerPayments(world);
      expect(payments.map((row) => row.method)).toEqual([PaymentMethod.OTHER]);
    });

    it('records a card payment made while a rail payment confirms, and flags the rail money', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      world.gateway.set(session.sessionId, 'confirming');
      await world.railEvent(session.sessionId);
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect((await soloInvoice(world)).status).toBe(InvoiceStatus.PAID);
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt?.flag).toBe('invoice_already_paid');
      expect(
        (await sellerPayments(world)).map((row) => row.method).sort(),
      ).toEqual([PaymentMethod.CREDIT_CARD, PaymentMethod.CRYPTO].sort());
    });

    it('keeps rail money as credit when the issuer collected first but its event is not applied yet', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      // Stripe collects by card; its webhook has not been applied.
      world.stripe.pay(String(invoice.externalId));
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      expect(world.outOfBand).toEqual([]);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt).toMatchObject({
        flag: 'invoice_already_paid',
        settlementOutcome: 'credit',
      });
      expect((await soloInvoice(world)).status).not.toBe(InvoiceStatus.PAID);
      // The card payment is still recorded when Stripe's event arrives.
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect((await soloInvoice(world)).status).toBe(InvoiceStatus.PAID);
      expect(
        (await sellerPayments(world)).map((row) => row.method).sort(),
      ).toEqual([PaymentMethod.CREDIT_CARD, PaymentMethod.CRYPTO].sort());
    });

    it('flags an issuer close whose payment never settled, and records a later close once resolved', async () => {
      const invoice = await openInvoice();
      await deliverStripe(
        world,
        invoiceEvent('invoice.overdue', String(invoice.externalId)),
      );
      const session = await payWithRail(String(invoice.id));
      await latch(session.sessionId);
      world.gateway.set(session.sessionId, 'expired', { paid: 0 });
      await world.railEvent(session.sessionId);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt?.flag).toBe('out_of_band_without_settlement');
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('past_due');

      // The operator reopens the invoice at the issuer and resolves the
      // flag; a wire then closes it out of band: recorded as OTHER.
      await world.runtime.resolvePaymentAttempt(
        String(attempt?.id),
        'reopened at Stripe',
      );
      world.outOfBand.push(String(invoice.externalId));
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect((await sellerPayments(world)).map((row) => row.method)).toEqual([
        PaymentMethod.OTHER,
      ]);
    });

    it("allows one live rail payment per invoice and hides other payers' invoices", async () => {
      const invoice = await openInvoice();
      await payWithRail(String(invoice.id));
      await expect(
        withTenant({ tenantId: SOLO }, () =>
          world.runtime.createInvoicePayment({
            invoiceId: String(invoice.id),
            provider: 'btcpay',
            purchaseId: 'pay-2',
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
          }),
        ),
      ).rejects.toEqual(refused('payment_in_progress'));
      // Retrying the same purchase returns the same checkout.
      expect((await payWithRail(String(invoice.id))).sessionId).toBeTruthy();
      await expect(
        payWithRail('00000000-0000-4000-8000-0000000000ff'),
      ).rejects.toThrow(/was not found for this payer/);
      await expect(
        payWithRail('00000000-0000-4000-8000-0000000000ff'),
      ).rejects.toEqual(refused('not_found'));
    });

    it('refuses an invoice with nothing due, and bad credit requests, with codes (#3185)', async () => {
      const invoice = await openInvoice();
      // Fully allocated, but its status not yet updated.
      await withTenant({ tenantId: PROVIDER }, async () => {
        const { PaymentAllocationCollection } = await import(
          '../collections/PaymentAllocationCollection.js'
        );
        const payments = await PaymentCollection.create({ db: world.db });
        const payment = await payments.create({
          tenantId: PROVIDER,
          customerId: invoice.customerId,
          amount: invoice.totalAmount,
          currency: invoice.currency,
          method: PaymentMethod.OTHER,
        });
        await (
          await PaymentAllocationCollection.create({ db: world.db })
        ).create({
          tenantId: PROVIDER,
          paymentId: String(payment.id),
          invoiceId: String(invoice.id),
          amount: invoice.totalAmount,
        });
      });
      await expect(payWithRail(String(invoice.id))).rejects.toEqual(
        refused('nothing_due'),
      );

      const policy = await balancePolicy(world, SOLO);
      await expect(buyCredit(world, String(policy.id), 0)).rejects.toEqual(
        refused('invalid_amount'),
      );
      await expect(
        buyCredit(world, '00000000-0000-4000-8000-0000000000fe'),
      ).rejects.toEqual(refused('not_found'));
      // A payer without a billing account.
      const other = await balancePolicy(world, STRANGER);
      await expect(
        withTenant({ tenantId: STRANGER }, () =>
          world.runtime.createCreditCheckout({
            spendingPolicyId: String(other.id),
            amount: 5000,
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
            purchaseId: 'no-account',
            provider: 'btcpay',
            automaticTax: false,
          }),
        ),
      ).rejects.toEqual(refused('no_account'));
      // Not the payer: still a tenant-isolation error, not a refusal.
      await expect(
        withTenant({ tenantId: STRANGER }, () =>
          world.runtime.createCreditCheckout({
            spendingPolicyId: String(policy.id),
            amount: 5000,
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
            purchaseId: 'stranger',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);
    });

    it('reports an invoice lookup failure as a server error, not a refusal (#3185)', async () => {
      const invoice = await openInvoice();
      await expect(payWithRail('not-a-uuid')).rejects.toEqual(
        refused('not_found'),
      );
      const outage = new Error('connection lost');
      const spy = vi
        .spyOn(world.runtime.invoices, 'get')
        .mockRejectedValueOnce(outage);
      try {
        await expect(payWithRail(String(invoice.id))).rejects.toBe(outage);
      } finally {
        spy.mockRestore();
      }
    });

    it('resumes dunning when a confirming payment is refused at settlement', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      world.gateway.set(session.sessionId, 'confirming');
      await world.railEvent(session.sessionId);
      await deliverStripe(
        world,
        invoiceEvent('invoice.overdue', String(invoice.externalId)),
      );
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      world.gateway.set(session.sessionId, 'settled', {
        exception: 'manually_marked',
        paid: 0,
      });
      await world.railEvent(session.sessionId);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('past_due');
    });

    it('re-applies an uncollectible standing paused while a payment confirmed', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      world.gateway.set(session.sessionId, 'confirming');
      await world.railEvent(session.sessionId);
      world.stripe.setInvoiceStatus(String(invoice.externalId), 'open');
      await deliverStripe(
        world,
        invoiceEvent(
          'invoice.marked_uncollectible',
          String(invoice.externalId),
        ),
      );
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      world.gateway.set(session.sessionId, 'expired', { paid: 0 });
      await world.railEvent(session.sessionId);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );
    });

    it('pauses dunning while a payment confirms and resumes it if the payment fails', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      world.gateway.set(session.sessionId, 'confirming');
      await world.railEvent(session.sessionId);

      await deliverStripe(
        world,
        invoiceEvent('invoice.overdue', String(invoice.externalId)),
      );
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('current');
      expect((await soloInvoice(world)).status).toBe(InvoiceStatus.OVERDUE);

      world.gateway.set(session.sessionId, 'invalid');
      await world.railEvent(session.sessionId);
      expect((await world.runtime.getAccount(SOLO))?.standing).toBe('past_due');
      expect(world.outOfBand).toEqual([]);
    });

    it('keeps money for an invoice already paid elsewhere as flagged customer credit', async () => {
      const invoice = await openInvoice();
      const session = await payWithRail(String(invoice.id));
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      world.gateway.set(session.sessionId, 'settled');
      await world.railEvent(session.sessionId);
      const [attempt] = await world.runtime.listPaymentAttempts({});
      expect(attempt?.flag).toBe('invoice_already_paid');
      expect(await sellerPayments(world)).toHaveLength(2);
    });

    it('refuses a rail payment when the issuer cannot close invoices out of band', async () => {
      const plain = await createRailWorld(await memory(), {
        outOfBand: false,
      });
      await plain.usage(SOLO);
      await plain.runtime.closePeriod(period);
      const account = await plain.runtime.getAccount(SOLO);
      const [invoice] = await withTenant({ tenantId: PROVIDER }, async () =>
        (await InvoiceCollection.create({ db: plain.db })).list({
          where: { customerId: account?.customerId },
        }),
      );
      await expect(
        withTenant({ tenantId: SOLO }, () =>
          plain.runtime.createInvoicePayment({
            invoiceId: String(invoice?.id),
            provider: 'btcpay',
            purchaseId: 'p',
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
          }),
        ),
      ).rejects.toThrow(/cannot close an invoice/);
    });
  });

  it('creates BTCPay checkouts that settle after 2 confirmations by default', async () => {
    const created: Record<string, unknown>[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/invoices') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        created.push(body);
        return new Response(
          JSON.stringify({
            id: 'inv_1',
            status: 'New',
            additionalStatus: 'None',
            amount: body.amount,
            currency: body.currency,
            checkoutLink: 'https://btc.example/i/inv_1',
            metadata: body.metadata,
          }),
        );
      }
      if (url.endsWith('/payment-methods')) return new Response('[]');
      return new Response('[]');
    };
    const rail = createBtcPayBillingProvider({
      baseUrl: 'https://btc.example',
      apiKey: 'k',
      storeId: 's',
      webhookSecret: 'w',
      metadataSecret: 'm'.repeat(32),
      fetch,
    });
    await rail.createCheckout({
      idempotencyKey: 'order-1',
      currency: 'CAD',
      amount: 2500,
      description: 'x',
      successUrl: 'https://a.test',
      cancelUrl: 'https://a.test',
      metadata: {},
    });
    expect(created[0]?.checkout).toMatchObject({
      speedPolicy: 'LowMediumSpeed',
    });
  });

  describe('policy', () => {
    const state = {
      checkoutId: 'c',
      status: 'settled' as const,
      exception: 'none' as const,
      amount: 10_000,
      currency: 'USD',
      amountPaid: 9_950,
      metadata: {},
      payments: [],
    };

    it('treats an underpayment within tolerance as paid, and outside it as underpaid', () => {
      const expected = { amount: 10_000, currency: 'USD' };
      expect(decideAttempt(state, normalizePaymentPolicy(), expected)).toEqual({
        action: 'none',
        flag: 'underpaid',
      });
      expect(
        decideAttempt(
          state,
          normalizePaymentPolicy({ underpaymentToleranceBps: 50 }),
          expected,
        ),
      ).toEqual({ action: 'settle', flag: '' });
      expect(
        decideAttempt(
          { ...state, amount: 9_999 },
          normalizePaymentPolicy(),
          expected,
        ),
      ).toEqual({ action: 'none', flag: 'amount_mismatch' });
      expect(
        decideAttempt(
          { ...state, exception: 'manually_marked', amountPaid: 0 },
          normalizePaymentPolicy({ acceptManuallyMarked: true }),
          expected,
        ),
      ).toEqual({ action: 'settle', flag: '' });
    });

    it('validates per-seller options', () => {
      expect(() =>
        normalizePaymentPolicy({ underpaymentToleranceBps: 20_000 }),
      ).toThrow(/0 to 10000/);
      expect(() =>
        normalizePaymentPolicy({ cryptoTreatment: 'convert' }),
      ).toThrow(/conversionHandler/);
      expect(normalizePaymentPolicy()).toMatchObject({
        latePaymentPolicy: 'review',
        acceptManuallyMarked: false,
        cryptoTreatment: 'hold',
        refundBasis: 'original_native',
      });
    });

    it('records a conversion with realized gain once', async () => {
      const input = {
        reference: 'trade-1',
        currency: 'USD',
        nativeCurrency: 'BTC',
        nativeAmount: 5_000_000,
        carryingValue: 5000,
        proceeds: 5200,
        fees: 30,
      };
      const [first, concurrent] = await Promise.all([
        world.runtime.recordCryptoConversion(input),
        world.runtime.recordCryptoConversion(input).catch((error) => error),
      ]);
      if (!(concurrent instanceof Error)) {
        expect(concurrent.journalId).toBe(first.journalId);
      }
      const conversions = await world.db.query(
        "SELECT id FROM journals WHERE source_ref = 'conversion:trade-1'",
      );
      expect(conversions.rows).toHaveLength(1);
      expect(
        (await world.runtime.recordCryptoConversion(input)).journalId,
      ).toBe(first.journalId);
      const entries = await withTenant({ tenantId: PROVIDER }, async () => {
        const journal = await (
          await JournalCollection.create({ db: world.db })
        ).get(first.journalId);
        return journal ? journal.getEntries() : [];
      });
      expect(
        entries.map((entry) => [entry.accountId, entry.debit, entry.credit]),
      ).toEqual(
        expect.arrayContaining([
          [world.ledger.cashAccountId, 5200, 0],
          [world.railLedger.feesAccountId, 30, 0],
          [world.railLedger.cryptoHoldingsAccountId, 0, 5000],
          [world.railLedger.fxGainLossAccountId, 0, 230],
        ]),
      );
    });
  });
});
