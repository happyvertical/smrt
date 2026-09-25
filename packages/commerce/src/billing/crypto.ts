/**
 * A crypto payment rail for the {@link BillingProvider} port (#3138).
 *
 * The rail runs short-lived, fiat-priced checkouts through a
 * `CryptoCheckoutGateway` from `@happyvertical/payments` — BTCPay at launch,
 * any other implementation of the port later. It never issues invoices: the
 * runtime's issuing provider (Stripe) does, and this rail pays them or buys
 * prepaid credit. Settlement is the gateway's decision (its confirmation
 * policy); this package never counts confirmations.
 */
import {
  type CryptoCheckout,
  type CryptoCheckoutGateway,
  CryptoCheckoutNotOwnedError,
  PaymentVerificationError,
} from '@happyvertical/payments';
import {
  type BillingPaymentAttemptPayment,
  type BillingPaymentAttemptState,
  type BillingProvider,
  type BillingProviderCheckoutInput,
  type BillingProviderCheckoutSession,
  type BillingProviderEvent,
  BillingProviderUnsupportedError,
  BillingWebhookVerificationError,
} from './provider.js';
import {
  metadataSignatureValid,
  SIGNATURE_KEY,
  signMetadata,
  smrtMetadata,
} from './stripe.js';
import { currencyMinorUnitExponent, normalizeCurrency } from './units.js';

export interface CryptoBillingProviderOptions {
  /** A checkout gateway, for example `createBtcpayCheckoutGateway()`. */
  gateway: CryptoCheckoutGateway;
  /**
   * Secret the `smrt_*` checkout metadata is signed with. Rotating it
   * strands checkouts created before the rotation.
   */
  metadataSecret: string;
  /** Provider name on local rows and in the inbox (default the gateway id). */
  name?: string;
  /**
   * Smallest checkout accepted, per currency, in minor units (fee and dust
   * economics). A currency without an entry has no minimum.
   */
  minimumAmount?: Record<string, number>;
}

/** Minor-unit exponents of the settlement assets this rail records. */
const ASSET_EXPONENTS: Record<string, number> = { BTC: 8 };

export function createCryptoBillingProvider(
  options: CryptoBillingProviderOptions,
): BillingProvider {
  const { gateway, metadataSecret } = options;
  if (!gateway) throw new Error('A crypto checkout gateway is required.');
  if (!metadataSecret) {
    throw new Error('A crypto rail metadata secret is required.');
  }
  const name = options.name ?? gateway.id;
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid crypto rail name '${name}'.`);
  }
  const minimums = new Map<string, number>();
  for (const [currency, amount] of Object.entries(
    options.minimumAmount ?? {},
  )) {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`minimumAmount for ${currency} must be minor units.`);
    }
    minimums.set(normalizeCurrency(currency), amount);
  }
  const unsupported = (what: string) => async () => {
    throw new BillingProviderUnsupportedError(
      `The ${name} payment rail does not ${what}; the runtime's issuing provider does.`,
    );
  };

  return {
    name,
    capabilities: { issuesInvoices: false, paymentAttempts: true },

    async syncCustomer(input) {
      // No provider customer exists; the account id identifies the payer.
      return { providerCustomerId: `${name}:${input.accountId}` };
    },
    pushInvoice: unsupported('issue invoices'),
    sendInvoice: unsupported('send invoices'),
    getInvoice: unsupported('issue invoices'),
    getSubscription: unsupported('manage subscriptions'),

    async createCheckout(
      input: BillingProviderCheckoutInput,
    ): Promise<BillingProviderCheckoutSession> {
      const currency = normalizeCurrency(input.currency);
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        throw new Error(
          'Checkout amount must be positive integer minor units.',
        );
      }
      const minimum = minimums.get(currency) ?? 0;
      if (input.amount < minimum) {
        throw new Error(
          `The ${name} payment rail accepts at least ${minimum} ${currency} minor units.`,
        );
      }
      const checkout = await gateway.createCheckout({
        orderId: input.idempotencyKey,
        amount: input.amount,
        currency,
        description: input.description,
        buyerEmail: input.customerEmail || undefined,
        metadata: await signMetadata(
          smrtMetadata(input.metadata),
          metadataSecret,
        ),
        redirectUrl: input.successUrl,
      });
      return { sessionId: checkout.id, url: checkout.checkoutUrl ?? null };
    },

    async verifyWebhook(
      payload: string,
      _signature: string,
      headers?: Headers | Record<string, string | undefined>,
    ): Promise<BillingProviderEvent> {
      let event: ReturnType<CryptoCheckoutGateway['verifyWebhook']>;
      try {
        event = gateway.verifyWebhook(payload, headers ?? {});
      } catch (error) {
        if (error instanceof PaymentVerificationError) {
          throw new BillingWebhookVerificationError(error.message);
        }
        throw error;
      }
      if (!event.checkoutId) {
        return { kind: 'ignored', eventId: event.eventId, type: event.type };
      }
      return {
        kind: 'payment_attempt',
        eventId: event.eventId,
        checkoutId: event.checkoutId,
      };
    },

    async getPaymentAttempt(
      checkoutId: string,
    ): Promise<BillingPaymentAttemptState | null> {
      let checkout: CryptoCheckout;
      try {
        checkout = await gateway.getCheckout(checkoutId);
      } catch (error) {
        if (error instanceof CryptoCheckoutNotOwnedError) return null;
        throw error;
      }
      const metadata = smrtMetadata(checkout.metadata);
      const verified =
        Boolean(metadata[SIGNATURE_KEY]) &&
        (await metadataSignatureValid(metadata, metadataSecret));
      return toAttemptState(checkout, verified ? metadata : {});
    },
  };
}

