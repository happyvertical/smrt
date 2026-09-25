/**
 * Payment-rail attempts (#3138): per-seller policy, settlement of a rail
 * checkout into credit or an invoice payment, and operator refund and
 * conversion journals.
 *
 * The rail's gateway decides when a checkout is settled (its confirmation
 * policy); this module never counts confirmations. It records everything the
 * rail reports on a `BillingPaymentAttempt` and settles at most once, keyed by
 * the checkout id.
 */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import { SpendingPolicyEvaluator } from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import {
  type BillingPaymentAttempt,
  BillingPaymentAttemptCollection,
  type BillingPaymentAttemptFlag,
  type BillingPaymentAttemptPurpose,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import { InvoiceStatus, PaymentMethod, PaymentStatus } from '../types/index.js';
import { CREDIT_PURCHASE_PURPOSE, creditMetadata } from './credits.js';
import {
  INVOICE_PAYMENT_PURPOSE,
  invoicePaymentMetadata,
} from './invoice-payments.js';
import type { BillingPaymentAttemptState } from './provider.js';
import type { BillingRuntime } from './runtime.js';
import { deterministicId, normalizeCurrency, tenantKey } from './units.js';

/** Per-seller rules for rail payments. Every default is conservative. */
export interface BillingPaymentPolicy {
  /**
   * Underpayment accepted as payment in full, in basis points of the price
   * (default 0). The shortfall is not written off in the ledger.
   */
  underpaymentToleranceBps: number;
  /** Overpayment not flagged for an operator, in basis points (default 0). */
  overpaymentToleranceBps: number;
  /**
   * A payment received after the rate lock expired: `review` (default)
   * flags it and settles nothing; `accept` settles when it covers the price.
   */
  latePaymentPolicy: 'review' | 'accept';
  /** Settle checkouts an operator marked paid at the rail (default false). */
  acceptManuallyMarked: boolean;
  /** Hold received crypto (default) or hand it to `conversionHandler`. */
  cryptoTreatment: 'hold' | 'convert';
  /**
   * Called after a settlement when `cryptoTreatment` is `convert`. It runs
   * inside the event transaction and may run again on retry: enqueue work
   * (for example a job) rather than calling an exchange directly.
   */
  conversionHandler?: (settlement: CryptoSettlement) => void | Promise<void>;
  /** Refund basis recorded when a refund does not name one. */
  refundBasis: 'original_native' | 'fiat_at_refund';
}

export interface CryptoSettlement {
  sellerTenantId: string;
  attemptId: string;
  paymentId: string;
  provider: string;
  amount: number;
  currency: string;
  nativeCurrency: string;
  nativeAmount: number;
  db: DatabaseInterface;
}

export function normalizePaymentPolicy(
  input: Partial<BillingPaymentPolicy> = {},
): BillingPaymentPolicy {
  const policy: BillingPaymentPolicy = {
    underpaymentToleranceBps: input.underpaymentToleranceBps ?? 0,
    overpaymentToleranceBps: input.overpaymentToleranceBps ?? 0,
    latePaymentPolicy: input.latePaymentPolicy ?? 'review',
    acceptManuallyMarked: input.acceptManuallyMarked ?? false,
    cryptoTreatment: input.cryptoTreatment ?? 'hold',
    conversionHandler: input.conversionHandler,
    refundBasis: input.refundBasis ?? 'original_native',
  };
  for (const key of [
    'underpaymentToleranceBps',
    'overpaymentToleranceBps',
  ] as const) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      throw new Error(`${key} must be an integer from 0 to 10000.`);
    }
  }
  if (!['review', 'accept'].includes(policy.latePaymentPolicy)) {
    throw new Error('latePaymentPolicy must be review or accept.');
  }
  if (!['hold', 'convert'].includes(policy.cryptoTreatment)) {
    throw new Error('cryptoTreatment must be hold or convert.');
  }
  if (policy.cryptoTreatment === 'convert' && !policy.conversionHandler) {
    throw new Error('cryptoTreatment convert requires a conversionHandler.');
  }
  if (!['original_native', 'fiat_at_refund'].includes(policy.refundBasis)) {
    throw new Error('refundBasis must be original_native or fiat_at_refund.');
  }
  return policy;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export type AttemptDecision =
  | { action: 'settle'; flag: BillingPaymentAttemptFlag }
  | { action: 'none'; flag: BillingPaymentAttemptFlag };

