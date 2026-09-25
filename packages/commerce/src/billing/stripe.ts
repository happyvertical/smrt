/**
 * Stripe adapter for the {@link BillingProvider} port (#3060).
 *
 * Every provider call goes through `@happyvertical/accounting`'s Stripe
 * provider; this module only maps between commerce's integer minor units and
 * the SDK's major-unit contract, and normalizes verified webhook events. The
 * SDK's `*Minor` fields (checkout prices, session totals, off-session charges)
 * are already ISO minor units and pass through unconverted (#3139).
 */
import type {
  StripeAccountingProvider,
  StripeSubscriptionStatus,
  WebhookEvent,
} from '@happyvertical/accounting';
import type { SubscriptionStatus } from '@happyvertical/smrt-subscriptions';
import { CARD_SETUP_PURPOSE } from './cards.js';
import { CREDIT_PURCHASE_PURPOSE } from './credits.js';
import {
  type BillingChargeStatus,
  type BillingInvoiceEventType,
  type BillingProvider,
  type BillingProviderChargeInput,
  type BillingProviderChargeResult,
  type BillingProviderCheckoutInput,
  type BillingProviderCheckoutSession,
  type BillingProviderCheckoutState,
  type BillingProviderCustomerInput,
  type BillingProviderEvent,
  type BillingProviderInvoiceInput,
  type BillingProviderInvoiceState,
  type BillingProviderInvoiceStatus,
  type BillingProviderSetupCheckoutInput,
  type BillingProviderSubscriptionState,
  BillingWebhookVerificationError,
} from './provider.js';
import { AUTO_TOP_UP_CHARGE_PREFIX } from './top-up.js';
import {
  majorToMinorUnits,
  minorToMajorUnits,
  normalizeCurrency,
} from './units.js';

export interface StripeBillingProviderOptions {
  /** A Stripe provider from `getAccountingProvider({ type: 'stripe', … })`. */
  stripe: StripeAccountingProvider;
  /** Webhook endpoint signing secret (`whsec_…`). */
  webhookSecret: string;
}

const INVOICE_EVENTS: Record<string, BillingInvoiceEventType> = {
  'invoice.paid': 'paid',
  'invoice.payment_succeeded': 'paid',
  'invoice.payment_failed': 'payment_failed',
  'invoice.overdue': 'overdue',
  'invoice.marked_uncollectible': 'uncollectible',
  'invoice.voided': 'voided',
};

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

