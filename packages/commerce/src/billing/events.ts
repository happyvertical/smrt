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
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import {
  type BillingAccount,
  BillingAccountCollection,
  BillingLineSourceCollection,
  BillingPaymentAttemptCollection,
  BillingPeriodCloseCollection,
  type BillingStanding,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import { InvoiceStatus, PaymentMethod, PaymentStatus } from '../types/index.js';
import { CREDIT_PURCHASE_PURPOSE, creditMetadata } from './credits.js';
import {
  type AttemptTarget,
  applyPaymentAttempt,
  attemptTarget,
  decideAttempt,
} from './payment-attempts.js';
import type {
  BillingPaymentAttemptState,
  BillingProvider,
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
type AttemptEvent = Extract<BillingProviderEvent, { kind: 'payment_attempt' }>;

type ObservedEvent =
  | { event: InvoiceEvent; invoice: BillingProviderInvoiceState }
  | {
      event: SubscriptionEvent;
      subscription: BillingProviderSubscriptionState;
    }
  | { event: CheckoutEvent; providerName: string }
  | {
      event: AttemptEvent;
      providerName: string;
      attempt: BillingPaymentAttemptState;
      target: AttemptTarget;
    };

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
    providers: runtime.eventProviders,
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
      const provider = runtime.providerForNamespace(delivery.provider);
      if (
        !provider ||
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
          invoice: await provider.getInvoice(event.providerInvoiceId),
        };
      } else if (event.kind === 'subscription') {
        value = {
          event,
          subscription: await provider.getSubscription(
            event.providerSubscriptionId,
          ),
        };
      } else if (event.kind === 'checkout_completed') {
        value = { event, providerName: provider.name };
      } else if (event.kind === 'payment_attempt') {
        const observed = await observeAttempt(runtime, provider, event);
        if (!observed) return null;
        value = observed;
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
      } else if ('attempt' in value) {
        await applyAttempt(runtime, context.db, value);
      } else {
        await applyCheckout(
          runtime,
          context.db,
          value.event,
          value.providerName,
        );
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
  if (
    standing &&
    standing !== 'current' &&
    runtime.hasPaymentRails &&
    (await pauseForConfirmingAttempts(
      runtime,
      db,
      String(invoice.id),
      standing,
    ))
  ) {
    // A rail payment for this invoice is confirming (#3138): dunning pauses.
    // If the payment ends without settling, it re-applies this standing.
    standing = null;
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
  if (
    state.paidOutOfBand &&
    runtime.hasPaymentRails &&
    (await railClosedOutOfBand(runtime, db, String(invoice.id)))
  ) {
    // This rail closed the invoice at the issuer (#3138) and records the
    // payment itself in its own event; the issuer collected nothing.
    return;
  }
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
        // Closed out of band by someone else (wire, cheque): not a card.
        method: state.paidOutOfBand
          ? PaymentMethod.OTHER
          : PaymentMethod.CREDIT_CARD,
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
  providerName: string,
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
    event.amountSubtotal !== metadata.amount ||
    // Credit is granted only for money collected in full: a discounted
    // session reports the undiscounted subtotal.
    event.amountTotal !== metadata.amount
  ) {
    throw new Error(
      `Checkout ${event.sessionId} collected ${event.amountTotal} of ${event.amountSubtotal} ${event.currency}; ` +
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
      source: `${providerName}-checkout`,
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
    providerName,
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
      externalProvider: providerName,
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

// ---------------------------------------------------------------------------
// Payment-rail attempts (#3138)
// ---------------------------------------------------------------------------

async function observeAttempt(
  runtime: BillingRuntime,
  provider: BillingProvider,
  event: AttemptEvent,
): Promise<ObservedEvent | null> {
  if (!provider.getPaymentAttempt) {
    throw new Error(`Provider ${provider.name} has no payment attempts.`);
  }
  const attempt = await provider.getPaymentAttempt(event.checkoutId);
  if (!attempt) return null; // Not a checkout this rail created.
  const target = attemptTarget(runtime, attempt.metadata);
  if (!target) return null; // Unsigned, foreign, or another seller's.
  const decision = decideAttempt(attempt, runtime.paymentPolicy, target);
  if (decision.action === 'settle' && target.purpose === 'invoice_payment') {
    // Close the issuer's invoice before recording the payment, so it stops
    // dunning. Idempotent, and retried with the event on failure.
    const invoice = await withTenant(
      { tenantId: runtime.sellerTenantId },
      async () =>
        (await InvoiceCollection.create({ db: runtime.db })).get(
          target.invoiceId,
        ),
    );
    if (
      invoice?.id &&
      invoice.status !== InvoiceStatus.PAID &&
      invoice.externalProvider === runtime.provider.name &&
      invoice.externalId
    ) {
      if (!runtime.provider.markInvoicePaidOutOfBand) {
        throw new Error(
          `${runtime.provider.name} cannot close invoice ${invoice.invoiceNumber} paid on ${provider.name}.`,
        );
      }
      // Committed before the issuer is told, so the issuer's own `paid`
      // event waits for this settlement instead of recording a payment.
      const row = await runtime.recordPaymentAttemptStart({
        orderId: attempt.orderId,
        provider: provider.name,
        checkoutId: attempt.checkoutId,
        checkoutUrl: attempt.checkoutUrl ?? '',
        purpose: target.purpose,
        payerTenantId: target.payerTenantId,
        billingAccountId: target.billingAccountId,
        invoiceId: target.invoiceId,
        amount: target.amount,
        currency: target.currency,
      });
      if (!row.outOfBandRequestedAt) {
        // Column-scoped, so it cannot overwrite a concurrent writer's fields.
        await runtime.db.query(
          `UPDATE ${runtime.attempts.tableName}
              SET out_of_band_requested_at = ?
            WHERE id = ? AND out_of_band_requested_at IS NULL`,
          new Date().toISOString(),
          String(row.id),
        );
      }
      await runtime.provider.markInvoicePaidOutOfBand(invoice.externalId);
    }
  }
  return { event, providerName: provider.name, attempt, target };
}

async function applyAttempt(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  value: Extract<ObservedEvent, { attempt: BillingPaymentAttemptState }>,
): Promise<void> {
  const outcome = await applyPaymentAttempt(
    runtime,
    db,
    value.providerName,
    value.attempt,
    value.target,
    value.event.eventId.startsWith('poll:') ? 'poll' : 'webhook',
  );
  if (value.target.purpose !== 'invoice_payment') return;
  if (!outcome.settled && !outcome.endedUnsettled) return;
  const invoices = await InvoiceCollection.create({ db });
  const invoice = await withTenant({ tenantId: runtime.sellerTenantId }, () =>
    invoices.get(value.target.invoiceId),
  );
  if (!invoice?.id) return;
  const closes = await BillingPeriodCloseCollection.create({ db });
  const [close] = await closes.list({
    where: { invoiceId: invoice.id, sellerTenantId: runtime.sellerTenantId },
    limit: 1,
  });
  if (!close?.id) return;
  const accounts = await BillingAccountCollection.create({ db });
  const account = await accounts.get(close.billingAccountId);
  if (!account) return;
  if (outcome.settled && invoice.status === InvoiceStatus.PAID) {
    await applyStanding(
      runtime,
      db,
      account,
      invoice,
      String(close.id),
      'current',
    );
  } else if (outcome.endedUnsettled && invoice.status !== InvoiceStatus.PAID) {
    // The dunning paused while this payment confirmed; resume it with the
    // standing the issuer asked for meanwhile, or from the invoice's state.
    const paused = outcome.attempt.pausedStanding;
    const resumed: BillingStanding | null =
      paused === 'past_due' || paused === 'uncollectible'
        ? paused
        : invoice.status === InvoiceStatus.OVERDUE
          ? 'past_due'
          : null;
    if (resumed) {
      await applyStanding(
        runtime,
        db,
        account,
        invoice,
        String(close.id),
        resumed,
      );
    }
  }
}

const STANDING_SEVERITY: Record<string, number> = {
  '': 0,
  past_due: 1,
  uncollectible: 2,
};

/**
 * Record a paused standing on the invoice's confirming rail attempts.
 * Returns whether any attempt is confirming (and so dunning pauses).
 */
async function pauseForConfirmingAttempts(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  invoiceId: string,
  standing: BillingStanding,
): Promise<boolean> {
  const attempts = await BillingPaymentAttemptCollection.create({ db });
  // Lock before reading, so a concurrent writer's fields are not lost.
  await db.query(
    `UPDATE ${attempts.tableName} SET updated_at = updated_at
      WHERE seller_tenant_id = ? AND invoice_id = ? AND status = 'confirming'`,
    runtime.sellerTenantId,
    invoiceId,
  );
  const rows = await attempts.list({
    where: {
      sellerTenantId: runtime.sellerTenantId,
      invoiceId,
      status: 'confirming',
    },
  });
  for (const row of rows) {
    if (
      (STANDING_SEVERITY[standing] ?? 0) >
      (STANDING_SEVERITY[row.pausedStanding] ?? 0)
    ) {
      row.pausedStanding = standing;
      await row.save();
    }
  }
  return rows.length > 0;
}

/** A rail of this runtime asked the issuer to close this invoice. */
async function railClosedOutOfBand(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  invoiceId: string,
): Promise<boolean> {
  const attempts = await BillingPaymentAttemptCollection.create({ db });
  const rows = await attempts.list({
    where: { sellerTenantId: runtime.sellerTenantId, invoiceId },
  });
  return rows.some((row) => Boolean(row.outOfBandRequestedAt));
}