/**
 * What a rail checkout's state means for billing. Pure: the same state and
 * policy always decide the same way, so `observe()` and `project()` agree.
 */
export function decideAttempt(
  state: BillingPaymentAttemptState,
  policy: BillingPaymentPolicy,
  expected: { amount: number; currency: string },
): AttemptDecision {
  if (
    normalizeCurrency(state.currency) !== expected.currency ||
    state.amount !== expected.amount
  ) {
    return { action: 'none', flag: 'amount_mismatch' };
  }
  const shortfall = Math.floor(
    (expected.amount * policy.underpaymentToleranceBps) / 10_000,
  );
  const excess = Math.floor(
    (expected.amount * policy.overpaymentToleranceBps) / 10_000,
  );
  const covered = state.amountPaid >= expected.amount - shortfall;
  const over: BillingPaymentAttemptFlag =
    state.amountPaid > expected.amount + excess ? 'overpaid' : '';
  // Every counted payment must itself be settled by the rail.
  const allSettled = state.payments.every(
    (payment) => payment.status !== 'confirming',
  );

  if (state.exception === 'manually_marked') {
    return state.status === 'settled' && policy.acceptManuallyMarked
      ? { action: 'settle', flag: '' }
      : { action: 'none', flag: 'manually_marked' };
  }
  if (state.exception === 'paid_late') {
    return policy.latePaymentPolicy === 'accept' &&
      covered &&
      allSettled &&
      (state.status === 'settled' || state.status === 'expired')
      ? { action: 'settle', flag: over }
      : { action: 'none', flag: 'paid_late' };
  }
  switch (state.status) {
    case 'settled':
      return covered
        ? { action: 'settle', flag: over }
        : { action: 'none', flag: 'underpaid' };
    case 'expired':
      if (state.exception === 'underpaid' || state.amountPaid > 0) {
        // Within tolerance and settled at the rail: treat as paid in full.
        return covered && allSettled && state.amountPaid > 0
          ? { action: 'settle', flag: over }
          : { action: 'none', flag: 'underpaid' };
      }
      return { action: 'none', flag: '' };
    default:
      return { action: 'none', flag: '' };
  }
}

/** The purpose and settlement target an attempt's verified metadata names. */
export interface AttemptTarget {
  purpose: BillingPaymentAttemptPurpose;
  payerTenantId: string;
  billingAccountId: string;
  amount: number;
  currency: string;
  invoiceId: string;
  spendingPolicyId: string;
  grantedByTenantId: string;
}