const PAYMENT_EVENTS = new Set([
  'payment_intent.succeeded',
  'payment_intent.processing',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);

const CHARGE_STATUSES = new Set<BillingChargeStatus>([
  'succeeded',
  'processing',
  'requires_action',
  'failed',
  'canceled',
]);

const INVOICE_STATUSES: Record<string, BillingProviderInvoiceStatus> = {
  draft: 'draft',
  paid: 'paid',
  voided: 'void',
  uncollectible: 'uncollectible',
};

const SUBSCRIPTION_STATUSES: Record<
  StripeSubscriptionStatus,
  SubscriptionStatus
> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  unpaid: 'unpaid',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'canceled',
  paused: 'unpaid',
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function createStripeBillingProvider(
  options: StripeBillingProviderOptions,
): BillingProvider {
  const { stripe, webhookSecret } = options;
  if (!webhookSecret) {
    throw new Error('A Stripe webhook signing secret is required.');
  }
  // Checkout amounts are settled from a re-read session (Stripe's webhook
  // amounts are in Stripe's unit, not ISO minor units), so the SDK must be
  // able to retrieve one (@happyvertical/accounting >= 0.92).
  const retrieveCheckoutSession = stripe.billing.retrieveCheckoutSession?.bind(
    stripe.billing,
  );
  if (!retrieveCheckoutSession) {
    throw new Error(
      'The Stripe provider cannot retrieve checkout sessions; upgrade @happyvertical/accounting to 0.92 or later.',
    );
  }
  const chargeSaved = stripe.payments.chargeSavedPaymentMethod?.bind(
    stripe.payments,
  );
  const setDefault = stripe.billing.setDefaultPaymentMethod?.bind(
    stripe.billing,
  );
  const markUncollectible = stripe.invoices.markUncollectible?.bind(
    stripe.invoices,
  );

  const provider: BillingProvider = {
    name: 'stripe',

    async syncCustomer(input: BillingProviderCustomerInput) {
      const customer = {
        id: input.accountId,
        externalId: input.providerCustomerId || undefined,
        name: input.name,
        email: input.email || undefined,
        billingAddress: input.billingAddress,
        taxExempt: input.taxExempt,
      };
      if (customer.externalId) {
        const result = await stripe.customers.sync(customer);
        return { providerCustomerId: result.externalId };
      }
      // Creation is idempotent per account (sdk#1268): a retry returns the
      // customer an earlier attempt created, found by Stripe's key replay or,
      // after its window, by the account id the SDK tags on the customer. The
      // key also covers the contents, so a retry with edited details is a new
      // request (Stripe refuses a reused key with other parameters) that the
      // SDK still resolves to the first customer by that tag.
      const digest = await sha256Hex(JSON.stringify(customer));
      const created = await stripe.customers.sync({
        ...customer,
        idempotencyKey: `smrt-billing-customer:${input.accountId}:${digest.slice(0, 32)}`,
      });
      // A replayed or found customer carries the first attempt's details;
      // write the current ones.
      await stripe.customers.sync({
        ...customer,
        externalId: created.externalId,
      });
      return { providerCustomerId: created.externalId };
    },

    async pushInvoice(input: BillingProviderInvoiceInput) {
      const currency = normalizeCurrency(input.currency);
      const subtotal = minorToMajorUnits(input.subtotal, currency);
      const result = await stripe.invoices.push({
        id: input.invoiceId,
        invoiceNumber: input.invoiceNumber,
        customerId: input.providerCustomerId,
        customerExternalId: input.providerCustomerId,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        lineItems: input.lines.map((line) => ({
          description: line.description,
          quantity: 1,
          unitPrice: minorToMajorUnits(line.amount, currency),
          periodStart: line.periodStart,
          periodEnd: line.periodEnd,
        })),
        subtotal,
        taxAmount: 0,
        totalAmount: subtotal,
        currency: currency.toLowerCase(),
        memo: input.memo,
        idempotencyKey: input.idempotencyKey,
        automaticTax: input.automaticTax,
        collectionMethod: input.collectionMethod ?? 'send_invoice',
      });
      return { providerInvoiceId: result.externalId };
    },

    async sendInvoice(providerInvoiceId: string) {
      await stripe.invoices.send(providerInvoiceId);
    },

    async getInvoice(
      providerInvoiceId: string,
    ): Promise<BillingProviderInvoiceState> {
      const invoice = await stripe.invoices.pull(providerInvoiceId);
      const currency = normalizeCurrency(invoice.currency);
      // sent, viewed, and overdue are all open (unpaid) at the provider.
      const status: BillingProviderInvoiceStatus =
        INVOICE_STATUSES[invoice.status] ?? 'open';
      return {
        providerInvoiceId: invoice.externalId,
        status,
        currency,
        subtotal: majorToMinorUnits(invoice.subtotal, currency),
        taxAmount: majorToMinorUnits(invoice.taxAmount, currency),
        total: majorToMinorUnits(invoice.totalAmount, currency),
        amountPaid: majorToMinorUnits(invoice.amountPaid, currency),
        amountDue: majorToMinorUnits(invoice.balance, currency),
      };
    },

    async getSubscription(
      providerSubscriptionId: string,
    ): Promise<BillingProviderSubscriptionState> {
      const subscription = await stripe.billing.retrieveSubscriptionStatus(
        providerSubscriptionId,
      );
      const status = SUBSCRIPTION_STATUSES[subscription.status];
      if (!status) {
        throw new Error(
          `Unknown Stripe subscription status '${subscription.status}'.`,
        );
      }
      return {
        providerSubscriptionId: subscription.externalId,
        status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        trialEndsAt: subscription.trialEnd,
      };
    },

    async createCheckout(
      input: BillingProviderCheckoutInput,
    ): Promise<BillingProviderCheckoutSession> {
      const currency = normalizeCurrency(input.currency);
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        throw new Error(
          'Checkout amount must be positive integer minor units.',
        );
      }
      const customerExternalId = input.providerCustomerId || undefined;
      if (input.savePaymentMethod && !customerExternalId) {
        throw new Error(
          'Saving a payment method requires a provider customer.',
        );
      }
      const session = await stripe.billing.createCheckoutSession({
        mode: 'payment',
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        customerExternalId,
        customerEmail: customerExternalId
          ? undefined
          : input.customerEmail || undefined,
        lineItems: [
          {
            quantity: 1,
            priceData: {
              currency: currency.toLowerCase(),
              // ISO minor units; the SDK converts to Stripe's unit (sdk#1269).
              unitAmountMinor: input.amount,
              productName: input.description,
            },
          },
        ],
        ...(input.automaticTax
          ? {
              automaticTax: true,
              // Stripe Tax needs the buyer's location: Checkout collects it
              // and saves it to an existing customer.
              ...(customerExternalId
                ? { customerUpdate: { address: 'auto' as const } }
                : { billingAddressCollection: 'required' as const }),
            }
          : {}),
        ...(input.savePaymentMethod
          ? { setupFutureUsage: 'off_session' as const }
          : {}),
        metadata: await signMetadata(input.metadata, webhookSecret),
        idempotencyKey: input.idempotencyKey,
      });
      return { sessionId: session.externalId, url: session.url };
    },

    async createSetupCheckout(
      input: BillingProviderSetupCheckoutInput,
    ): Promise<BillingProviderCheckoutSession> {
      if (!input.providerCustomerId) {
        throw new Error('A setup checkout requires a provider customer.');
      }
      const session = await stripe.billing.createCheckoutSession({
        mode: 'setup',
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        customerExternalId: input.providerCustomerId,
        currency: normalizeCurrency(input.currency).toLowerCase(),
        ...(input.collectBillingAddress
          ? {
              billingAddressCollection: 'required' as const,
              customerUpdate: { address: 'auto' as const },
            }
          : {}),
        metadata: await signMetadata(input.metadata, webhookSecret),
        idempotencyKey: input.idempotencyKey,
      });
      return { sessionId: session.externalId, url: session.url };
    },

    async getCheckout(
      sessionId: string,
    ): Promise<BillingProviderCheckoutState> {
      const session = await retrieveCheckoutSession(sessionId);
      const mode =
        session.mode === 'payment' || session.mode === 'setup'
          ? session.mode
          : 'other';
      const complete = session.status === 'complete';
      const state: BillingProviderCheckoutState = {
        sessionId: session.externalId,
        mode,
        complete,
        paid: session.paymentStatus === 'paid',
        providerCustomerId: session.customerExternalId,
        paymentMethodId: session.paymentMethodExternalId,
        currency: session.currency,
        amountSubtotal: session.amountSubtotalMinor,
        amountTax: session.amountTaxMinor,
        amountTotal: session.amountTotalMinor,
      };
      if (complete && session.customerExternalId) {
        // A session that collected an address saved it to the customer
        // (customer_update[address]=auto); callers adopt it only when they
        // asked for collection.
        const customer = await stripe.customers.pull(
          session.customerExternalId,
        );
        if (customer.billingAddress?.country) {
          state.billingAddress = customer.billingAddress;
        }
      }
      return state;
    },

    async verifyWebhook(
      payload: string,
      signature: string,
    ): Promise<BillingProviderEvent> {
      if (!stripe.webhooks.verify(payload, signature, webhookSecret)) {
        throw new BillingWebhookVerificationError();
      }
      return normalizeStripeEvent(
        stripe.webhooks.parse(payload),
        webhookSecret,
      );
    },
  };

  if (chargeSaved) {
    provider.chargeSavedPaymentMethod = async (
      input: BillingProviderChargeInput,
    ): Promise<BillingProviderChargeResult> => {
      const result = await chargeSaved({
        customerExternalId: input.providerCustomerId,
        amountMinor: input.amount,
        currency: normalizeCurrency(input.currency),
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        metadata: input.metadata,
      });
      return {
        status: result.status,
        providerPaymentId: result.paymentExternalId,
        amount: result.amountMinor,
        currency: result.currency,
        failureCode: result.failureCode,
        failureMessage: result.failureMessage,
      };
    };
  }
  if (setDefault) {
    provider.setDefaultPaymentMethod = (providerCustomerId, paymentMethodId) =>
      setDefault(providerCustomerId, paymentMethodId);
  }
  if (markUncollectible) {
    provider.markInvoiceUncollectible = (providerInvoiceId) =>
      markUncollectible(providerInvoiceId);
  }
  return provider;
}

