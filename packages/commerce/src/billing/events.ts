/**
 * Provider event processing (#3060): verified webhook deliveries queued in
 * smrt-jobs' durable delivery inbox are applied here.
 *
 * `observe()` re-reads the invoice or subscription from the provider, so an
 * event is applied against current provider state rather than the snapshot it
 * carried; out-of-order and duplicate deliveries therefore converge. The
 * application writes, the inbox completion, and the host standing hook share
 * one transaction.
 */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  type ForgeDelivery,
  type ForgeObservation,
  type ForgeProjectionContext,
  ForgeProjectionRuntime,
  type ForgeProjector,
} from '@happyvertical/smrt-jobs';
import {
  SpendingPolicyEvaluator,
  type SubscriptionStatus,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import {
  type BillingAccount,
  BillingAccountCollection,
  BillingLineSourceCollection,
  BillingPeriodCloseCollection,
  type BillingStanding,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import { InvoiceStatus, PaymentMethod, PaymentStatus } from '../types/index.js';
import { CREDIT_PURCHASE_PURPOSE, creditMetadata } from './credits.js';
import type {
  BillingProviderEvent,
  BillingProviderInvoiceState,
  BillingProviderSubscriptionState,
} from './provider.js';
import type { BillingRuntime } from './runtime.js';
import {
  currencyMinorUnitExponent,
  deterministicId,
  normalizeCurrency,
  tenantKey,
} from './units.js';

type InvoiceEvent = Extract<BillingProviderEvent, { kind: 'invoice' }>;
type SubscriptionEvent = Extract<
  BillingProviderEvent,
  { kind: 'subscription' }
>;
type CheckoutEvent = Extract<
  BillingProviderEvent,
  { kind: 'checkout_completed' }
>;

type ObservedEvent =
  | { event: InvoiceEvent; invoice: BillingProviderInvoiceState }
  | {
      event: SubscriptionEvent;
      subscription: BillingProviderSubscriptionState;
    }
  | { event: CheckoutEvent };

const PROJECTION = 'billing-provider-events';

/** Apply up to `limit` queued events for a runtime; returns how many ran. */
export async function processBillingEvents(
  runtime: BillingRuntime,
  limit: number,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('limit must be a positive integer.');
  }
  const processor = new ForgeProjectionRuntime({
    db: runtime.db,
    workerId: `billing-${crypto.randomUUID()}`,
    providers: [runtime.eventProvider],
    leaseMs: 60_000,
  });
  const projector = createBillingEventProjector(runtime);
  let processed = 0;
  while (processed < limit) {
    const delivery = await processor.processNext(projector);
    if (!delivery) break;
    processed += 1;
  }
  return processed;
}

export function createBillingEventProjector(
  runtime: BillingRuntime,
): ForgeProjector<ObservedEvent> {
  return {
    async observe(
      delivery: ForgeDelivery,
    ): Promise<ForgeObservation<ObservedEvent> | null> {
      // The claim is filtered to this seller's namespace; anything else is
      // released for retry rather than acknowledged as if it were applied.
      if (
        delivery.provider !== runtime.eventProvider ||
        tenantKey(delivery.tenantId) !== runtime.sellerTenantId
      ) {
        throw new Error(
          `Billing delivery ${delivery.deliveryId} belongs to another seller.`,
        );
      }
      const event = readEvent(delivery);
      let value: ObservedEvent;
      if (event.kind === 'invoice') {
        value = {
          event,
          invoice: await runtime.provider.getInvoice(event.providerInvoiceId),
        };
      } else if (event.kind === 'subscription') {
        value = {
          event,
          subscription: await runtime.provider.getSubscription(
            event.providerSubscriptionId,
          ),
        };
      } else if (event.kind === 'checkout_completed') {
        value = { event };
      } else {
        return null;
      }
      // Each event is its own subject: provider state is re-read above, so
      // ordering is resolved by the state, not by a version counter.
      return {
        projection: PROJECTION,
        subjectKey: event.eventId,
        version: 1,
        value,
      };
    },

    async project(
      observation: ForgeObservation<ObservedEvent>,
      context: ForgeProjectionContext,
    ): Promise<void> {
      const value = observation.value;
      if ('invoice' in value) {
        await applyInvoiceEvent(
          runtime,
          context.db,
          value.event,
          value.invoice,
        );
      } else if ('subscription' in value) {
        await applySubscriptionState(runtime, context.db, value.subscription);
      } else {
        await applyCheckout(runtime, context.db, value.event);
      }
    },
  };
}

function readEvent(delivery: ForgeDelivery): BillingProviderEvent {
  const event = (delivery.payload as { event?: BillingProviderEvent }).event;
  if (!event || typeof event !== 'object' || !event.kind || !event.eventId) {
    throw new Error(`Billing delivery ${delivery.deliveryId} has no event.`);
  }
  return event;
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

async function applyInvoiceEvent(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  event: InvoiceEvent,
  state: BillingProviderInvoiceState,
): Promise<void> {
  const invoices = await InvoiceCollection.create({ db });
  const invoice = await invoices.findByExternalId(state.providerInvoiceId);
  if (!invoice?.id || invoice.externalProvider !== runtime.provider.name) {
    return; // Not an invoice this runtime issued.
  }
  const closes = await BillingPeriodCloseCollection.create({ db });
  const [close] = await closes.list({
    where: { invoiceId: invoice.id, sellerTenantId: runtime.sellerTenantId },
    limit: 1,
  });
  if (!close?.id) return;
  const accounts = await BillingAccountCollection.create({ db });
  const account = await accounts.get(close.billingAccountId);
  if (!account) {
    throw new Error(`Billing account ${close.billingAccountId} is missing.`);
  }

  let standing: BillingStanding | null = null;
  if (state.status === 'paid') {
    await settlePaidInvoice(runtime, db, invoice, state);
    standing = 'current';
  } else if (state.status === 'void') {
    if (
      invoice.status !== InvoiceStatus.PAID &&
      invoice.status !== InvoiceStatus.CANCELLED
    ) {
      invoice.cancel();
      await invoice.save();
    }
  } else if (state.status === 'open') {
    if (event.type === 'payment_failed' || event.type === 'overdue') {
      standing = 'past_due';
      if (
        event.type === 'overdue' &&
        (invoice.status === InvoiceStatus.SENT ||
          invoice.status === InvoiceStatus.VIEWED)
      ) {
        invoice.status = InvoiceStatus.OVERDUE;
        await invoice.save();
      }
    } else if (event.type === 'uncollectible') {
      standing = 'uncollectible';
    }
  }
  if (standing) {
    await applyStanding(
      runtime,
      db,
      account,
      invoice,
      String(close.id),
      standing,
    );
  }
}

async function settlePaidInvoice(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  invoice: Invoice,
  state: BillingProviderInvoiceState,
): Promise<void> {
  if (invoice.status === InvoiceStatus.PAID) return;
  if (invoice.status === InvoiceStatus.DRAFT) {
    // Period close has not recorded the send yet; retry after it has.
    throw new Error(
      `Invoice ${invoice.invoiceNumber} is still a draft; the paid event will be retried.`,
    );
  }
  if (
    state.currency !== normalizeCurrency(invoice.currency) ||
    state.total !== invoice.totalAmount ||
    state.amountPaid !== state.total
  ) {
    throw new Error(
      `Provider invoice ${state.providerInvoiceId} paid ${state.amountPaid} of ${state.total} ${state.currency}; ` +
        `local invoice ${invoice.invoiceNumber} totals ${invoice.totalAmount} ${invoice.currency}.`,
    );
  }
  const allocations = await PaymentAllocationCollection.create({ db });
  if (state.amountPaid > 0) {
    const payments = await PaymentCollection.create({ db });
    const paymentId = await deterministicId([
      'billing-invoice-payment',
      runtime.provider.name,
      state.providerInvoiceId,
    ]);
    const payment =
      (await payments.get(paymentId)) ??
      (await payments.create({
        id: paymentId,
        tenantId: runtime.sellerTenantId,
        customerId: invoice.customerId,
        amount: state.amountPaid,
        currency: invoice.currency,
        method: PaymentMethod.CREDIT_CARD,
        reference: invoice.invoiceNumber,
        externalId: state.providerInvoiceId,
        externalProvider: runtime.provider.name,
        _insertOnly: true,
      }));
    if (payment.status !== PaymentStatus.COMPLETED) {
      await payment.recordPayment({
        ledgerId: '',
        cashAccountId: runtime.ledger.cashAccountId,
        receivablesAccountId: runtime.ledger.arAccountId,
      });
    }
    const allocationId = await deterministicId([
      'billing-invoice-allocation',
      paymentId,
      String(invoice.id),
    ]);
    if (!(await allocations.get(allocationId))) {
      await allocations.create({
        id: allocationId,
        tenantId: runtime.sellerTenantId,
        paymentId,
        invoiceId: String(invoice.id),
        amount: state.amountPaid,
        allocatedBy: 'billing-period-close',
        _insertOnly: true,
      });
    }
  }
  invoice.updatePaymentStatus(
    await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
  );
  await invoice.save();
}

const DELINQUENT_TARGET: Record<
  BillingStanding,
  (status: SubscriptionStatus) => SubscriptionStatus | null
> = {
  current: (status) =>
    status === 'past_due' || status === 'unpaid' ? 'active' : null,
  past_due: (status) => (status === 'active' ? 'past_due' : null),
  uncollectible: (status) =>
    status === 'active' || status === 'past_due' ? 'unpaid' : null,
};

async function applyStanding(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  account: BillingAccount,
  invoice: Invoice,
  closeId: string,
  standing: BillingStanding,
): Promise<void> {
  if (standing === 'current') {
    // Another unpaid, overdue invoice keeps the payer past due.
    const invoices = await InvoiceCollection.create({ db });
    const overdue = await invoices.list({
      where: { customerId: invoice.customerId, status: InvoiceStatus.OVERDUE },
    });
    if (overdue.some((row) => row.id !== invoice.id)) standing = 'past_due';
  }

  // Flat-plan subscriptions billed on this invoice follow the payer's standing.
  const sources = await BillingLineSourceCollection.create({ db });
  const rows = await sources.list({
    where: { periodCloseId: closeId, sourceType: 'subscription_period' },
  });
  const subscriptionIds = [
    ...new Set(rows.map((row) => row.sourceId.split(':')[0])),
  ].filter(Boolean);
  if (subscriptionIds.length > 0) {
    await withSystemContext(async () => {
      const subscriptions = await TenantSubscriptionCollection.create({ db });
      for (const subscription of await subscriptions.list({
        where: { id: subscriptionIds },
      })) {
        const target = DELINQUENT_TARGET[standing](subscription.status);
        if (target) {
          subscription.status = target;
          await subscription.save();
        }
      }
    });
  }

  const previous = account.standing;
  if (previous === standing) return;
  account.standing = standing;
  await account.save();
  await runtime.onPayerStanding?.({
    sellerTenantId: runtime.sellerTenantId,
    payerTenantId: account.payerTenantId,
    billingAccountId: String(account.id),
    invoiceId: String(invoice.id),
    previous,
    standing,
    db,
  });
}

// ---------------------------------------------------------------------------
// Provider-managed subscriptions
// ---------------------------------------------------------------------------

async function applySubscriptionState(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  state: BillingProviderSubscriptionState,
): Promise<void> {
  await withSystemContext(async () => {
    const subscriptions = await TenantSubscriptionCollection.create({ db });
    const rows = await subscriptions.list({
      where: {
        stripeSubscriptionId: state.providerSubscriptionId,
        externalProvider: runtime.provider.name,
      },
    });
    for (const subscription of rows) {
      subscription.status = state.status;
      subscription.cancelAtPeriodEnd = state.cancelAtPeriodEnd;
      if (state.currentPeriodStart)
        subscription.currentPeriodStart = state.currentPeriodStart;
      if (state.currentPeriodEnd)
        subscription.currentPeriodEnd = state.currentPeriodEnd;
      subscription.canceledAt = state.canceledAt ?? null;
      subscription.trialEndsAt = state.trialEndsAt ?? null;
      await subscription.save();
    }
  });
}

// ---------------------------------------------------------------------------
// Prepaid credit purchases
// ---------------------------------------------------------------------------

async function applyCheckout(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  event: CheckoutEvent,
): Promise<void> {
  const metadata = creditMetadata(event.metadata);
  if (!metadata || metadata.purpose !== CREDIT_PURCHASE_PURPOSE) return;
  if (metadata.sellerTenantId !== runtime.sellerTenantId) return;
  if (!event.paid) return; // An async payment settles on a later event.
  if (currencyMinorUnitExponent(event.currency) !== 2) {
    throw new Error(
      `Checkout ${event.sessionId} is in ${event.currency}; credit purchases are two-decimal only.`,
    );
  }
  if (
    event.currency !== metadata.currency ||
    event.amountSubtotal !== metadata.amount
  ) {
    throw new Error(
      `Checkout ${event.sessionId} collected ${event.amountSubtotal} ${event.currency}; ` +
        `expected ${metadata.amount} ${metadata.currency}.`,
    );
  }

  // The credit lands on the payer-owned (or child-owned) balance policy.
  await withSystemContext(async () => {
    const evaluator = await SpendingPolicyEvaluator.create({ db });
    await evaluator.grantCredit({
      spendingPolicyId: metadata.spendingPolicyId,
      amount: metadata.amount,
      reason: 'Prepaid credit purchase',
      source: `${runtime.provider.name}-checkout`,
      sourceId: event.sessionId,
      ...(metadata.grantedByTenantId
        ? { grantedByTenantId: metadata.grantedByTenantId }
        : {}),
    });
  });

  // The cash is recorded in the seller's books against prepaid credit.
  const accounts = await BillingAccountCollection.create({ db });
  const account = await accounts.get(metadata.billingAccountId);
  if (
    !account ||
    tenantKey(account.sellerTenantId) !== runtime.sellerTenantId ||
    tenantKey(account.payerTenantId) !== metadata.payerTenantId
  ) {
    throw new Error(`Checkout ${event.sessionId} has no matching account.`);
  }
  const payments = await PaymentCollection.create({ db });
  const paymentId = await deterministicId([
    'billing-credit-payment',
    runtime.provider.name,
    event.sessionId,
  ]);
  const payment =
    (await payments.get(paymentId)) ??
    (await payments.create({
      id: paymentId,
      tenantId: runtime.sellerTenantId,
      customerId: account.customerId,
      amount: metadata.amount,
      currency: metadata.currency,
      method: PaymentMethod.CREDIT_CARD,
      reference: `credit:${metadata.spendingPolicyId}`,
      externalId: event.sessionId,
      externalProvider: runtime.provider.name,
      _insertOnly: true,
    }));
  if (payment.status !== PaymentStatus.COMPLETED) {
    await payment.recordPayment({
      ledgerId: '',
      cashAccountId: runtime.ledger.cashAccountId,
      receivablesAccountId: runtime.ledger.prepaidCreditAccountId,
    });
  }
}
