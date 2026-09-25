/**
 * The provider-neutral port period close, webhook intake, and credit
 * purchases talk to (#3060).
 *
 * Every amount crossing this port is **integer minor units** of the named
 * currency, like the rest of commerce. Adapters (see
 * {@link createStripeBillingProvider}) own the conversion to the provider's
 * representation and every provider call; this package never calls a payment
 * provider directly.
 */
import type { SubscriptionStatus } from '@happyvertical/smrt-subscriptions';
import type { Address } from '../types/index.js';

export interface BillingProviderCustomerInput {
  /** The local billing account id, recorded on the provider customer. */
  accountId: string;
  /** Existing provider customer id; omitted to create one. */
  providerCustomerId?: string;
  name: string;
  email?: string;
  /** Tax location used by provider-calculated tax. */
  billingAddress?: Address;
  taxExempt: boolean;
}

export interface BillingProviderInvoiceLine {
  description: string;
  /** Signed line amount in minor units; discounts are negative lines. */
  amount: number;
  periodStart?: Date;
  periodEnd?: Date;
}

export interface BillingProviderInvoiceInput {
  /** Local invoice id; the provider tags its invoice with it. */
  invoiceId: string;
  invoiceNumber: string;
  providerCustomerId: string;
  currency: string;
  issueDate: Date;
  dueDate: Date;
  lines: BillingProviderInvoiceLine[];
  /** Sum of `lines`, in minor units. */
  subtotal: number;
  /** Stable key for this logical invoice; reused on every retry. */
  idempotencyKey: string;
  /** Ask the provider to calculate tax from the customer's tax location. */
  automaticTax: boolean;
  memo?: string;
}

export type BillingProviderInvoiceStatus = 'draft' | 'open' | 'paid' | 'void';

export interface BillingProviderInvoiceState {
  providerInvoiceId: string;
  status: BillingProviderInvoiceStatus;
  /**
   * The invoice was closed as paid outside the provider (for example by a
   * crypto payment rail, #3138). The rail that took the money records it; the
   * provider's own `paid` event must not record a second payment.
   */
  paidOutOfBand?: boolean;
  currency: string;
  /** Pre-tax subtotal, minor units. */
  subtotal: number;
  /** Provider-calculated tax, minor units. */
  taxAmount: number;
  total: number;
  amountPaid: number;
  amountDue: number;
}

export interface BillingProviderSubscriptionState {
  providerSubscriptionId: string;
  status: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  trialEndsAt?: Date;
}

export interface BillingProviderCheckoutInput {
  /** Stable key reused when retrying the same checkout creation. */
  idempotencyKey: string;
  providerCustomerId?: string;
  customerEmail?: string;
  currency: string;
  /** Amount charged, minor units. */
  amount: number;
  description: string;
  successUrl: string;
  cancelUrl: string;
  /** Opaque values returned verbatim on the completion event. */
  metadata: Record<string, string>;
}

export interface BillingProviderCheckoutSession {
  sessionId: string;
  url: string | null;
}

/** Invoice lifecycle changes this package acts on. */
export type BillingInvoiceEventType =
  | 'paid'
  | 'payment_failed'
  | 'overdue'
  | 'uncollectible'
  | 'voided';

/** A verified provider event, normalized and stripped of customer data. */
export type BillingProviderEvent =
  | {
      kind: 'invoice';
      eventId: string;
      type: BillingInvoiceEventType;
      providerInvoiceId: string;
    }
  | {
      kind: 'subscription';
      eventId: string;
      providerSubscriptionId: string;
    }
  | {
      kind: 'checkout_completed';
      eventId: string;
      sessionId: string;
      /** Only `paid` sessions settle a credit purchase. */
      paid: boolean;
      currency: string;
      /** Line-item amount before discounts and tax, minor units. */
      amountSubtotal: number;
      /** Amount actually collected (after discounts, with tax), minor units. */
      amountTotal: number;
      metadata: Record<string, string>;
    }
  | {
      /**
       * A payment rail's checkout changed (#3138). The event carries ids
       * only; `observe()` re-reads the attempt with `getPaymentAttempt()`.
       */
      kind: 'payment_attempt';
      eventId: string;
      checkoutId: string;
    }
  | { kind: 'ignored'; eventId: string; type: string };

/** What a provider can do beyond the core port (#3138). */
export interface BillingProviderCapabilities {
  /**
   * The provider issues, taxes, and sends invoices (`pushInvoice` …). A
   * payment rail (for example a crypto checkout) does not, and cannot be a
   * runtime's issuing provider.
   */
  issuesInvoices: boolean;
  /** The provider reports checkouts through `getPaymentAttempt()`. */
  paymentAttempts: boolean;
}

