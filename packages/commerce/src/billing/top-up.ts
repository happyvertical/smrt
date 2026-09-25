/**
 * Automatic prepaid-credit top-ups through an off-session charge of the
 * payer's saved payment method (#3139).
 *
 * smrt-subscriptions' `SpendingPolicyEvaluator` calls an `autoTopUp` hook
 * when a pending charge would exhaust a balance policy; it never calls a
 * payment provider itself. {@link createAutoTopUpHook} is that hook for a
 * {@link BillingRuntime} whose provider can charge a saved method.
 *
 * Exactly once:
 * - Each attempt is a `PENDING` commerce `Payment` in the seller's books whose
 *   id is derived from the policy and the attempt's sequence number, inserted
 *   before the provider is called. Two evaluations racing for the same top-up
 *   derive the same id; only one insert wins, and only the winner charges.
 * - The charge's idempotency key is derived from that payment id, so a retry
 *   (a re-drive of an unsettled attempt) returns the original charge.
 * - The credit grant is keyed by the charge key, so the synchronous result and
 *   the provider's later `payment` webhook credit the balance once.
 */
import { isUniqueViolationError } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  type AutoTopUpGrant,
  type AutoTopUpHook,
  type AutoTopUpRequest,
  SpendingPolicyEvaluator,
} from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import type { Payment } from '../models/Payment.js';
import { PaymentMethod, PaymentStatus } from '../types/index.js';
import { defaultCardFor } from './cards.js';
import type { BillingChargeStatus } from './provider.js';
import type { BillingRuntime } from './runtime.js';
import {
  canonicalTenantId,
  deterministicId,
  normalizeCurrency,
  tenantKey,
} from './units.js';

/** Prefix of every auto top-up charge key (the provider idempotency key). */
export const AUTO_TOP_UP_CHARGE_PREFIX = 'smrt-auto-top-up:';
/** `Payment.reference` of an auto top-up attempt: prefix + policy id. */
export const AUTO_TOP_UP_REFERENCE_PREFIX = 'auto-top-up:';

const DEFAULT_RETRY_AFTER_MS = 60 * 60 * 1000;
const DEFAULT_RECHECK_AFTER_MS = 60 * 1000;

/** A top-up charge that did not succeed. Nothing was credited. */
export interface AutoTopUpFailure {
  sellerTenantId: string;
  payerTenantId: string;
  spendingPolicyId: string;
  /** The attempt's commerce `Payment` id. */
  paymentId: string;
  /**
   * `requires_action`: the issuer wants the payer present (re-save the card
   * with a card setup checkout); `failed`: declined or no usable card;
   * `canceled`: the provider canceled it.
   */
  status: Exclude<BillingChargeStatus, 'succeeded' | 'processing'>;
  failureCode?: string;
  amount: number;
  currency: string;
  /**
   * The settlement transaction. Host writes through it commit or roll back
   * with the attempt's closing.
   */
  db: DatabaseInterface;
}

/**
 * Host hook for a failed top-up, for example to ask the payer to update their
 * card. It runs inside the transaction that closes the attempt, once per
 * attempt, but may run again if that transaction is retried, so it must be
 * idempotent.
 */
export type AutoTopUpFailureHook = (
  failure: AutoTopUpFailure,
) => void | Promise<void>;

export interface AutoTopUpHookOptions {
  /**
   * How much to charge, in integer minor units of the policy currency.
   * Default: the request's shortfall, recomputed against the current balance. Return 0 or nothing to skip the top-up
   * (the policy's own behavior then applies).
   */
  amount?: (
    request: AutoTopUpRequest,
  ) => number | null | undefined | Promise<number | null | undefined>;
  /**
   * After a failed charge, wait this long before charging the policy again
   * (default one hour), so a declined card is not retried on every request.
   */
  retryAfterMs?: number;
  /**
   * An attempt still `processing` (or interrupted before its outcome was
   * saved) is re-read from the provider at most this often (default one
   * minute); its outcome also arrives as a `payment` webhook.
   */
  recheckAfterMs?: number;
  /** Charge description shown to the payer where supported. */
  description?: string;
  /**
   * A payer whose account is taxed (`automaticTax`, not tax-exempt) is not
   * topped up by default (`'skip'`): an off-session charge carries no
   * provider-calculated tax, while a checkout purchase of the same credit
   * does. `'charge_untaxed'` charges them without tax, for sellers that
   * account for tax on this credit elsewhere.
   */
  taxedAccounts?: 'skip' | 'charge_untaxed';
}

