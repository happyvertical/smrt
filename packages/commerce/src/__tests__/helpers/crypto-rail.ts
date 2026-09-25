/**
 * A crypto payment rail world for #3138: the billing fixture's Stripe
 * issuing provider plus an in-memory `CryptoCheckoutGateway`, wired into one
 * seller runtime. Shared by the SQLite suite and the PostgreSQL lane.
 */
import {
  type CreateCryptoCheckoutInput,
  type CryptoCheckout,
  type CryptoCheckoutException,
  type CryptoCheckoutGateway,
  CryptoCheckoutNotOwnedError,
  type CryptoCheckoutPayment,
  type CryptoCheckoutStatus,
  PaymentVerificationError,
} from '@happyvertical/payments';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { createCryptoBillingProvider } from '../../billing/crypto.js';
import type { BillingPaymentPolicy } from '../../billing/payment-attempts.js';
import type {
  BillingProvider,
  BillingProviderInvoiceState,
} from '../../billing/provider.js';
import {
  type BillingLedgerAccounts,
  BillingRuntime,
} from '../../billing/runtime.js';
import { createStripeBillingProvider } from '../../billing/stripe.js';
import {
  type BillingWorld,
  createBillingWorld,
  PROVIDER,
} from './billing-fixture.js';
import { WEBHOOK_SECRET } from './fake-stripe.js';

export const RAIL_METADATA_SECRET = 'rail-metadata-secret';
export const RAIL_SIGNATURE = 'fake-rail-ok';
const TXID = 'a'.repeat(64);

interface FakeCheckout {
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  status: CryptoCheckoutStatus;
  exception: CryptoCheckoutException;
  amountPaid: number;
  payments: CryptoCheckoutPayment[];
  owned: boolean;
  /** Settlement asset override (default BTC). */
  asset?: string;
}

/** An in-memory gateway: tests move checkouts through their states. */
export class FakeCryptoGateway implements CryptoCheckoutGateway {
  readonly id = 'btcpay';
  readonly checkouts = new Map<string, FakeCheckout>();
  created = 0;
  private counter = 0;

  async createCheckout(
    input: CreateCryptoCheckoutInput,
  ): Promise<CryptoCheckout> {
    const live = [...this.checkouts.values()].find(
      (checkout) =>
        checkout.orderId === input.orderId &&
        ['open', 'confirming', 'settled'].includes(checkout.status),
    );
    if (live) return this.view(live);
    this.counter += 1;
    this.created += 1;
    const checkout: FakeCheckout = {
      id: `chk_${this.counter}`,
      orderId: input.orderId,
      amount: input.amount,
      currency: input.currency,
      metadata: { ...(input.metadata ?? {}) },
      status: 'open',
      exception: 'none',
      amountPaid: 0,
      payments: [],
      owned: true,
    };
    this.checkouts.set(checkout.id, checkout);
    return this.view(checkout);
  }

  async getCheckout(checkoutId: string): Promise<CryptoCheckout> {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) throw new Error(`no checkout ${checkoutId}`);
    if (!checkout.owned) throw new CryptoCheckoutNotOwnedError(checkoutId);
    return this.view(checkout);
  }

  async listCheckouts(input: { orderId: string }): Promise<CryptoCheckout[]> {
    return [...this.checkouts.values()]
      .filter((checkout) => checkout.orderId === input.orderId)
      .map((checkout) => this.view(checkout));
  }

  verifyWebhook(
    rawBody: string,
    headers: Headers | Record<string, string | undefined>,
  ) {
    const signature =
      headers instanceof Headers
        ? headers.get('x-rail-sig')
        : headers['x-rail-sig'];
    if (signature !== RAIL_SIGNATURE) {
      throw new PaymentVerificationError('bad rail signature');
    }
    const body = JSON.parse(rawBody) as {
      id: string;
      checkoutId?: string;
      type: string;
    };
    return {
      eventId: body.id,
      checkoutId: body.checkoutId ?? null,
      type: body.type,
      redelivery: false,
    };
  }

  /** Move a checkout: `paid` is fiat minor units received. */
  set(
    checkoutId: string,
    status: CryptoCheckoutStatus,
    options: {
      exception?: CryptoCheckoutException;
      paid?: number;
      paymentStatus?: CryptoCheckoutPayment['status'];
    } = {},
  ): void {
    const checkout = this.checkouts.get(checkoutId);
    if (!checkout) throw new Error(`no checkout ${checkoutId}`);
    checkout.status = status;
    checkout.exception = options.exception ?? 'none';
    const paid = options.paid ?? (status === 'open' ? 0 : checkout.amount);
    checkout.amountPaid = paid;
    // 1 fiat minor unit = 1,000 sats at the fake rate (100,000.00 per BTC).
    checkout.payments =
      paid > 0
        ? [
            {
              id: `${TXID}-0`,
              asset: 'BTC',
              rail: 'onchain',
              amount: (paid / 100_000).toFixed(8),
              fee: '0.00000141',
              status:
                options.paymentStatus ??
                (status === 'settled' || status === 'expired'
                  ? 'settled'
                  : 'confirming'),
              transactionId: TXID,
              receivedAt: new Date('2026-09-25T12:00:00Z'),
            },
          ]
        : [];
  }

  private view(checkout: FakeCheckout): CryptoCheckout {
    return {
      gateway: this.id,
      id: checkout.id,
      orderId: checkout.orderId,
      status: checkout.status,
      exception: checkout.exception,
      amount: checkout.amount,
      currency: checkout.currency,
      amountPaid: checkout.amountPaid,
      settlementAsset: checkout.asset ?? 'BTC',
      nativeAmountDue: (checkout.amount / 100_000).toFixed(8),
      nativeAmountPaid: (checkout.amountPaid / 100_000).toFixed(8),
      rate: '100000.00',
      rateSource: 'fake-exchange',
      checkoutUrl: `https://pay.test/${checkout.id}`,
      expiresAt: new Date('2099-01-01T00:00:00Z'),
      metadata: { ...checkout.metadata },
      payments: checkout.payments.map((payment) => ({ ...payment })),
      raw: {},
    };
  }
}

