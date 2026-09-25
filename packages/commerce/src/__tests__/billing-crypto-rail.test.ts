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
import { beforeEach, describe, expect, it } from 'vitest';
import { createCryptoBillingProvider } from '../billing/crypto.js';
import {
  decideAttempt,
  normalizePaymentPolicy,
} from '../billing/payment-attempts.js';
import {
  BillingProviderUnsupportedError,
  BillingWebhookVerificationError,
} from '../billing/provider.js';
import { BillingRuntime } from '../billing/runtime.js';
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
import { invoiceEvent, signedEvent } from './helpers/fake-stripe.js';

const system = <T>(fn: () => Promise<T>) => withSystemContext(fn);
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

async function buyCredit(world: RailWorld, policyId: string, amount = 5000) {
  return withTenant({ tenantId: SOLO }, () =>
    world.runtime.createCreditCheckout({
      spendingPolicyId: policyId,
      amount,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/cancel',
      purchaseId: 'cart-1',
      provider: 'btcpay',
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

    it('enforces the rail minimum', async () => {
      const policy = await balancePolicy(world, SOLO);
      await expect(buyCredit(world, String(policy.id), 50)).rejects.toThrow(
        /at least 100 USD/,
      );
    });
  });

  describe('prepaid credit', () => {
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
      // The excess is refunded first and leaves the credit alone.
      await world.runtime.recordManualRefund({
        paymentId: attempt?.paymentId ?? '',
        fiatAmount: 1000,
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

    it("never records the issuer's paid event as a payment when the invoice was closed out of band", async () => {
      const invoice = await openInvoice();
      await payWithRail(String(invoice.id));
      // The issuer reports paid (out of band) before the rail's settlement
      // is recorded, as when the rail's projection is retried.
      world.outOfBand.push(String(invoice.externalId));
      world.stripe.pay(String(invoice.externalId));
      await deliverStripe(
        world,
        invoiceEvent('invoice.paid', String(invoice.externalId)),
      );
      expect(await sellerPayments(world)).toEqual([]);
      const pending = await world.db.query(
        "SELECT status FROM _smrt_forge_deliveries WHERE status = 'retry'",
      );
      expect(pending.rows).toHaveLength(1);
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
      ).rejects.toThrow(/already has a payment in progress/);
      // Retrying the same purchase returns the same checkout.
      expect((await payWithRail(String(invoice.id))).sessionId).toBeTruthy();
      await expect(
        payWithRail('00000000-0000-4000-8000-0000000000ff'),
      ).rejects.toThrow(/was not found for this payer/);
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
      const first = await world.runtime.recordCryptoConversion(input);
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