/** The outcome of a charge, from the provider's result or its webhook. */
export interface AutoTopUpChargeOutcome {
  status: BillingChargeStatus;
  providerPaymentId?: string;
  providerCustomerId?: string;
  /** Minor units, when reported. */
  amount?: number;
  currency?: string;
  failureCode?: string;
}

export function autoTopUpChargeKey(paymentId: string): string {
  return `${AUTO_TOP_UP_CHARGE_PREFIX}${paymentId}`;
}

/** The attempt payment id in a charge key, or null for any other key. */
export function autoTopUpPaymentId(chargeKey: string): string | null {
  if (!chargeKey.startsWith(AUTO_TOP_UP_CHARGE_PREFIX)) return null;
  return chargeKey.slice(AUTO_TOP_UP_CHARGE_PREFIX.length) || null;
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Auto top-up intervals must be non-negative numbers.');
  }
  return value;
}

/**
 * Build the `autoTopUp` hook for `SpendingPolicyEvaluator.create()`.
 *
 * The hook returns a grant only when the charge `succeeded`. A `processing`
 * charge returns nothing now and is credited when its `payment` webhook is
 * processed; `requires_action`, `failed`, and `canceled` credit nothing. A
 * provider without `chargeSavedPaymentMethod` (a push-payment rail) never
 * tops up. Provider errors other than a charge outcome propagate.
 */
export function createAutoTopUpHook(
  runtime: BillingRuntime,
  options: AutoTopUpHookOptions = {},
): AutoTopUpHook {
  const retryAfterMs = positiveMs(options.retryAfterMs, DEFAULT_RETRY_AFTER_MS);
  const recheckAfterMs = positiveMs(
    options.recheckAfterMs,
    DEFAULT_RECHECK_AFTER_MS,
  );
  return async (request) => {
    const charge = runtime.provider.chargeSavedPaymentMethod;
    if (!charge) return null;
    const attempt = await withSystemContext(() =>
      claimAttempt(runtime, request, options, retryAfterMs, recheckAfterMs),
    );
    if (!attempt) return null;
    const { payment, payerTenantId, providerCustomerId } = attempt;
    const paymentId = String(payment.id);
    const result = await charge.call(runtime.provider, {
      providerCustomerId,
      amount: payment.amount,
      currency: payment.currency,
      idempotencyKey: autoTopUpChargeKey(paymentId),
      description: options.description || 'Prepaid credit top-up',
      metadata: {
        smrt_purpose: 'auto_top_up',
        smrt_seller: runtime.sellerTenantId,
        smrt_payer: payerTenantId,
        smrt_policy: request.policyId,
      },
    });
    const outcome: AutoTopUpChargeOutcome = {
      status: result.status,
      providerPaymentId: result.providerPaymentId,
      providerCustomerId,
      amount: result.amount,
      currency: result.currency,
      failureCode: result.failureCode,
    };
    // Settle in the seller's books, like event processing does.
    const settled = await withTenant({ tenantId: runtime.sellerTenantId }, () =>
      inTransaction(runtime.db, (tx) =>
        applyAutoTopUpOutcome(runtime, tx, paymentId, outcome),
      ),
    );
    return settled.grant;
  };
}

interface ClaimedAttempt {
  payment: Payment;
  payerTenantId: string;
  providerCustomerId: string;
}