/** A rail checkout's lifecycle, normalized by the provider (#3138). */
export type BillingPaymentAttemptStatus =
  | 'open'
  | 'confirming'
  | 'settled'
  | 'expired'
  | 'invalid';

export type BillingPaymentAttemptException =
  | 'none'
  | 'underpaid'
  | 'overpaid'
  | 'paid_late'
  | 'manually_marked';

export interface BillingPaymentAttemptPayment {
  id: string;
  /** `onchain`, `lightning`, … */
  rail: string;
  /** The asset paid (`BTC`). */
  asset: string;
  /** Amount in the asset's minor units (satoshis for BTC). */
  amount: number;
  /** Fee in the asset's minor units, when reported. */
  fee?: number;
  status: 'confirming' | 'settled' | 'invalid';
  transactionId?: string;
  receivedAt?: string;
}

/**
 * A rail checkout as the provider reports it now. Amounts are minor units;
 * `metadata` holds only `smrt_*` keys whose signature verified, and is empty
 * for a checkout this package did not create.
 */
export interface BillingPaymentAttemptState {
  checkoutId: string;
  /** The rail order id the checkout was created for. */
  orderId?: string;
  status: BillingPaymentAttemptStatus;
  exception: BillingPaymentAttemptException;
  /** The locked fiat price. */
  amount: number;
  currency: string;
  /** Fiat value received at the locked rate, rounded down. */
  amountPaid: number;
  metadata: Record<string, string>;
  /** The asset the price was quoted in (`BTC`). */
  nativeCurrency?: string;
  /** Asset minor units (satoshis). */
  nativeAmountDue?: number;
  nativeAmountPaid?: number;
  /** Decimal price of one unit of `nativeCurrency` in `currency`. */
  rate?: string;
  rateSource?: string;
  checkoutUrl?: string;
  expiresAt?: Date;
  payments: BillingPaymentAttemptPayment[];
}

/**
 * A payment provider as period close sees it. Implementations must be
 * replay-safe: `pushInvoice` with the same `idempotencyKey` returns the same
 * provider invoice however often it is retried.
 */
export interface BillingProvider {
  /** Provider name recorded on local rows (`stripe`). */
  readonly name: string;
  /**
   * Defaults to an issuing provider without payment attempts (Stripe's
   * shape) when omitted.
   */
  readonly capabilities?: BillingProviderCapabilities;
  syncCustomer(
    input: BillingProviderCustomerInput,
  ): Promise<{ providerCustomerId: string }>;
  pushInvoice(
    input: BillingProviderInvoiceInput,
  ): Promise<{ providerInvoiceId: string }>;
  /** Finalize (if still a draft) and send an invoice for payment. */
  sendInvoice(providerInvoiceId: string): Promise<void>;
  getInvoice(providerInvoiceId: string): Promise<BillingProviderInvoiceState>;
  getSubscription(
    providerSubscriptionId: string,
  ): Promise<BillingProviderSubscriptionState>;
  createCheckout(
    input: BillingProviderCheckoutInput,
  ): Promise<BillingProviderCheckoutSession>;
  /**
   * Verify a webhook signature and normalize the event. Rejects with
   * {@link BillingWebhookVerificationError} when the signature is invalid;
   * anything verified but not actionable is returned as `ignored`.
   */
  verifyWebhook(
    payload: string,
    signature: string,
    /** The request headers, for providers that sign with their own header. */
    headers?: Headers | Record<string, string | undefined>,
  ): Promise<BillingProviderEvent>;
  /**
   * Close an issued invoice as paid outside the provider (#3138). Must be
   * idempotent: an invoice already paid is a no-op.
   */
  markInvoicePaidOutOfBand?(providerInvoiceId: string): Promise<void>;
  /**
   * Read a rail checkout's current state (#3138). Returns null for a
   * checkout this provider did not create.
   */
  getPaymentAttempt?(
    checkoutId: string,
  ): Promise<BillingPaymentAttemptState | null>;
}

/** The provider's capabilities, defaulted for providers that omit them. */
export function providerCapabilities(
  provider: BillingProvider,
): BillingProviderCapabilities {
  return (
    provider.capabilities ?? { issuesInvoices: true, paymentAttempts: false }
  );
}

/** A provider was asked for something it does not do (#3138). */
export class BillingProviderUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingProviderUnsupportedError';
  }
}

export class BillingWebhookVerificationError extends Error {
  constructor(message = 'Billing webhook signature verification failed.') {
    super(message);
    this.name = 'BillingWebhookVerificationError';
  }
}