export interface RailWorld extends BillingWorld {
  gateway: FakeCryptoGateway;
  rail: BillingProvider;
  runtime: BillingRuntime;
  railLedger: BillingLedgerAccounts;
  /** Provider invoice ids closed as paid out of band. */
  outOfBand: string[];
  /** Deliver a signed rail webhook for a checkout and process events. */
  railEvent(checkoutId: string, eventId?: string): Promise<void>;
}

let eventCounter = 0;

export async function createRailWorld(
  db: DatabaseInterface,
  options: {
    paymentPolicy?: Partial<BillingPaymentPolicy>;
    /** Give Stripe the out-of-band method (default true). */
    outOfBand?: boolean;
  } = {},
): Promise<RailWorld> {
  const world = await createBillingWorld(db);
  const gateway = new FakeCryptoGateway();
  const rail = createCryptoBillingProvider({
    gateway,
    metadataSecret: RAIL_METADATA_SECRET,
    minimumAmount: { USD: 100 },
  });
  const outOfBand: string[] = [];
  const stripe = createStripeBillingProvider({
    stripe: await world.stripe.provider(),
    webhookSecret: WEBHOOK_SECRET,
  });
  // Stand in for sdk#1277 (Stripe `invoices.pay` with paid_out_of_band).
  const issuing: BillingProvider = {
    ...stripe,
    async getInvoice(id: string): Promise<BillingProviderInvoiceState> {
      const state = await stripe.getInvoice(id);
      return outOfBand.includes(id) ? { ...state, paidOutOfBand: true } : state;
    },
    ...(options.outOfBand === false
      ? {}
      : {
          async markInvoicePaidOutOfBand(id: string) {
            if (!outOfBand.includes(id)) outOfBand.push(id);
            world.stripe.pay(id);
          },
        }),
  };
  const railLedger = await withTenant({ tenantId: PROVIDER }, async () => {
    const accounts = await AccountCollection.create({ db });
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
      ...world.ledger,
      cryptoHoldingsAccountId: await make('1050', 'Bitcoin holdings', 'asset'),
      fxGainLossAccountId: await make('7100', 'FX gain/loss', 'revenue'),
      feesAccountId: await make('6100', 'Conversion fees', 'expense'),
    };
  });
  const runtime = await BillingRuntime.create({
    db,
    sellerTenantId: PROVIDER,
    kind: 'provider',
    provider: issuing,
    paymentProviders: [rail],
    paymentPolicy: options.paymentPolicy,
    billingRelationships: world.relationships,
    ledger: railLedger,
    onPayerStanding: (change) => {
      world.standingChanges.push(change);
    },
  });
  return {
    ...world,
    gateway,
    rail,
    runtime,
    railLedger,
    outOfBand,
    async railEvent(checkoutId: string, eventId?: string) {
      eventCounter += 1;
      const body = JSON.stringify({
        id: eventId ?? `evt_rail_${eventCounter}`,
        checkoutId,
        type: 'InvoiceSettled',
      });
      await runtime.acceptWebhook(body, '', {
        provider: 'btcpay',
        headers: { 'x-rail-sig': RAIL_SIGNATURE },
      });
      await runtime.processEvents();
    },
  };
}