async function claimAttempt(
  runtime: BillingRuntime,
  request: AutoTopUpRequest,
  options: AutoTopUpHookOptions,
  retryAfterMs: number,
  recheckAfterMs: number,
): Promise<ClaimedAttempt | null> {
  const policy = await runtime.policies.get(request.policyId);
  if (!policy?.id || policy.period !== 'balance' || !policy.active) {
    return null;
  }
  const currency = normalizeCurrency(policy.currency);
  if (normalizeCurrency(request.currency) !== currency) return null;
  // A delegated balance is funded only by the parent that set it.
  const payerTenantId = canonicalTenantId(
    tenantKey(policy.setByTenantId) || String(policy.tenantId),
    'payerTenantId',
  );
  const account = await runtime.getAccount(payerTenantId);
  if (
    !account?.id ||
    account.provider !== runtime.provider.name ||
    !account.providerCustomerId
  ) {
    return null; // No provider customer, so no saved card to charge.
  }
  const providerCustomerId = account.providerCustomerId;
  const payments = await PaymentCollection.create({ db: runtime.db });
  const where = {
    tenantId: runtime.sellerTenantId,
    reference: `${AUTO_TOP_UP_REFERENCE_PREFIX}${policy.id}`,
    externalProvider: runtime.provider.name,
  };
  // Attempts are numbered 0, 1, 2, … and a number is inserted only after the
  // count reached it (rows are never deleted), so the count is the next
  // number and the previous attempt is `sequence - 1`. Everything below is
  // decided from that one read: two evaluations that read the same count
  // derive the same id and only one insert wins; one that reads a later
  // count sees the earlier attempt.
  const attemptId = (sequence: number) =>
    deterministicId([
      'billing-auto-top-up',
      runtime.provider.name,
      runtime.sellerTenantId,
      String(policy.id),
      String(sequence),
    ]);
  const sequence = await payments.count({ where });
  const latest =
    sequence > 0 ? await payments.get(await attemptId(sequence - 1)) : null;
  if (sequence > 0 && !latest) {
    throw new Error(`Auto top-up attempt ${sequence - 1} is missing.`);
  }
  const now = Date.now();
  if (latest?.status === PaymentStatus.PENDING) {
    // One live attempt per policy: re-drive it (same key, same amount) only
    // when it has not been checked recently.
    if (now - timeOf(latest) < recheckAfterMs) return null;
    return { payment: latest, payerTenantId, providerCustomerId };
  }
  if (
    latest?.status === PaymentStatus.FAILED &&
    now - timeOf(latest) < retryAfterMs
  ) {
    return null;
  }

  // New charges only (an attempt already charged is still re-driven above):
  // no tax on an off-session charge, so a taxed account is never silently
  // charged untaxed.
  if (
    options.taxedAccounts !== 'charge_untaxed' &&
    (await runtime.accountIsTaxed(account))
  ) {
    return null;
  }
  // Only a payer with a card on file is charged (no failed attempt per
  // shortfall for payers who never saved one).
  if (!(await defaultCardFor(runtime, account, providerCustomerId))) {
    return null;
  }
  // Another evaluation may have topped the balance up since this one read it
  // (its attempt is completed, so its grant is visible): recompute.
  const shortfall = request.currentShortfall
    ? await request.currentShortfall()
    : request.shortfall;
  if (shortfall <= 0) return null;
  const current = { ...request, shortfall };
  const requested = options.amount ? await options.amount(current) : shortfall;
  if (!requested) return null;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new Error('Auto top-up amount must be positive integer minor units.');
  }
  const id = await attemptId(sequence);
  try {
    const payment = await payments.create({
      id,
      tenantId: runtime.sellerTenantId,
      customerId: account.customerId,
      amount: requested,
      currency,
      method: PaymentMethod.CREDIT_CARD,
      status: PaymentStatus.PENDING,
      reference: where.reference,
      externalProvider: runtime.provider.name,
      backendId: runtime.provider.name,
      notes: `attempt ${sequence}`,
      _insertOnly: true,
    });
    return { payment, payerTenantId, providerCustomerId };
  } catch (error) {
    // Another evaluation claimed this attempt and is charging it.
    if (isUniqueViolationError(error) || (await payments.get(id))) return null;
    throw error;
  }
}

function inTransaction<T>(
  db: DatabaseInterface,
  operation: (tx: DatabaseInterface) => Promise<T>,
): Promise<T> {
  if (!db.transaction) {
    throw new Error(
      'Auto top-up requires a database adapter with transaction().',
    );
  }
  let result: T | undefined;
  return db
    .transaction(async (tx) => {
      result = await operation(tx);
    })
    .then(() => result as T);
}

function timeOf(payment: Payment): number {
  const at = payment.updated_at ?? payment.created_at;
  return at instanceof Date ? at.getTime() : new Date(String(at)).getTime();
}

/**
 * Apply a charge outcome to its attempt: credit and record the payment when it
 * succeeded, close the attempt when it failed. Idempotent, and safe to run
 * concurrently from the hook and the `payment` webhook: `db` must be a
 * transaction (the event transaction, or one the hook opens), and the first
 * statement takes the attempt's row lock with a conditional update, so only
 * one caller settles a pending attempt and the rest see it settled. Runs in
 * the seller's tenant context (payments and journals are the seller's).
 */
