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
import { JournalCollection } from '@happyvertical/smrt-ledgers';
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

/**
 * Why a needed top-up will not be charged (#3189). New reasons may be added in
 * a minor release; treat an unknown reason like `no_card`.
 *
 * - `taxed_account`: the payer's account is taxed and the hook was built with
 *   `taxedAccounts: 'skip'`.
 * - `no_card`: the payer has no default card with this provider customer
 *   (see `BillingRuntime.cardOnFile`).
 * - `no_account`: the payer has no billing account or provider customer yet.
 * - `tax_location_invalid`: a taxed payer has no tax location (billing
 *   address country), so tax cannot be calculated (#3194). A location the
 *   provider rejects instead fails the charge with `failureCode:
 *   'customer_tax_location_invalid'` through `onAutoTopUpFailed`.
 */
export type AutoTopUpSkipReason =
  | 'taxed_account'
  | 'no_card'
  | 'no_account'
  | 'tax_location_invalid';

/** A top-up the balance needed that will not be charged. */
export interface AutoTopUpSkip {
  sellerTenantId: string;
  /** Who would have been charged (the delegating parent, if delegated). */
  payerTenantId: string;
  spendingPolicyId: string;
  currency: string;
  /** The shortfall still to cover, recomputed at the skip, minor units. */
  shortfall: number;
  reason: AutoTopUpSkipReason;
}

/**
 * Host hook for a skipped top-up, for example to ask the payer to top up by
 * hand. It runs on the spending evaluation's path, on every evaluation that
 * needed a top-up and was skipped, so dedupe notifications and keep it
 * cheap; an error it throws fails the evaluation.
 */
export type AutoTopUpSkipHook = (skip: AutoTopUpSkip) => void | Promise<void>;

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
   * How a payer whose account is taxed (`automaticTax`, not tax-exempt) is
   * topped up (#3194). `'charge_taxed'` (the default) adds
   * provider-calculated tax on top of the credit, as a checkout purchase of
   * the same credit does: the payer is charged credit plus tax, the balance
   * is credited the credit, and the tax is booked to tax payable.
   * `'skip'` does not top them up (reported as `taxed_account`);
   * `'charge_untaxed'` charges them without tax, for sellers that account
   * for tax on this credit elsewhere. Untaxed accounts are never taxed.
   */
  taxedAccounts?: 'charge_taxed' | 'skip' | 'charge_untaxed';
  /**
   * Called when no charge will be made for a needed top-up because of the
   * payer's account (#3189): see {@link AutoTopUpSkipReason}. It is not
   * called while an attempt is still processing, while a declined card waits
   * out `retryAfterMs` (`onAutoTopUpFailed` already reported it), when the
   * recomputed shortfall is already covered, or when `amount` returns 0
   * (which is evaluated first, as for a charge).
   */
  onAutoTopUpSkipped?: AutoTopUpSkipHook;
}

/** The outcome of a charge, from the provider's result or its webhook. */
export interface AutoTopUpChargeOutcome {
  status: BillingChargeStatus;
  providerPaymentId?: string;
  providerCustomerId?: string;
  /** Minor units charged (with tax for a taxed charge), when reported. */
  amount?: number;
  currency?: string;
  /** A taxed charge's pre-tax amount: the credit (#3194). */
  subtotal?: number;
  /** A taxed charge's provider-calculated tax (#3194). */
  tax?: number;
  failureCode?: string;
}

/**
 * Marks an attempt charged with provider tax (#3194) in its `notes`, so a
 * re-drive of the same charge key repeats the same request whatever the
 * account's tax status is by then.
 */