/** Normalize a verified, parsed Stripe event. Exported for tests. */
export async function normalizeStripeEvent(
  event: WebhookEvent,
  webhookSecret: string,
): Promise<BillingProviderEvent> {
  const eventId = event.id;
  if (!eventId) {
    throw new BillingWebhookVerificationError(
      'Stripe webhook event has no id; it cannot be deduplicated.',
    );
  }
  // After verification, anything this package cannot act on is `ignored`
  // (acknowledged, not stored) rather than thrown: a throw here would fail
  // the host's webhook response for an event that is not ours.
  const ignored = { kind: 'ignored' as const, eventId, type: event.type };
  const invoiceType = INVOICE_EVENTS[event.type];
  if (invoiceType) {
    if (!event.resourceId) return ignored;
    return {
      kind: 'invoice',
      eventId,
      type: invoiceType,
      providerInvoiceId: event.resourceId,
    };
  }
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const id = stripeObject(event).id;
    if (typeof id !== 'string' || !id) return ignored;
    return { kind: 'subscription', eventId, providerSubscriptionId: id };
  }
  if (CHECKOUT_EVENTS.has(event.type)) {
    const session = stripeObject(event);
    // Only sessions this package created are stored, and only their smrt_*
    // metadata: other integrations' checkouts never enter the inbox. The
    // metadata is signed with the endpoint secret at creation, so another
    // integration on the same account cannot forge a credit purchase or
    // attach a card to another payer.
    const metadata = smrtMetadata(session.metadata);
    const id = session.id;
    const mode = session.mode;
    const expected =
      (mode === 'payment' &&
        metadata.smrt_purpose === CREDIT_PURCHASE_PURPOSE) ||
      (mode === 'setup' && metadata.smrt_purpose === CARD_SETUP_PURPOSE);
    if (
      !expected ||
      !(await metadataSignatureValid(metadata, webhookSecret)) ||
      typeof id !== 'string' ||
      !id ||
      (mode === 'payment' && typeof session.currency !== 'string')
    ) {
      // A session that claims to be ours but fails these checks is reported
      // distinctly so the host can alert on it.
      if (!expected) return ignored;
      return {
        ...ignored,
        type:
          mode === 'payment'
            ? `${event.type}:unverified_credit_purchase`
            : `${event.type}:unverified_card_setup`,
      };
    }
    // Amounts are not taken from the event: Stripe reports them in its own
    // unit, which differs from ISO minor units for some currencies (ISK,
    // UGX). `observe()` re-reads the session through the SDK, which converts.
    return {
      kind: 'checkout_completed',
      eventId,
      sessionId: id,
      mode,
      paid: session.payment_status === 'paid',
      // Validated when the event is applied, so a bad value dead-letters
      // visibly instead of failing intake.
      currency:
        typeof session.currency === 'string'
          ? session.currency.toUpperCase()
          : '',
      metadata,
    };
  }
  if (PAYMENT_EVENTS.has(event.type)) {
    // Only off-session charges this package made (#3139); the charge key is
    // the SDK's `hv_charge_key` metadata. Settlement checks it against the
    // local attempt row, amount, currency, and customer.
    const payment = event.payment;
    const chargeKey = payment?.chargeKey;
    if (
      !payment ||
      !chargeKey?.startsWith(AUTO_TOP_UP_CHARGE_PREFIX) ||
      !CHARGE_STATUSES.has(payment.status) ||
      !payment.paymentExternalId
    ) {
      return ignored;
    }
    return {
      kind: 'payment',
      eventId,
      chargeKey,
      status: payment.status,
      providerPaymentId: payment.paymentExternalId,
      providerCustomerId: payment.customerExternalId,
      amount: payment.amountMinor,
      currency: payment.currency,
      failureCode: payment.failureCode,
    };
  }
  return ignored;
}