export async function applyAutoTopUpOutcome(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  paymentId: string,
  outcome: AutoTopUpChargeOutcome,
): Promise<{ grant: AutoTopUpGrant | null }> {
  const payments = await PaymentCollection.create({ db });
  // Lock a pending attempt for this transaction. A concurrent settler blocks
  // here until this one commits, then matches nothing (PostgreSQL re-checks
  // the status); SQLite serializes the transactions.
  // Reviewed raw SQL on a tenant-scoped table: filtered to the seller's
  // tenant by hand, and routed through the collection so its cache is busted.
  const locked = await payments.query(
    `UPDATE ${payments.tableName}
        SET updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = ?
      RETURNING id`,
    [
      new Date().toISOString(),
      paymentId,
      runtime.sellerTenantId,
      PaymentStatus.PENDING,
    ],
    { allowRawOnTenantScoped: true },
  );
  const pending = locked.length === 1;
  const payment = await payments.get(paymentId);
  if (
    !payment?.id ||
    tenantKey(payment.tenantId) !== runtime.sellerTenantId ||
    payment.externalProvider !== runtime.provider.name ||
    !payment.reference.startsWith(AUTO_TOP_UP_REFERENCE_PREFIX)
  ) {
    throw new Error(`Auto top-up attempt ${paymentId} was not found.`);
  }
  const policyId = payment.reference.slice(AUTO_TOP_UP_REFERENCE_PREFIX.length);
  // The policy and account belong to the payer: a reviewed system read.
  const policy = await withSystemContext(() => runtime.policies.get(policyId));
  if (!policy?.id) {
    throw new Error(`Auto top-up policy ${policyId} was not found.`);
  }
  const setBy = tenantKey(policy.setByTenantId);
  const payerTenantId = canonicalTenantId(
    setBy || String(policy.tenantId),
    'payerTenantId',
  );
  const account = await withSystemContext(() =>
    runtime.getAccount(payerTenantId),
  );
  if (
    (outcome.amount !== undefined && outcome.amount !== payment.amount) ||
    (outcome.currency !== undefined &&
      normalizeCurrency(outcome.currency) !==
        normalizeCurrency(payment.currency)) ||
    (outcome.providerCustomerId !== undefined &&
      outcome.providerCustomerId !== account?.providerCustomerId)
  ) {
    throw new Error(
      `Charge for auto top-up ${paymentId} does not match it: ` +
        `${outcome.amount} ${outcome.currency} for ${payment.amount} ${payment.currency}.`,
    );
  }

  if (outcome.status === 'succeeded') {
    if (payment.status === PaymentStatus.FAILED) {
      // The attempt was closed as failed, then the provider collected: an
      // operator must reconcile it (credit or refund).
      throw new Error(
        `Auto top-up ${paymentId} was recorded as failed but its charge succeeded.`,
      );
    }
    const grant: AutoTopUpGrant = {
      amount: payment.amount,
      source: `${runtime.provider.name}-auto-top-up`,
      sourceId: autoTopUpChargeKey(paymentId),
      reason: 'Automatic prepaid credit top-up',
    };
    if (pending) {
      // Keyed by the charge: the evaluator recording the returned grant
      // again finds this one.
      await withSystemContext(async () => {
        const evaluator = await SpendingPolicyEvaluator.create({ db });
        await evaluator.grantCredit({
          spendingPolicyId: policyId,
          amount: grant.amount,
          reason: grant.reason,
          source: grant.source,
          sourceId: grant.sourceId,
          ...(setBy ? { grantedByTenantId: setBy } : {}),
        });
      });
      if (outcome.providerPaymentId) {
        payment.externalId = outcome.providerPaymentId;
      }
      await payment.recordPayment({
        ledgerId: '',
        cashAccountId: runtime.ledger.cashAccountId,
        receivablesAccountId: runtime.ledger.prepaidCreditAccountId,
      });
    }
    return { grant };
  }

  if (!pending) return { grant: null }; // Already settled.

  if (outcome.status === 'processing') {
    // The lock's update refreshed `updated_at`, which paces re-drives.
    if (outcome.providerPaymentId && !payment.externalId) {
      payment.externalId = outcome.providerPaymentId;
      await payment.save();
    }
    return { grant: null };
  }

  // requires_action, failed, canceled: nothing was charged.
  payment.status = PaymentStatus.FAILED;
  if (outcome.providerPaymentId && !payment.externalId) {
    payment.externalId = outcome.providerPaymentId;
  }
  payment.notes = `${outcome.status}${outcome.failureCode ? `: ${outcome.failureCode}` : ''}`;
  await payment.save();
  await runtime.onAutoTopUpFailed?.({
    sellerTenantId: runtime.sellerTenantId,
    payerTenantId,
    spendingPolicyId: policyId,
    paymentId,
    status: outcome.status,
    failureCode: outcome.failureCode,
    amount: payment.amount,
    currency: normalizeCurrency(payment.currency),
    db,
  });
  return { grant: null };
}
