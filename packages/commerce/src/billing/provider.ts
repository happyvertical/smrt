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
  /**
   * Product tax code for provider-calculated tax (Stripe Tax `txcd_...`,
   * #3194). Omitted: the provider account's default.
   */
  taxCode?: string;
}

/**
 * How the provider collects an invoice. `charge_automatically` charges the
 * payer's saved default payment method after the invoice is sent, on the
 * provider's own schedule; the outcome arrives as a `paid` or
 * `payment_failed` event. A provider that cannot pull funds from a saved
 * method must reject it, never fall back to `send_invoice`.
 */
export type BillingCollectionMethod = 'send_invoice' | 'charge_automatically';

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
  /** Default `send_invoice` (#3139). */
  collectionMethod?: BillingCollectionMethod;
  memo?: string;
}

/**
 * `uncollectible` is an open balance the seller wrote off (#3139); it can
 * still be paid or voided later.
 */
export type BillingProviderInvoiceStatus =
  | 'draft'
  | 'open'
  | 'paid'
  | 'void'
  | 'uncollectible';

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
  /**
   * Charge provider-calculated tax on top of `amount` (#3139). The buyer's
   * tax location is collected at checkout when the customer has none.
   */
  automaticTax?: boolean;
  /**
   * Product tax code for the checkout line (Stripe Tax `txcd_...`, #3194).
   * Omitted: the provider account's default.
   */
  taxCode?: string;
  /**
   * Also save the payment method for later off-session charges (for example
   * automatic top-ups). Requires `providerCustomerId`.
   */
  savePaymentMethod?: boolean;
}

export interface BillingProviderCheckoutSession {
  sessionId: string;
  url: string | null;
}

/** A checkout that saves a payment method without charging (#3139). */
export interface BillingProviderSetupCheckoutInput {
  /** Stable key reused when retrying the same checkout creation. */
  idempotencyKey: string;
  providerCustomerId: string;
  /** The currency the saved method will be charged in. */
  currency: string;
  successUrl: string;
  cancelUrl: string;
  /** Collect the billing address (tax location) and save it to the customer. */
  collectBillingAddress: boolean;
  /** Opaque values returned verbatim on the completion event. */
  metadata: Record<string, string>;
}

/** A checkout session as the provider reports it now (#3139). */
export interface BillingProviderCheckoutState {
  sessionId: string;
  mode: 'payment' | 'setup' | 'other';
  /** The session completed (paid, or a payment method was saved). */
  complete: boolean;
  /** A payment-mode session collected its money. */
  paid: boolean;
  providerCustomerId?: string;
  /** The payment method the session collected. */
  paymentMethodId?: string;
  currency?: string;
  /** Line amount before discounts and tax, minor units. */
  amountSubtotal?: number;
  /** Provider-calculated tax, minor units. */
  amountTax?: number;
  /** Amount collected, minor units. */
  amountTotal?: number;
  /**
   * The customer's billing address after a completed session that was asked
   * to collect one.
   */
  billingAddress?: Address;
}

/**
 * The outcome of an off-session charge (#3139). `processing` settles later
 * through a `payment` event; `requires_action` (the issuer wants the payer
 * present), `failed`, and `canceled` charged nothing.
 */
export type BillingChargeStatus =
  | 'succeeded'
  | 'processing'
  | 'requires_action'
  | 'failed'
  | 'canceled';

export interface BillingProviderChargeInput {
  providerCustomerId: string;
  /** Positive integer minor units. */
  amount: number;
  currency: string;
  /**
   * Stable key for this logical charge. Every retry with it returns the
   * original charge; a new attempt needs a new key.
   */
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, string>;
  /**
   * Add provider-calculated tax on top of `amount` from the customer's tax
   * location (#3194): `amount` is then the pre-tax subtotal. A customer whose
   * tax location cannot be determined yields a `failed` result with
   * `failureCode: 'customer_tax_location_invalid'`, charging nothing. A
   * provider that cannot calculate tax must throw, never charge untaxed.
   * Every retry of a charge key must pass the same value.
   */
  automaticTax?: boolean;
  /** Product tax code (requires `automaticTax`). */
  taxCode?: string;
}