/** Read the target from verified metadata; null when not this seller's. */
export function attemptTarget(
  runtime: BillingRuntime,
  metadata: Record<string, string>,
): AttemptTarget | null {
  if (metadata.smrt_purpose === CREDIT_PURCHASE_PURPOSE) {
    const credit = creditMetadata(metadata);
    if (!credit || credit.sellerTenantId !== runtime.sellerTenantId) {
      return null;
    }
    return {
      purpose: 'credit_purchase',
      payerTenantId: credit.payerTenantId,
      billingAccountId: credit.billingAccountId,
      amount: credit.amount,
      currency: credit.currency,
      invoiceId: '',
      spendingPolicyId: credit.spendingPolicyId,
      grantedByTenantId: credit.grantedByTenantId,
    };
  }
  if (metadata.smrt_purpose === INVOICE_PAYMENT_PURPOSE) {
    const invoice = invoicePaymentMetadata(metadata);
    if (!invoice || invoice.sellerTenantId !== runtime.sellerTenantId) {
      return null;
    }
    return {
      purpose: 'invoice_payment',
      payerTenantId: invoice.payerTenantId,
      billingAccountId: invoice.billingAccountId,
      amount: invoice.amount,
      currency: invoice.currency,
      invoiceId: invoice.invoiceId,
      spendingPolicyId: '',
      grantedByTenantId: '',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Applying (inside the event transaction)
// ---------------------------------------------------------------------------

export interface AttemptOutcome {
  attempt: BillingPaymentAttempt;
  /** The attempt left `confirming` without settling. */
  endedUnsettled: boolean;
  /** This application settled it. */
  settled: boolean;
}

/**
 * Record the rail's current state on the attempt and settle it once when the
 * decision says so. `invoiceHook` applies standing for invoice payments.
 */
export async function applyPaymentAttempt(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  providerName: string,
  state: BillingPaymentAttemptState,
  target: AttemptTarget,
  source: 'webhook' | 'poll',
): Promise<AttemptOutcome> {
  const attempts = await BillingPaymentAttemptCollection.create({ db });
  const id = await runtime.paymentAttemptId(providerName, state.checkoutId);
  if (target.purpose === 'invoice_payment') {
    // Invoice before attempt, as the issuer's events lock them: one order
    // for every transaction touching both.
    await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
      const invoices = await InvoiceCollection.create({ db });
      await db.query(
        `UPDATE ${invoices.tableName} SET updated_at = updated_at WHERE id = ?`,
        target.invoiceId,
      );
    });
  }
  // Lock before reading, so a concurrent writer (a refund, a paused
  // standing) is never overwritten by this full-row save.
  await lockAttempt(db, attempts.tableName, id);
  const attempt =
    (await attempts.get(id)) ??
    (await attempts.create({
      id,
      sellerTenantId: runtime.sellerTenantId,
      payerTenantId: target.payerTenantId,
      billingAccountId: target.billingAccountId,
      purpose: target.purpose,
      invoiceId: target.invoiceId,
      spendingPolicyId: target.spendingPolicyId,
      provider: providerName,
      orderId: state.orderId ?? '',
      checkoutId: state.checkoutId,
      amount: target.amount,
      currency: target.currency,
      status: 'open',
      exception: 'none',
      timeline: [],
      _insertOnly: true,
    }));
  const wasConfirming = attempt.status === 'confirming';
  if (!attempt.orderId && state.orderId) attempt.orderId = state.orderId;
  const changed =
    attempt.status !== state.status || attempt.exception !== state.exception;
  const timeline = attempt.transitions;
  if (changed || timeline.length === 0) {
    timeline.push({
      at: new Date().toISOString(),
      status: state.status,
      exception: state.exception,
      source,
    });
  }
  attempt.timeline = timeline;
  attempt.status = state.status;
  attempt.exception = state.exception;
  attempt.amountPaid = state.amountPaid;
  attempt.nativeCurrency = state.nativeCurrency ?? '';
  attempt.nativeAmountDue = state.nativeAmountDue ?? 0;
  attempt.nativeAmountPaid = state.nativeAmountPaid ?? 0;
  attempt.rate = state.rate ?? '';
  attempt.rateSource = state.rateSource ?? '';
  if (state.checkoutUrl) attempt.checkoutUrl = state.checkoutUrl;
  attempt.expiresAt = state.expiresAt ?? attempt.expiresAt;
  attempt.payments = state.payments.map((payment) => ({ ...payment }));

  const decision = decideAttempt(state, runtime.paymentPolicy, {
    amount: target.amount,
    currency: target.currency,
  });
  let settled = false;
  if (attempt.settledAt) {
    // Settled before; a later invalidation needs an operator, never an
    // automatic reversal.
    if (state.status === 'invalid')
      attempt.flag = 'invalidated_after_settlement';
    // Excess follows what the rail reports in both directions: money after
    // settlement is booked; a reversed payment (reorg, RBF) is unbooked.
    const excess = Math.max(0, state.amountPaid - target.amount);
    const delta = excess - attempt.excessAmount;
    if (delta !== 0 && attempt.paymentId) {
      const holdings =
        runtime.ledger.cryptoHoldingsAccountId || runtime.ledger.cashAccountId;
      const credit = runtime.ledger.prepaidCreditAccountId;
      await postOnce(
        runtime,
        db,
        `overpayment:${attempt.paymentId}:${attempt.excessAmount}->${excess}`,
        {
          description: `Excess on ${providerName} checkout ${state.checkoutId}: ${attempt.excessAmount} -> ${excess}`,
          entries:
            delta > 0
              ? [
                  { accountId: holdings, debit: delta },
                  { accountId: credit, credit: delta },
                ]
              : [
                  { accountId: credit, debit: -delta },
                  { accountId: holdings, credit: -delta },
                ],
        },
      );
      attempt.excessAmount = excess;
      if (delta < 0) attempt.flag = 'invalidated_after_settlement';
      else if (!attempt.flag) attempt.flag = 'overpaid';
    }
  } else if (decision.action === 'settle') {
    const result = await settleAttempt(runtime, db, attempt, state, target);
    attempt.paymentId = result.paymentId;
    attempt.creditGrantId = result.creditGrantId;
    attempt.excessAmount = result.excess;
    attempt.settledAt = new Date();
    attempt.flag = result.flag || decision.flag;
    settled = true;
  } else if (decision.flag) {
    attempt.flag = decision.flag;
  }

  // Ended without settling: it stopped confirming and this did not settle
  // it (expired, invalid, or reported settled but refused by the policy).
  let endedUnsettled =
    wasConfirming && !attempt.settledAt && state.status !== 'confirming';
  if (
    attempt.outOfBandRequestedAt &&
    !attempt.settledAt &&
    (state.status === 'expired' || state.status === 'invalid')
  ) {
    // The issuer was told the invoice was paid, but the money never settled:
    // an operator must reopen it at the issuer (then resolve this flag).
    // Standing is re-derived from the invoice either way.
    attempt.flag = 'out_of_band_without_settlement';
    endedUnsettled = true;
  }
  await attempt.save();
  if (
    settled &&
    runtime.paymentPolicy.cryptoTreatment === 'convert' &&
    runtime.paymentPolicy.conversionHandler
  ) {
    await runtime.paymentPolicy.conversionHandler({
      sellerTenantId: runtime.sellerTenantId,
      attemptId: String(attempt.id),
      paymentId: attempt.paymentId,
      provider: providerName,
      amount: target.amount,
      currency: target.currency,
      nativeCurrency: attempt.nativeCurrency,
      nativeAmount: attempt.nativeAmountPaid,
      db,
    });
  }
  return { attempt, endedUnsettled, settled };
}

async function settleAttempt(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  attempt: BillingPaymentAttempt,
  state: BillingPaymentAttemptState,
  target: AttemptTarget,
): Promise<{
  paymentId: string;
  creditGrantId: string;
  excess: number;
  flag: BillingPaymentAttemptFlag;
}> {
  const ledger = runtime.ledger;
  const holdings = ledger.cryptoHoldingsAccountId || ledger.cashAccountId;
  const txids = [
    ...new Set(
      state.payments
        .filter((payment) => payment.status === 'settled')
        .map((payment) => payment.transactionId)
        .filter((txid): txid is string => Boolean(txid)),
    ),
  ];
  const payments = await PaymentCollection.create({ db });
  const paymentId = await deterministicId([
    'billing-attempt-payment',
    attempt.provider,
    state.checkoutId,
  ]);

  let invoice: Invoice | null = null;
  let flag: BillingPaymentAttemptFlag = '';
  let receivables = ledger.prepaidCreditAccountId;
  let customerId = '';
  if (target.purpose === 'invoice_payment') {
    invoice = await withTenant(
      { tenantId: runtime.sellerTenantId },
      async () => {
        const invoices = await InvoiceCollection.create({ db });
        // Serialize settlements of one invoice: two rail payments projected
        // at once must not both read it unpaid and both allocate.
        await db.query(
          `UPDATE ${invoices.tableName} SET updated_at = updated_at WHERE id = ?`,
          target.invoiceId,
        );
        return invoices.get(target.invoiceId);
      },
    );
    if (!invoice?.id) {
      throw new Error(`Invoice ${target.invoiceId} for an attempt is missing.`);
    }
    customerId = invoice.customerId;
    if (invoice.status === InvoiceStatus.PAID) {
      // Paid elsewhere meanwhile: keep the money as customer credit for an
      // operator to refund or apply.
      flag = 'invoice_already_paid';
    } else {
      receivables = ledger.arAccountId;
    }
  } else {
    const account = await runtime.accounts.get(target.billingAccountId);
    if (
      !account ||
      tenantKey(account.sellerTenantId) !== runtime.sellerTenantId ||
      tenantKey(account.payerTenantId) !== target.payerTenantId
    ) {
      throw new Error(`Checkout ${state.checkoutId} has no matching account.`);
    }
    customerId = account.customerId;
  }

  const payment = await withTenant(
    { tenantId: runtime.sellerTenantId },
    async () => {
      const existing = await payments.get(paymentId);
      const row =
        existing ??
        (await payments.create({
          id: paymentId,
          tenantId: runtime.sellerTenantId,
          customerId,
          amount: target.amount,
          currency: target.currency,
          method: PaymentMethod.CRYPTO,
          reference:
            target.purpose === 'invoice_payment'
              ? (invoice?.invoiceNumber ?? '')
              : `credit:${target.spendingPolicyId}`,
          externalId: state.checkoutId,
          externalProvider: attempt.provider,
          backendId: (state.nativeCurrency ?? '').toLowerCase(),
          backendTxRef: txids.join(','),
          nativeAmount: state.nativeAmountPaid ?? 0,
          nativeCurrency: state.nativeCurrency ?? '',
          notes: [
            `rate ${state.rate ?? 'unknown'} ${target.currency}/${state.nativeCurrency ?? '?'}`,
            state.rateSource ? `source ${state.rateSource}` : '',
            `received ${state.amountPaid} ${target.currency} minor units`,
          ]
            .filter(Boolean)
            .join('; '),
          _insertOnly: true,
        }));
      if (row.status !== PaymentStatus.COMPLETED) {
        await row.recordPayment({
          ledgerId: '',
          cashAccountId: holdings,
          receivablesAccountId: receivables,
        });
      }
      return row;
    },
  );

  // Money above the price is the payer's: book it as customer credit (in the
  // prepaid-credit liability) for an operator to refund or apply.
  const excess = Math.max(0, state.amountPaid - target.amount);
  if (excess > 0) {
    await postOnce(runtime, db, `overpayment:${paymentId}`, {
      description: `Overpayment on ${attempt.provider} checkout ${state.checkoutId}`,
      entries: [
        { accountId: holdings, debit: excess },
        { accountId: ledger.prepaidCreditAccountId, credit: excess },
      ],
    });
  }

  let creditGrantId = '';
  if (target.purpose === 'credit_purchase') {
    const grant = await withSystemContext(async () => {
      const evaluator = await SpendingPolicyEvaluator.create({ db });
      return evaluator.grantCredit({
        spendingPolicyId: target.spendingPolicyId,
        amount: target.amount,
        reason: 'Prepaid credit purchase',
        source: `${attempt.provider}-checkout`,
        sourceId: state.checkoutId,
        ...(target.grantedByTenantId
          ? { grantedByTenantId: target.grantedByTenantId }
          : {}),
      });
    });
    creditGrantId = String(grant.id ?? '');
  } else if (invoice && flag !== 'invoice_already_paid') {
    await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
      const allocations = await PaymentAllocationCollection.create({ db });
      const already = await allocations.getTotalAllocatedToInvoice(
        String(invoice.id),
      );
      const room = Math.max(0, invoice.totalAmount - already);
      const allocationId = await deterministicId([
        'billing-attempt-allocation',
        paymentId,
        String(invoice.id),
      ]);
      if (room > 0 && !(await allocations.get(allocationId))) {
        await allocations.create({
          id: allocationId,
          tenantId: runtime.sellerTenantId,
          paymentId,
          invoiceId: String(invoice.id),
          amount: Math.min(room, target.amount),
          allocatedBy: `${attempt.provider}-checkout`,
          _insertOnly: true,
        });
      }
      invoice.updatePaymentStatus(
        await allocations.getTotalAllocatedToInvoice(String(invoice.id)),
      );
      await invoice.save();
    });
  }
  return { paymentId: String(payment.id), creditGrantId, excess, flag };
}