function stripeObject(event: WebhookEvent): Record<string, unknown> {
  const payload = event.payload as { data?: { object?: unknown } } | null;
  const object = payload?.data?.object;
  return object && typeof object === 'object'
    ? (object as Record<string, unknown>)
    : {};
}

const SIGNATURE_KEY = 'smrt_sig';

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function canonicalMetadata(metadata: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(metadata)
      // Empty values are dropped by the provider, so they are never signed.
      .filter(
        ([key, value]) =>
          key.startsWith('smrt_') && key !== SIGNATURE_KEY && value !== '',
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

async function signMetadata(
  metadata: Record<string, string>,
  secret: string,
): Promise<Record<string, string>> {
  return {
    ...metadata,
    [SIGNATURE_KEY]: await hmacHex(
      `smrt-checkout:${secret}`,
      canonicalMetadata(metadata),
    ),
  };
}

async function metadataSignatureValid(
  metadata: Record<string, string>,
  secret: string,
): Promise<boolean> {
  const given = metadata[SIGNATURE_KEY];
  if (!given) return false;
  const expected = await hmacHex(
    `smrt-checkout:${secret}`,
    canonicalMetadata(metadata),
  );
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < given.length; index += 1) {
    diff |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

function smrtMetadata(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith('smrt_') && typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}