function toAttemptState(
  checkout: CryptoCheckout,
  metadata: Record<string, string>,
): BillingPaymentAttemptState {
  const currency = normalizeCurrency(checkout.currency);
  // Validates the fiat currency's exponent (throws for unknown codes).
  currencyMinorUnitExponent(currency);
  const asset = checkout.settlementAsset?.toUpperCase();
  const exponent = asset ? ASSET_EXPONENTS[asset] : undefined;
  if (asset && exponent === undefined) {
    throw new Error(
      `Checkout ${checkout.id} settles in ${asset}, which this rail cannot record.`,
    );
  }
  const native = (value: string | undefined) =>
    value === undefined || exponent === undefined
      ? undefined
      : decimalToAtomic(value, exponent);
  const payments: BillingPaymentAttemptPayment[] = checkout.payments.map(
    (payment) => {
      const paymentExponent = ASSET_EXPONENTS[payment.asset.toUpperCase()];
      if (paymentExponent === undefined) {
        throw new Error(
          `Checkout ${checkout.id} has a ${payment.asset} payment this rail cannot record.`,
        );
      }
      return {
        id: payment.id,
        rail: payment.rail,
        asset: payment.asset.toUpperCase(),
        amount: decimalToAtomic(payment.amount, paymentExponent),
        ...(payment.fee !== undefined
          ? { fee: decimalToAtomic(payment.fee, paymentExponent) }
          : {}),
        status: payment.status,
        ...(payment.transactionId
          ? { transactionId: payment.transactionId }
          : {}),
        ...(payment.receivedAt
          ? { receivedAt: payment.receivedAt.toISOString() }
          : {}),
      };
    },
  );
  return {
    checkoutId: checkout.id,
    status: checkout.status,
    exception: checkout.exception,
    amount: checkout.amount,
    currency,
    amountPaid: checkout.amountPaid,
    metadata,
    nativeCurrency: asset,
    nativeAmountDue: native(checkout.nativeAmountDue),
    nativeAmountPaid: native(checkout.nativeAmountPaid),
    rate: checkout.rate,
    rateSource: checkout.rateSource,
    checkoutUrl: checkout.checkoutUrl,
    expiresAt: checkout.expiresAt,
    payments,
  };
}

/** Exact decimal string → integer atomic units; rejects excess precision. */
export function decimalToAtomic(value: string, exponent: number): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value).trim());
  if (!match) throw new Error(`Invalid decimal amount '${value}'.`);
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > exponent) {
    throw new Error(`Amount ${value} has more than ${exponent} decimals.`);
  }
  const atomic = BigInt(`${match[1]}${fraction.padEnd(exponent, '0')}`);
  if (atomic > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Amount ${value} exceeds the safe integer range.`);
  }
  return Number(atomic);
}