const TAXED_ATTEMPT_NOTE = ' (automatic tax)';

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
    if (attempt && 'skip' in attempt) {
      await options.onAutoTopUpSkipped?.(attempt.skip);
      return null;
    }
    if (!attempt) return null;
    const { payment, payerTenantId, providerCustomerId } = attempt;
    const paymentId = String(payment.id);
    const automaticTax = isTaxedAttempt(payment);
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
      ...(automaticTax
        ? {
            automaticTax: true,
            ...(runtime.taxCodes.credit
              ? { taxCode: runtime.taxCodes.credit }
              : {}),
          }
        : {}),
    });
    const outcome: AutoTopUpChargeOutcome = {
      status: result.status,
      providerPaymentId: result.providerPaymentId,
      providerCustomerId,
      amount: result.amount,
      currency: result.currency,
      subtotal: result.subtotal,
      tax: result.tax,
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

interface SkippedAttempt {
  skip: AutoTopUpSkip;
}

async function claimAttempt(
  runtime: BillingRuntime,
  request: AutoTopUpRequest,
  options: AutoTopUpHookOptions,
  retryAfterMs: number,
  recheckAfterMs: number,
): Promise<ClaimedAttempt | SkippedAttempt | null> {
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
  // What a top-up would charge now, or null when none is needed: another
  // evaluation may have topped the balance up since this one read it (its
  // attempt is completed, so its grant is visible), and `amount` may decline.
  // A skip is reported only for a top-up that is still needed (#3189).
  const needed = async (): Promise<{
    shortfall: number;
    requested: number;
  } | null> => {
    const shortfall = request.currentShortfall
      ? await request.currentShortfall()
      : request.shortfall;
    if (shortfall <= 0) return null;
    const requested = options.amount
      ? await options.amount({ ...request, shortfall })
      : shortfall;
    if (!requested) return null;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      throw new Error(
        'Auto top-up amount must be positive integer minor units.',
      );
    }
    return { shortfall, requested };
  };
  const skipped = (
    reason: AutoTopUpSkipReason,
    shortfall: number,
  ): SkippedAttempt => ({
    skip: {
      sellerTenantId: runtime.sellerTenantId,
      payerTenantId,
      spendingPolicyId: String(policy.id),
      currency,
      shortfall,
      reason,
    },
  });
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
  const account = await runtime.getAccount(payerTenantId);
  const providerCustomerId =
    account?.id && account.provider === runtime.provider.name
      ? account.providerCustomerId
      : '';
  if (latest?.status === PaymentStatus.PENDING) {
    // One live attempt per policy: re-drive it (same key, same amount) only
    // when it has not been checked recently. Never a reported skip (#3189).
    if (now - timeOf(latest) < recheckAfterMs || !providerCustomerId) {
      return null;
    }
    return { payment: latest, payerTenantId, providerCustomerId };
  }
  if (
    latest?.status === PaymentStatus.FAILED &&
    now - timeOf(latest) < retryAfterMs
  ) {
    return null;
  }

  const need = await needed();
  if (!need) return null;
  if (!account?.id || !providerCustomerId) {
    // No provider customer, so no saved card to charge.
    return skipped('no_account', need.shortfall);
  }
  // New charges only (an attempt already charged is re-driven above with
  // the tax decision it was made with).
  const taxedAccounts = options.taxedAccounts ?? 'charge_taxed';
  const taxed = await runtime.accountIsTaxed(account);
  if (taxed && taxedAccounts === 'skip') {
    return skipped('taxed_account', need.shortfall);
  }
  // Only a payer with a card on file is charged (no failed attempt per
  // shortfall for payers who never saved one).
  if (!(await defaultCardFor(runtime, account, providerCustomerId))) {
    return skipped('no_card', need.shortfall);
  }
  const automaticTax = taxed && taxedAccounts === 'charge_taxed';
  // Without a tax location the provider cannot tax the charge: no attempt
  // (and no failed charge per shortfall) until the payer adds one.
  if (automaticTax && !(await runtime.hasTaxLocation(account))) {
    return skipped('tax_location_invalid', need.shortfall);
  }
  const requested = need.requested;
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
      notes: `attempt ${sequence}${automaticTax ? TAXED_ATTEMPT_NOTE : ''}`,
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

function isTaxedAttempt(payment: Payment): boolean {
  return (
    payment.notes.startsWith('attempt ') &&
    payment.notes.includes(TAXED_ATTEMPT_NOTE)
  );
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
  // The attempt row holds the credit: a taxed charge is compared by its
  // pre-tax subtotal, and its total must be that plus the tax (#3194). An
  // untaxed attempt never accepts tax (the payer was charged more than the
  // credit it asked for).
  const tax = outcome.tax ?? 0;
  const taxedAttempt = isTaxedAttempt(payment);
  if (
    !Number.isSafeInteger(tax) ||
    tax < 0 ||
    // The total must be exact minor units, never a rounded float sum.
    !Number.isSafeInteger(payment.amount + tax) ||
    (tax > 0 && !taxedAttempt) ||
    (outcome.subtotal !== undefined && outcome.subtotal !== payment.amount) ||
    (outcome.amount !== undefined && outcome.amount !== payment.amount + tax) ||
    (outcome.currency !== undefined &&
      normalizeCurrency(outcome.currency) !==
        normalizeCurrency(payment.currency)) ||
    (outcome.providerCustomerId !== undefined &&
      outcome.providerCustomerId !== account?.providerCustomerId)
  ) {
    throw new Error(
      `Charge for auto top-up ${paymentId} does not match it: ` +
        `${outcome.amount} ${outcome.currency} (tax ${tax}) for ${payment.amount} ${payment.currency}.`,
    );
  }

  if (outcome.status === 'succeeded') {
    if (taxedAttempt && outcome.tax === undefined) {
      // A taxed charge that reports no tax cannot be booked correctly: fail
      // visibly rather than leave the collected tax out of the ledger.
      throw new Error(
        `Taxed auto top-up ${paymentId} succeeded without a reported tax amount.`,
      );
    }
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
      if (tax > 0) payment.notes = `${payment.notes}; tax ${tax}`;
      await payment.recordPayment({
        ledgerId: '',
        cashAccountId: runtime.ledger.cashAccountId,
        receivablesAccountId: runtime.ledger.prepaidCreditAccountId,
      });
      if (tax > 0) {
        // The payer paid credit plus tax: the tax is the seller's to remit,
        // booked once with the settlement it belongs to.
        const journals = await JournalCollection.create({ db });
        const journal = await journals.create({
          date: new Date(),
          description: `Tax collected on automatic top-up ${paymentId}`,
          sourceModule: 'smrt-commerce',
          sourceRef: `${paymentId}:tax`,
        });
        await journal.save();
        await journal.addEntry({
          accountId: runtime.ledger.cashAccountId,
          debit: tax,
          memo: `Tax on top-up ${policyId}`,
        });
        await journal.addEntry({
          accountId: runtime.ledger.taxAccountId,
          credit: tax,
          memo: `Tax on top-up ${policyId}`,
        });
        await journal.post();
      }
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
  // Appended, never replaced: the notes carry the attempt's tax decision,
  // which a later webhook for the same charge is checked against.
  payment.notes = `${payment.notes}; ${outcome.status}${outcome.failureCode ? `: ${outcome.failureCode}` : ''}`;
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