// ---------------------------------------------------------------------------
// Operator journals
// ---------------------------------------------------------------------------

export interface ManualRefundInput {
  /** The settled rail `Payment` refunded. */
  paymentId: string;
  /** Fiat value of the refund, minor units of the payment currency. */
  fiatAmount: number;
  /** Native amount sent back (satoshis), when known. */
  nativeAmount?: number;
  /** Default: the seller's `paymentPolicy.refundBasis`. */
  basis?: 'original_native' | 'fiat_at_refund';
  /** The operator's refund reference (for example the refund txid). */
  reference: string;
  reason: string;
}

export interface ManualRefundResult {
  journalId: string;
  creditGrantId: string;
}

/**
 * Record a refund an operator made outside billing. Refunds come from what
 * the payer is owed: first any overpayment, then — for a credit purchase, or
 * an invoice payment kept as credit because the invoice was paid elsewhere —
 * the price. An invoice payment applied to its invoice is not refundable
 * here (reverse the invoice at the issuer first). Refunds are capped
 * cumulatively per payment and are idempotent by `reference`.
 */
export async function recordManualRefund(
  runtime: BillingRuntime,
  input: ManualRefundInput,
): Promise<ManualRefundResult> {
  if (!Number.isSafeInteger(input.fiatAmount) || input.fiatAmount <= 0) {
    throw new Error('fiatAmount must be positive integer minor units.');
  }
  const reference = input.reference?.trim();
  if (!reference) throw new Error('A reference is required.');
  const basis = input.basis ?? runtime.paymentPolicy.refundBasis;
  const [found] = await runtime.attempts.list({
    where: {
      sellerTenantId: runtime.sellerTenantId,
      paymentId: input.paymentId,
    },
    limit: 1,
  });
  if (!found?.id) {
    throw new Error(
      `Payment ${input.paymentId} is not a settled payment-rail payment of this seller.`,
    );
  }
  const inTransaction = <T>(work: (db: DatabaseInterface) => Promise<T>) =>
    runtime.db.transaction ? runtime.db.transaction(work) : work(runtime.db);
  return withSystemContext(() =>
    inTransaction(async (db) => {
      const attempts = await BillingPaymentAttemptCollection.create({ db });
      // Serialize refunds of one payment: the cumulative cap reads, then writes.
      await lockAttempt(db, attempts.tableName, String(found.id));
      const attempt = await attempts.get(String(found.id));
      if (!attempt?.id || !attempt.settledAt) {
        throw new Error(
          `Payment ${input.paymentId} is not a settled payment-rail payment of this seller.`,
        );
      }
      const done = attempt.refundRecords.find(
        (record) => record.reference === reference,
      );
      if (done) {
        return {
          journalId: String(done.journalId ?? ''),
          creditGrantId: String(done.creditGrantId ?? ''),
        };
      }
      const principalRefundable =
        attempt.purpose === 'credit_purchase' ||
        attempt.flag === 'invoice_already_paid'
          ? attempt.amount
          : 0;
      const refundedExcess = attempt.refundedAmount - attempt.refundedPrincipal;
      const excessLeft = attempt.excessAmount - refundedExcess;
      const principalLeft = principalRefundable - attempt.refundedPrincipal;
      if (input.fiatAmount > excessLeft + principalLeft) {
        throw new Error(
          `A refund of ${input.fiatAmount} would exceed the ${excessLeft + principalLeft} ${attempt.currency} still refundable on this payment.`,
        );
      }
      const fromExcess = Math.min(input.fiatAmount, excessLeft);
      const fromPrincipal = input.fiatAmount - fromExcess;
      const ledger = runtime.ledger;
      const holdings = ledger.cryptoHoldingsAccountId || ledger.cashAccountId;
      const journalId = await postOnce(
        runtime,
        db,
        `refund:${attempt.id}:${reference}`,
        {
          description: `Refund ${reference} (${basis}${
            input.nativeAmount ? `, ${input.nativeAmount} native` : ''
          }): ${input.reason}`,
          entries: [
            // Excess and credit kept for an already-paid invoice both sit in
            // the prepaid-credit liability, as does purchased credit.
            {
              accountId: ledger.prepaidCreditAccountId,
              debit: input.fiatAmount,
            },
            { accountId: holdings, credit: input.fiatAmount },
          ],
        },
      );
      let creditGrantId = '';
      if (
        fromPrincipal > 0 &&
        attempt.purpose === 'credit_purchase' &&
        attempt.spendingPolicyId
      ) {
        const grant = await (
          await SpendingPolicyEvaluator.create({ db })
        ).grantCredit({
          spendingPolicyId: attempt.spendingPolicyId,
          amount: -fromPrincipal,
          reason: `Refund: ${input.reason}`,
          source: `${attempt.provider}-refund`,
          sourceId: reference,
        });
        creditGrantId = String(grant.id ?? '');
      }
      const refunds = attempt.refundRecords;
      refunds.push({
        reference,
        amount: input.fiatAmount,
        principal: fromPrincipal,
        nativeAmount: input.nativeAmount ?? null,
        basis,
        reason: input.reason,
        journalId,
        creditGrantId,
        at: new Date().toISOString(),
      });
      attempt.refunds = refunds;
      attempt.refundedAmount += input.fiatAmount;
      attempt.refundedPrincipal += fromPrincipal;
      attempt.resolution = [
        attempt.resolution,
        `refunded ${input.fiatAmount} ${attempt.currency} (${basis}) ref ${reference}`,
      ]
        .filter(Boolean)
        .join('; ');
      attempt.resolvedAt = new Date();
      await attempt.save();
      return { journalId, creditGrantId };
    }),
  );
}

