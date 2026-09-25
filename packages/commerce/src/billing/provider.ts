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
}

export interface BillingProviderChargeResult {
  status: BillingChargeStatus;
  /** The provider payment id, when one was created. */
  providerPaymentId?: string;
  /** Minor units. */
  amount: number;
  currency: string;
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
      /** Minor units, when the provider amount converts exactly. */
      amount?: number;
      currency?: string;
      failureCode?: string;
    }
  | { kind: 'ignored'; eventId: string; type: string };

/**
 * A payment provider as period close sees it. Implementations must be
 * replay-safe: `pushInvoice` with the same `idempotencyKey` returns the same
 * provider invoice however often it is retried.
 */
export interface BillingProvider {
  /** Provider name recorded on local rows (`stripe`). */
  readonly name: string;
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
}

export class BillingWebhookVerificationError extends Error {
  constructor(message = 'Billing webhook signature verification failed.') {
    super(message);
    this.name = 'BillingWebhookVerificationError';
  }
}