export interface BillingProviderChargeResult {
  status: BillingChargeStatus;
  /** The provider payment id, when one was created. */
  providerPaymentId?: string;
  /** Minor units charged, including tax for an `automaticTax` charge. */
  amount: number;
  currency: string;
  /** `automaticTax` charges: the pre-tax amount, minor units. */
  subtotal?: number;
  /** `automaticTax` charges: the provider-calculated tax, minor units. */
  tax?: number;
  failureCode?: string;
  failureMessage?: string;
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
      /** `payment` (credit purchase) or `setup` (card on file, #3139). */
      mode?: 'payment' | 'setup';
      /** Only `paid` sessions settle a credit purchase. */
      paid: boolean;
      currency: string;
      /**
       * Line-item amount before discounts and tax, minor units. Omitted by a
       * provider whose event amounts are not minor units; `observe()` then
       * re-reads the session with `getCheckout()`.
       */
      amountSubtotal?: number;
      /** Provider-calculated tax, minor units. */
      amountTax?: number;
      /** Amount actually collected (after discounts, with tax), minor units. */
      amountTotal?: number;
      metadata: Record<string, string>;
    }
  | {
      /** An off-session charge made by `chargeSavedPaymentMethod` (#3139). */
      kind: 'payment';
      eventId: string;
      /** The `idempotencyKey` the charge was made with. */
      chargeKey: string;
      status: BillingChargeStatus;
      providerPaymentId: string;
      providerCustomerId?: string;
      /**
       * Minor units charged (with tax for an `automaticTax` charge), when the
       * provider amount converts exactly.
       */
      amount?: number;
      currency?: string;
      /** `automaticTax` charges: the pre-tax amount, minor units (#3194). */
      subtotal?: number;
      /** `automaticTax` charges: the provider-calculated tax, minor units. */
      tax?: number;
      failureCode?: string;
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

  // Optional capabilities (#3139). A provider that cannot do one omits the
  // method, and callers detect the capability by its presence.

  /**
   * Charge the customer's saved default payment method off-session,
   * idempotently by `input.idempotencyKey`. A decline or an authentication
   * requirement is a result, not a throw.
   */
  chargeSavedPaymentMethod?(
    input: BillingProviderChargeInput,
  ): Promise<BillingProviderChargeResult>;
  /** Start a checkout that saves a payment method without charging. */
  createSetupCheckout?(
    input: BillingProviderSetupCheckoutInput,
  ): Promise<BillingProviderCheckoutSession>;
  /** Re-read a checkout session, with amounts in minor units. */
  getCheckout?(sessionId: string): Promise<BillingProviderCheckoutState>;
  /** Make a saved payment method the customer's default. Idempotent. */
  setDefaultPaymentMethod?(
    providerCustomerId: string,
    paymentMethodId: string,
  ): Promise<void>;
  /** Write an open invoice off as uncollectible. Idempotent. */
  markInvoiceUncollectible?(providerInvoiceId: string): Promise<void>;
  /**
   * Close an issued invoice as paid outside the provider (#3138). Must be
   * idempotent: an invoice already closed this way is a no-op. Callers check
   * `getInvoice()` first and never close an invoice the provider collected
   * itself (a provider may throw for one).
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

/**
 * Why a payer's payment request was refused (#3185). New codes may be added
 * in a minor release; treat an unknown code like `not_payable`.
 *
 * - `not_found`: no such invoice for this payer, or no active balance policy.
 * - `not_payable`: the invoice exists but cannot be paid now (not sent and
 *   unpaid, or not issued by this runtime's provider).
 * - `payment_in_progress`: another payment for the invoice is still open.
 * - `nothing_due`: the invoice has no amount left to pay.
 * - `invalid_amount`: the requested amount is not positive minor units.
 * - `below_minimum`: the amount is under the rail's minimum.
 * - `no_account`: the payer has no billing account with this seller.
 */
export type BillingPaymentRefusalCode =
  | 'not_found'
  | 'not_payable'
  | 'payment_in_progress'
  | 'nothing_due'
  | 'invalid_amount'
  | 'below_minimum'
  | 'no_account';

/**
 * A payment request refused for a reason the payer can act on (#3185): show
 * the message as a 4xx. Anything else thrown by the same call (provider,
 * database, or configuration failures) is a server error.
 * `TenantIsolationError` (a caller who is not the payer) stays separate.
 */
export class BillingPaymentRefusedError extends Error {
  readonly code: BillingPaymentRefusalCode;

  constructor(code: BillingPaymentRefusalCode, message: string) {
    super(message);
    this.name = 'BillingPaymentRefusedError';
    this.code = code;
  }
}

export class BillingWebhookVerificationError extends Error {
  constructor(message = 'Billing webhook signature verification failed.') {
    super(message);
    this.name = 'BillingWebhookVerificationError';
  }
}