export interface CryptoConversionInput {
  /** Operator reference (for example the exchange trade id). */
  reference: string;
  currency: string;
  nativeCurrency: string;
  /** Native amount converted (satoshis). */
  nativeAmount: number;
  /** Book value of the converted holdings, minor units of `currency`. */
  carryingValue: number;
  /** Cash received, minor units. */
  proceeds: number;
  /** Fees paid, minor units (default 0). */
  fees?: number;
}

export async function recordCryptoConversion(
  runtime: BillingRuntime,
  input: CryptoConversionInput,
): Promise<{ journalId: string }> {
  const ledger = runtime.ledger;
  if (!ledger.cryptoHoldingsAccountId || !ledger.fxGainLossAccountId) {
    throw new Error(
      'Conversions need cryptoHoldingsAccountId and fxGainLossAccountId ledger accounts.',
    );
  }
  const fees = input.fees ?? 0;
  for (const [key, value] of Object.entries({
    nativeAmount: input.nativeAmount,
    carryingValue: input.carryingValue,
    proceeds: input.proceeds,
    fees,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${key} must be non-negative integer minor units.`);
    }
  }
  if (fees > 0 && !ledger.feesAccountId) {
    throw new Error('Conversion fees need a feesAccountId ledger account.');
  }
  if (!input.reference?.trim()) throw new Error('A reference is required.');
  const gain = input.proceeds + fees - input.carryingValue;
  const entries: JournalLine[] = [
    { accountId: ledger.cashAccountId, debit: input.proceeds },
    { accountId: ledger.cryptoHoldingsAccountId, credit: input.carryingValue },
  ];
  if (fees > 0 && ledger.feesAccountId) {
    entries.push({ accountId: ledger.feesAccountId, debit: fees });
  }
  if (gain > 0) {
    entries.push({ accountId: ledger.fxGainLossAccountId, credit: gain });
  } else if (gain < 0) {
    entries.push({ accountId: ledger.fxGainLossAccountId, debit: -gain });
  }
  const journalId = await postOnce(
    runtime,
    runtime.db,
    `conversion:${input.reference.trim()}`,
    {
      description: `Convert ${input.nativeAmount} ${normalizeCurrency(
        input.nativeCurrency,
      )} minor units to ${normalizeCurrency(input.currency)} (${input.reference})`,
      entries: entries.filter(
        (entry) => (entry.debit ?? 0) > 0 || (entry.credit ?? 0) > 0,
      ),
    },
  );
  return { journalId };
}

async function lockAttempt(
  db: DatabaseInterface,
  tableName: string,
  id: string,
): Promise<void> {
  await db.query(
    `UPDATE ${tableName} SET updated_at = updated_at WHERE id = ?`,
    id,
  );
}

interface JournalLine {
  accountId: string;
  debit?: number;
  credit?: number;
}

/** Post a balanced journal once per `sourceRef` in the seller's books. */
async function postOnce(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  sourceRef: string,
  journal: { description: string; entries: JournalLine[] },
): Promise<string> {
  return withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    const journals = await JournalCollection.create({ db });
    const [posted] = await journals.list({
      where: { sourceModule: 'smrt-commerce', sourceRef, status: 'posted' },
      limit: 1,
    });
    if (posted?.id) return String(posted.id);
    const created = await journals.create({
      date: new Date(),
      description: journal.description,
      sourceModule: 'smrt-commerce',
      sourceRef,
    });
    await created.save();
    for (const entry of journal.entries) {
      await created.addEntry({ ...entry, memo: sourceRef });
    }
    await created.post();
    return String(created.id);
  });
}
