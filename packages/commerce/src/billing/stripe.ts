/**
 * Stripe adapter for the {@link BillingProvider} port (#3060).
 *
 * Every provider call goes through `@happyvertical/accounting`'s Stripe
 * provider; this module only maps between commerce's integer minor units and
 * the SDK's major-unit contract, and normalizes verified webhook events.
 */
import type {
  StripeAccountingProvider,
  StripeSubscriptionStatus,
  WebhookEvent,
} from '@happyvertical/accounting';
import type { SubscriptionStatus } from '@happyvertical/smrt-subscriptions';
import { CREDIT_PURCHASE_PURPOSE } from './credits.js';
import {
  type BillingInvoiceEventType,
  type BillingProvider,
  type BillingProviderCheckoutInput,
  type BillingProviderCheckoutSession,
  type BillingProviderCustomerInput,
  type BillingProviderEvent,
  type BillingProviderInvoiceInput,
  type BillingProviderInvoiceState,
  type BillingProviderInvoiceStatus,
  type BillingProviderSubscriptionState,
  BillingWebhookVerificationError,
} from './provider.js';
import {
  currencyMinorUnitExponent,
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

/**
 * Checkout line amounts are passed to Stripe in its smallest currency unit,
 * which equals the ISO minor unit only for two-decimal currencies. Credit
 * purchases are therefore limited to those (USD, CAD, EUR, …).
 */
function assertCheckoutCurrency(currency: string): string {
  const code = normalizeCurrency(currency);
  if (currencyMinorUnitExponent(code) !== 2) {
    throw new Error(
      `Checkout credit purchases support two-decimal currencies only; ${code} is not.`,
    );
  }
  return code;
}

export function createStripeBillingProvider(
  options: StripeBillingProviderOptions,
): BillingProvider {
  const { stripe, webhookSecret } = options;
  if (!webhookSecret) {
    throw new Error('A Stripe webhook signing secret is required.');
  }

  return {
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
      const result = await stripe.customers.sync(customer);
      return { providerCustomerId: result.externalId };
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
      const status: BillingProviderInvoiceStatus =
        invoice.status === 'draft'
          ? 'draft'
          : invoice.status === 'paid'
            ? 'paid'
            : invoice.status === 'voided'
              ? 'void'
              : 'open';
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
      const currency = assertCheckoutCurrency(input.currency);
      if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
        throw new Error(
          'Checkout amount must be positive integer minor units.',
        );
      }
      const session = await stripe.billing.createCheckoutSession({
        mode: 'payment',
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        customerExternalId: input.providerCustomerId || undefined,
        customerEmail: input.customerEmail || undefined,
        lineItems: [
          {
            quantity: 1,
            priceData: {
              currency: currency.toLowerCase(),
              unitAmount: input.amount,
              productName: input.description,
            },
          },
        ],
        metadata: await signMetadata(input.metadata, webhookSecret),
        idempotencyKey: input.idempotencyKey,
      });
      return { sessionId: session.externalId, url: session.url };
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
    // integration on the same account cannot forge a credit purchase.
    const metadata = smrtMetadata(session.metadata);
    const id = session.id;
    const amount = session.amount_subtotal;
    if (
      session.mode !== 'payment' ||
      metadata.smrt_purpose !== CREDIT_PURCHASE_PURPOSE ||
      !(await metadataSignatureValid(metadata, webhookSecret)) ||
      typeof id !== 'string' ||
      typeof session.currency !== 'string' ||
      typeof amount !== 'number' ||
      !Number.isSafeInteger(amount)
    ) {
      return ignored;
    }
    return {
      kind: 'checkout_completed',
      eventId,
      sessionId: id,
      paid: session.payment_status === 'paid',
      // Validated when the event is applied, so a bad value dead-letters
      // visibly instead of failing intake.
      currency: session.currency.toUpperCase(),
      amountSubtotal: amount,
      metadata,
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
      .filter(([key]) => key.startsWith('smrt_') && key !== SIGNATURE_KEY)
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
