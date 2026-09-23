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
      /** Pre-tax amount collected, minor units. */
      amountSubtotal: number;
      metadata: Record<string, string>;
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
}

export class BillingWebhookVerificationError extends Error {
  constructor(message = 'Billing webhook signature verification failed.') {
    super(message);
    this.name = 'BillingWebhookVerificationError';
  }
}
