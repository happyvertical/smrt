/**
 * Payment sync to the accounting provider, readback of ordinary frozen
 * invoices, and the bounded batch entry points an app job calls (#5139).
 *
 * - {@link syncPaymentToAccounting} pushes one recorded payment, applied to its
 *   synced invoice(s) and deposited to the mapped clearing account, exactly
 *   once: the request id is persisted before the push, an unknown outcome stops
 *   and waits for {@link reconcileAccountingPaymentSync}, as the invoice path.
 * - {@link readbackInvoice} reads the provider document, stores the projection
 *   and a status (`in_step` | `drift` | `needs_reconciliation`), including
 *   payments recorded only in the provider.
 * - {@link syncPending} and {@link readbackDue} take a tenant and a bound, so an
 *   app job only schedules and locks.
 *
 * Provider payment creation (happyvertical/sdk#1540) and invoice readback are
 * injected ports; smrt never calls the provider SDK for them directly. See
 * `agents/accounting-payment-sync.md`.
 *
 * @packageDocumentation
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { isReauthRequired } from './accounting-connection.js';
import { assertAccountingWriteAllowed } from './accounting-live-gate.js';
import {
  type AccountingCustomerDirectory,
  type AccountingCustomerFacts,
  AccountingMappingError,
  type AccountingMappingScope,
  buildFrozenInvoiceMapping,
  getAccountingMapping,
  getAccountingMappingScope,
  resolveAccountingCustomer,
} from './accounting-mapping.js';
import {
  AccountingInvoiceReadbackCollection,
  AccountingPaymentSyncCollection,
} from './collections/AccountingSyncRecordCollections.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from './collections/PaymentAllocationCollection.js';
import { PaymentCollection } from './collections/PaymentCollection.js';
import {
  readFrozenAccountingSyncState,
  type SyncFrozenInvoiceToAccountingInput,
  syncFrozenInvoiceToAccounting,
} from './invoice-accounting-sync.js';
import {
  type AccountingPaymentSync,
  type AccountingReadbackStatus,
  writeAccountingSyncRecord,
} from './models/AccountingSyncRecords.js';
import type { Invoice } from './models/Invoice.js';
import type { Payment } from './models/Payment.js';
import {
  projectQuickBooksPilotEvidence,
  type QuickBooksPilotInvoiceEvidence,
} from './quickbooks-pilot-evidence.js';
import { InvoiceStatus, PaymentStatus } from './types/index.js';

/** Why a payment sync or readback command refused. */
export type AccountingPaymentSyncErrorCode =
  | 'PAYMENT_NOT_SYNCABLE'
  | 'INVOICE_NOT_SYNCED'
  | 'SYNC_IN_PROGRESS'
  | 'RECONCILIATION_REQUIRED'
  | 'INVALID_INPUT';

/** Typed refusal from a payment sync or readback command. */
export class AccountingPaymentSyncError extends Error {
  readonly code: AccountingPaymentSyncErrorCode;

  constructor(code: AccountingPaymentSyncErrorCode, message: string) {
    super(message);
    this.name = 'AccountingPaymentSyncError';
    this.code = code;
  }
}

/** The exact facts pushed for one payment. */
export interface AccountingPaymentRequest {
  /** Stable provider idempotency id, persisted before the push. */
  readonly requestId: string;
  readonly payloadHash: string;
  readonly realmId: string;
  readonly environment: 'sandbox' | 'production';
  /** Local payment id. */
  readonly paymentId: string;
  /** Provider customer id from the mapping. */
  readonly customerExternalId: string;
  /** Provider clearing/deposit account id from the mapping. */
  readonly depositAccountRef: string;
  readonly currency: string;
  /** Payment amount in minor units; equals the sum of the applications. */
  readonly amountMinor: number;
  readonly paidAt: Date;
  /** The rail's transaction reference (for example a Stripe charge id). */
  readonly transactionId?: string;
  /** The synced invoices the payment is applied to. */
  readonly applications: readonly {
    readonly invoiceId: string;
    readonly invoiceExternalId: string;
    readonly amountMinor: number;
  }[];
}

/**
 * Provider payment creation (happyvertical/sdk#1540). `create` must treat
 * `requestId` as an idempotency key. Throw with `outcome: 'rejected'` when the
 * provider definitely refused; any other failure leaves the outcome unknown.
 */
export interface AccountingPaymentPort {
  /**
   * The provider's own identity for these facts, derived before anything is
   * persisted or sent. QuickBooks requires `payloadHash` to be the SHA-256 of
   * the exact mapped payload, which only the provider can compute; commerce
   * persists what this returns. Throw when the facts cannot form a valid
   * provider request: nothing was sent, so the row becomes a retryable
   * `rejected` with a stable code. Must perform no I/O.
   */
  prepare?(request: AccountingPaymentRequest): {
    readonly payloadHash: string;
  };
  create(
    request: AccountingPaymentRequest,
  ): Promise<{ readonly externalId: string; readonly syncedAt: Date }>;
}

/** Throw from a port when a failure happened before anything reached the provider. */
export class AccountingPaymentNotSentError extends Error {
  readonly outcome = 'rejected' as const;
  readonly reason: string;
  /** Same as `reason`, so batch items report it. */
  readonly code: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = 'AccountingPaymentNotSentError';
    this.reason = reason;
    this.code = reason;
  }
}

/**
 * The provider's invoice document with its linked transactions, read in full
 * (same shape the pilot's fixture evidence uses, for any environment).
 */
export type AccountingInvoiceEvidence = Omit<
  QuickBooksPilotInvoiceEvidence,
  'environment'
> & { readonly environment: 'sandbox' | 'production' };

/** Reads one provider invoice and all its linked transactions. */
export interface AccountingInvoiceReader {
  readInvoice(externalId: string): Promise<AccountingInvoiceEvidence>;
}

function refuse(code: AccountingPaymentSyncErrorCode, message: string): never {
  throw new AccountingPaymentSyncError(code, message);
}

function principal(tenantId: string): void {
  if (!tenantId || getTenantId() !== tenantId)
    refuse('INVALID_INPUT', 'Accounting sync requires its active tenant');
}

function hash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

// ---------------------------------------------------------------------------
// Payment push
// ---------------------------------------------------------------------------

/** Input of {@link syncPaymentToAccounting}. */
export interface SyncPaymentToAccountingInput {
  readonly db: DatabaseInterface;
  /** Must be the active tenant. */
  readonly tenantId: string;
  readonly paymentId: string;
  readonly payments: AccountingPaymentPort;
  /** The provider, so the live-mode gate can see its environment. */
  readonly provider?: object;
}

/** Outcome of a payment push. */
export interface AccountingPaymentSyncResult {
  readonly status: 'synced' | 'unchanged';
  readonly externalId: string;
  readonly requestId: string;
}

async function loadPaymentRequest(
  input: SyncPaymentToAccountingInput,
  scope: AccountingMappingScope,
): Promise<AccountingPaymentRequest> {
  const payment = await (await PaymentCollection.create({ db: input.db })).get(
    { id: input.paymentId },
    { cache: false },
  );
  if (!payment || payment.tenantId !== input.tenantId)
    refuse('PAYMENT_NOT_SYNCABLE', 'Payment not found for the tenant');
  if (payment.kind !== 'payment' || payment.status !== PaymentStatus.COMPLETED)
    refuse('PAYMENT_NOT_SYNCABLE', 'Only a completed payment can be synced');
  if (
    payment.retentionAccountingBindingJson ||
    payment.ordinaryAccountingBindingJson
  )
    refuse('PAYMENT_NOT_SYNCABLE', 'Provider refund bindings are not payments');
  const allocations = await (
    await PaymentAllocationCollection.create({ db: input.db })
  ).findByPayment(input.paymentId);
  if (allocations.length === 0)
    refuse('PAYMENT_NOT_SYNCABLE', 'The payment is not applied to an invoice');
  const allocated = allocations.reduce((sum, a) => sum + a.amount, 0);
  if (allocated !== payment.amount)
    refuse(
      'PAYMENT_NOT_SYNCABLE',
      'The payment must be fully applied to invoices before it is synced',
    );
  const invoices = await InvoiceCollection.create({ db: input.db });
  const applications: AccountingPaymentRequest['applications'][number][] = [];
  let customerId = '';
  for (const allocation of allocations) {
    const invoice = await invoices.get(
      { id: allocation.invoiceId },
      { cache: false },
    );
    const state = invoice ? readFrozenAccountingSyncState(invoice) : null;
    if (
      !invoice ||
      invoice.tenantId !== input.tenantId ||
      invoice.kind !== 'invoice' ||
      !invoice.externalId ||
      state?.status !== 'synced' ||
      state.realmId !== scope.realmId ||
      state.environment !== scope.environment
    )
      refuse(
        'INVOICE_NOT_SYNCED',
        'Every invoice the payment is applied to must be synced to the connected company first',
      );
    if (invoice.currency !== payment.currency)
      refuse('PAYMENT_NOT_SYNCABLE', 'Payment and invoice currencies differ');
    customerId = customerId || invoice.customerId || '';
    if (invoice.customerId !== customerId)
      refuse('PAYMENT_NOT_SYNCABLE', 'A payment applies to one customer');
    applications.push({
      invoiceId: String(invoice.id),
      invoiceExternalId: invoice.externalId,
      amountMinor: allocation.amount,
    });
  }
  const customer = await getAccountingMapping(
    input,
    scope,
    'customer',
    customerId,
  );
  const deposit = await getAccountingMapping(
    input,
    scope,
    'deposit_account',
    'default',
  );
  const missing = [
    ...(customer ? [] : [{ kind: 'customer' as const, localId: customerId }]),
    ...(deposit
      ? []
      : [{ kind: 'deposit_account' as const, localId: 'default' }]),
  ];
  if (missing.length > 0)
    throw new AccountingMappingError(
      'MAPPING_INCOMPLETE',
      'Accounting mapping is incomplete for this payment',
      missing,
    );
  applications.sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const facts = {
    paymentId: input.paymentId,
    customerExternalId: (customer as { externalId: string }).externalId,
    depositAccountRef: (deposit as { externalId: string }).externalId,
    currency: payment.currency,
    amountMinor: payment.amount,
    paidAt: (payment.paidAt ?? payment.created_at ?? new Date()).toISOString(),
    transactionId: payment.transactionId || undefined,
    applications,
  };
  const payloadHash = hash([
    'payment',
    scope.realmId,
    scope.environment,
    facts,
  ]);
  return {
    requestId: `smrt_pay_${payloadHash.slice(0, 40)}`,
    payloadHash,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: facts.paymentId,
    customerExternalId: facts.customerExternalId,
    depositAccountRef: facts.depositAccountRef,
    currency: facts.currency,
    amountMinor: facts.amountMinor,
    paidAt: new Date(facts.paidAt),
    ...(facts.transactionId ? { transactionId: facts.transactionId } : {}),
    applications,
  };
}

/** Claim the push: create the row, or take over a `rejected` one atomically. */
async function claim(
  input: SyncPaymentToAccountingInput,
  scope: AccountingMappingScope,
  request: AccountingPaymentRequest,
): Promise<
  | { kind: 'claimed'; attemptId: string }
  | { kind: 'done'; row: AccountingPaymentSync }
> {
  const collection = await AccountingPaymentSyncCollection.create({
    db: input.db,
  });
  const key = {
    tenantId: input.tenantId,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: input.paymentId,
  };
  const attemptId = randomUUID();
  const now = new Date();
  let row = await collection.findForPayment(key);
  if (!row) {
    const fresh = await collection.build({
      ...key,
      provider: 'quickbooks',
      status: 'in_flight',
      requestId: request.requestId,
      attemptId,
      payloadHash: request.payloadHash,
      requestJson: JSON.stringify(request),
      startedAt: now,
    } as never);
    try {
      await writeAccountingSyncRecord(fresh, () => fresh.save());
      return { kind: 'claimed', attemptId };
    } catch (error) {
      row = await collection.findForPayment(key); // lost the race on the unique key
      if (!row) throw error;
    }
  }
  if (row.status === 'synced') return { kind: 'done', row };
  if (row.status === 'in_flight')
    refuse('SYNC_IN_PROGRESS', 'Another process is pushing this payment');
  if (row.status === 'unknown')
    refuse(
      'RECONCILIATION_REQUIRED',
      'The prior payment push outcome is unknown and must be reconciled',
    );
  const taken = await input.db.query(
    `UPDATE accounting_payment_syncs
        SET status = 'in_flight', attempt_id = ?, request_id = ?, payload_hash = ?,
            request_json = ?, started_at = ?, last_error = ''
      WHERE id = ? AND tenant_id = ? AND status = 'rejected' AND attempt_id = ?
        AND (pinned_request_id = '' OR pinned_request_id = ?)
      RETURNING id`,
    attemptId,
    request.requestId,
    request.payloadHash,
    JSON.stringify(request),
    now.toISOString(),
    row.id,
    input.tenantId,
    row.attemptId,
    request.requestId,
  );
  if (taken.rows.length !== 1) {
    // A push released because the provider never received it keeps its request
    // id: the provider dedups on it, so a slow original that lands later cannot
    // become a second payment. Changed facts mean a new id, which a person
    // decides. (Read in SQL: a cached row could predate the release.)
    const pinned = await input.db.query(
      `SELECT pinned_request_id FROM accounting_payment_syncs
        WHERE id = ? AND tenant_id = ?`,
      row.id,
      input.tenantId,
    );
    const pin = String(
      (pinned.rows[0] as { pinned_request_id?: string } | undefined)
        ?.pinned_request_id ?? '',
    );
    if (pin && pin !== request.requestId)
      refuse(
        'RECONCILIATION_REQUIRED',
        'The payment facts changed after its push was released; reconcile it',
      );
    refuse('SYNC_IN_PROGRESS', 'Another process is pushing this payment');
  }
  return { kind: 'claimed', attemptId };
}

async function settle(
  input: SyncPaymentToAccountingInput,
  scope: AccountingMappingScope,
  attemptId: string,
  change: (row: AccountingPaymentSync) => void,
): Promise<void> {
  const collection = await AccountingPaymentSyncCollection.create({
    db: input.db,
  });
  const row = await collection.findForPayment({
    tenantId: input.tenantId,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: input.paymentId,
  });
  if (!row || row.attemptId !== attemptId || row.status !== 'in_flight')
    refuse(
      'RECONCILIATION_REQUIRED',
      'Payment sync ownership changed during the provider call',
    );
  change(row);
  await writeAccountingSyncRecord(row, () => row.save());
}

/**
 * Push one recorded payment to the provider exactly once.
 *
 * Needs a connected company, the customer and `deposit_account:default`
 * mappings, and every invoice the payment applies to already synced to that
 * company. The request id and exact facts are persisted before the push; a
 * rejected push (or a dead grant, which sent nothing) may be retried; any other
 * failure is `unknown` and stops until {@link reconcileAccountingPaymentSync}.
 * Production needs live mode (#5138). Run it inside the tenant context.
 */
export async function syncPaymentToAccounting(
  input: SyncPaymentToAccountingInput,
): Promise<AccountingPaymentSyncResult> {
  principal(input.tenantId);
  const scope = await getAccountingMappingScope(input, input.tenantId);
  await assertAccountingWriteAllowed({
    db: input.db,
    tenantId: input.tenantId,
    provider: input.provider,
    scope,
  });
  let request = await loadPaymentRequest(input, scope);
  // The provider derives the persisted identity (see AccountingPaymentPort.prepare).
  let notSent: AccountingPaymentNotSentError | null = null;
  if (input.payments.prepare) {
    try {
      request = {
        ...request,
        payloadHash: input.payments.prepare(request).payloadHash,
      };
    } catch (error) {
      notSent =
        error instanceof AccountingPaymentNotSentError
          ? error
          : new AccountingPaymentNotSentError(
              'INVALID_PROVIDER_REQUEST',
              'The payment cannot be formed into a valid provider request',
            );
    }
  }
  const claimed = await claim(input, scope, request);
  if (claimed.kind === 'done')
    return {
      status: 'unchanged',
      externalId: claimed.row.externalId,
      requestId: claimed.row.requestId,
    };
  if (notSent) {
    // Nothing was sent: a known, retryable rejection, with its cause kept.
    const failure = notSent;
    await settle(input, scope, claimed.attemptId, (row) => {
      row.status = 'rejected';
      row.lastError = failure.reason;
    });
    throw failure;
  }
  let result: { externalId: string; syncedAt: Date };
  try {
    result = await input.payments.create(request);
    if (!result?.externalId || !(result.syncedAt instanceof Date))
      throw new Error('invalid provider answer');
  } catch (error) {
    const rejected =
      isReauthRequired(error) ||
      (error as { outcome?: unknown } | null)?.outcome === 'rejected';
    await settle(input, scope, claimed.attemptId, (row) => {
      row.status = rejected ? 'rejected' : 'unknown';
      row.lastError = rejected
        ? isReauthRequired(error)
          ? 'REAUTH_REQUIRED'
          : error instanceof AccountingPaymentNotSentError
            ? error.reason
            : 'REJECTED'
        : 'UNKNOWN_OUTCOME';
    });
    throw error;
  }
  await settle(input, scope, claimed.attemptId, (row) => {
    row.status = 'synced';
    row.externalId = result.externalId;
    row.syncedAt = result.syncedAt;
    row.lastError = '';
  });
  return {
    status: 'synced',
    externalId: result.externalId,
    requestId: request.requestId,
  };
}

/** Input of {@link reconcileAccountingPaymentSync}. */
export interface ReconcileAccountingPaymentSyncInput {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly paymentId: string;
  /** The request id observed before looking the payment up at the provider. */
  readonly requestId: string;
  /** The unresolved attempt observed with it. */
  readonly attemptId: string;
  /** Required for an interrupted `in_flight` row: its owner can no longer finish. */
  readonly confirmInterruptedOwnerStopped?: true;
  /** The authoritative provider lookup of that request. */
  readonly outcome:
    | {
        readonly status: 'found';
        readonly externalId: string;
        readonly syncedAt: Date;
      }
    | { readonly status: 'absent' };
}

/**
 * Resolve an unknown or interrupted payment push with an authoritative provider
 * lookup. `found` records the payment as synced; `absent` (the provider
 * confirmed nothing was created) makes the push retryable.
 */
export async function reconcileAccountingPaymentSync(
  input: ReconcileAccountingPaymentSyncInput,
): Promise<AccountingPaymentSync> {
  principal(input.tenantId);
  const scope = await getAccountingMappingScope(input, input.tenantId);
  const collection = await AccountingPaymentSyncCollection.create({
    db: input.db,
  });
  const row = await collection.findForPayment({
    tenantId: input.tenantId,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: input.paymentId,
  });
  if (
    !row ||
    (row.status !== 'unknown' && row.status !== 'in_flight') ||
    row.requestId !== input.requestId ||
    row.attemptId !== input.attemptId
  )
    refuse(
      'RECONCILIATION_REQUIRED',
      'Reconciliation does not match the unresolved payment push',
    );
  if (
    row.status === 'in_flight' &&
    input.confirmInterruptedOwnerStopped !== true
  )
    refuse(
      'SYNC_IN_PROGRESS',
      'Reconciliation cannot release a live push owner',
    );
  // Apply against the observed owner atomically: two reconciliations that read
  // the same unresolved attempt cannot both win, and a stale one never
  // overwrites a later success.
  let applied: { rows: unknown[] };
  if (input.outcome.status === 'found') {
    if (!input.outcome.externalId || !(input.outcome.syncedAt instanceof Date))
      refuse('INVALID_INPUT', 'Reconciliation requires a provider id and time');
    applied = await input.db.query(
      `UPDATE accounting_payment_syncs
          SET status = 'synced', external_id = ?, synced_at = ?, last_error = ''
        WHERE id = ? AND tenant_id = ? AND status = ? AND request_id = ?
          AND attempt_id = ?
        RETURNING id`,
      input.outcome.externalId,
      input.outcome.syncedAt.toISOString(),
      row.id,
      input.tenantId,
      row.status,
      input.requestId,
      input.attemptId,
    );
  } else {
    applied = await input.db.query(
      `UPDATE accounting_payment_syncs
          SET status = 'rejected', last_error = 'ABSENT_AT_PROVIDER',
              pinned_request_id = request_id
        WHERE id = ? AND tenant_id = ? AND status = ? AND request_id = ?
          AND attempt_id = ?
        RETURNING id`,
      row.id,
      input.tenantId,
      row.status,
      input.requestId,
      input.attemptId,
    );
  }
  if (applied.rows.length !== 1)
    refuse(
      'RECONCILIATION_REQUIRED',
      'The payment push changed while it was being reconciled',
    );
  return (await collection.findForPayment({
    tenantId: input.tenantId,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: input.paymentId,
  })) as AccountingPaymentSync;
}

/** Input of {@link resolveUnknownPaymentSync}. */
export interface ResolveUnknownPaymentSyncInput {
  readonly db: DatabaseInterface;
  /** Must be the active tenant. */
  readonly tenantId: string;
  readonly paymentId: string;
  /** Reads the provider's invoices with their linked transactions. */
  readonly reader: AccountingInvoiceReader;
}

/** What {@link resolveUnknownPaymentSync} concluded. */
export type ResolveUnknownPaymentSyncResult =
  | { readonly status: 'not_unknown' }
  /** The provider holds no payment against the applied invoices: retryable. */
  | { readonly status: 'retryable'; readonly row: AccountingPaymentSync }
  /** The provider has a payment on an applied invoice; only a person can tell whose. */
  | { readonly status: 'ambiguous'; readonly providerPaymentIds: string[] }
  /** The provider read was partial or for another company or invoice: nothing is proven. */
  | { readonly status: 'inconclusive' };

/**
 * Recover a payment push stuck as `unknown` without hand-written SQL. It asks
 * the provider, through the invoice reader, whether any payment is recorded
 * against the invoices the push applied to. None means the push never landed,
 * so the row is released for a normal retry (the same `requestid` keeps it
 * idempotent even if the provider is slower than the read); any payment leaves
 * the row `unknown`, because a provider payment cannot be attributed to this
 * push from the document alone. A failed read throws and changes nothing.
 * Run it inside the tenant context.
 */
export async function resolveUnknownPaymentSync(
  input: ResolveUnknownPaymentSyncInput,
): Promise<ResolveUnknownPaymentSyncResult> {
  principal(input.tenantId);
  const scope = await getAccountingMappingScope(input, input.tenantId);
  const collection = await AccountingPaymentSyncCollection.create({
    db: input.db,
  });
  const row = await collection.findForPayment({
    tenantId: input.tenantId,
    realmId: scope.realmId,
    environment: scope.environment,
    paymentId: input.paymentId,
  });
  if (!row || row.status !== 'unknown') return { status: 'not_unknown' };
  let applications: { invoiceExternalId: string }[] = [];
  try {
    applications = JSON.parse(row.requestJson).applications ?? [];
  } catch {
    refuse('INVALID_INPUT', 'The stored payment request cannot be read');
  }
  if (applications.length === 0)
    refuse('INVALID_INPUT', 'The stored payment request has no invoices');
  const found: string[] = [];
  for (const application of applications) {
    const evidence = await input.reader.readInvoice(
      application.invoiceExternalId,
    );
    // Absence is proven only by a complete read of this company's invoice.
    if (
      evidence.complete !== true ||
      evidence.realmId !== scope.realmId ||
      evidence.environment !== scope.environment ||
      evidence.tenantId !== input.tenantId ||
      evidence.externalId !== application.invoiceExternalId
    )
      return { status: 'inconclusive' };
    for (const transaction of evidence.transactions)
      if (transaction.kind === 'payment') found.push(transaction.id);
  }
  // Payments this tenant already synced are not evidence about this push.
  const known = new Set<string>();
  if (found.length > 0) {
    const synced = await input.db.query(
      `SELECT external_id FROM accounting_payment_syncs
        WHERE tenant_id = ? AND realm_id = ? AND environment = ?
          AND status = 'synced' AND external_id IN (${found.map(() => '?').join(', ')})`,
      input.tenantId,
      scope.realmId,
      scope.environment,
      ...found,
    );
    for (const r of synced.rows as { external_id: string }[])
      known.add(String(r.external_id));
  }
  const unattributed = found.filter((id) => !known.has(id));
  if (unattributed.length > 0)
    return { status: 'ambiguous', providerPaymentIds: unattributed };
  const resolved = await reconcileAccountingPaymentSync({
    db: input.db,
    tenantId: input.tenantId,
    paymentId: input.paymentId,
    requestId: row.requestId,
    attemptId: row.attemptId,
    outcome: { status: 'absent' },
  });
  return { status: 'retryable', row: resolved };
}

// ---------------------------------------------------------------------------
// Readback
// ---------------------------------------------------------------------------

/** Input of {@link readbackInvoice}. */
export interface ReadbackInvoiceInput {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly reader: AccountingInvoiceReader;
  readonly now?: Date;
}

/** Stored outcome of a readback. */
export interface AccountingReadbackResult {
  readonly invoiceId: string;
  readonly externalId: string;
  readonly status: AccountingReadbackStatus;
  /** Why it is `drift` or `needs_reconciliation`; empty when `in_step`. */
  readonly reason: string;
  readonly localPaidMinor: number;
  readonly projection: ReturnType<typeof projectQuickBooksPilotEvidence> | null;
  /** Provider payment ids with no local counterpart. */
  readonly providerOnlyPayments: readonly string[];
}

/**
 * Read the provider document of one synced ordinary invoice and store the
 * projection and a status. Provider reads are authoritative: an incomplete or
 * inconsistent read is `needs_reconciliation`; a provider that disagrees with
 * Commerce on paid amounts, a voided document, or a payment recorded only in
 * the provider is `drift`. Reads only; it never writes to the provider.
 */
export async function readbackInvoice(
  input: ReadbackInvoiceInput,
): Promise<AccountingReadbackResult> {
  principal(input.tenantId);
  const invoice = await (await InvoiceCollection.create({ db: input.db })).get(
    { id: input.invoiceId },
    { cache: false },
  );
  const state = invoice ? readFrozenAccountingSyncState(invoice) : null;
  if (
    !invoice ||
    invoice.tenantId !== input.tenantId ||
    state?.status !== 'synced' ||
    !invoice.externalId
  )
    refuse('INVOICE_NOT_SYNCED', 'Only a synced invoice can be read back');
  const externalId = invoice.externalId;
  const scope = {
    realmId: state.realmId,
    environment: state.environment as 'sandbox' | 'production',
  };

  const allocations = await (
    await PaymentAllocationCollection.create({ db: input.db })
  ).findByInvoice(input.invoiceId);
  const payments = await PaymentCollection.create({ db: input.db });
  let localPaidMinor = 0;
  for (const allocation of allocations) {
    const payment = await payments.get(
      { id: allocation.paymentId },
      { cache: false },
    );
    if (
      payment?.kind === 'payment' &&
      payment.status === PaymentStatus.COMPLETED
    )
      localPaidMinor += allocation.amount;
  }

  let status: AccountingReadbackStatus = 'in_step';
  let reason = '';
  let projection: AccountingReadbackResult['projection'] = null;
  const providerOnly: string[] = [];
  try {
    const evidence = await input.reader.readInvoice(externalId);
    if (
      evidence.tenantId !== input.tenantId ||
      evidence.realmId !== scope.realmId ||
      evidence.environment !== scope.environment ||
      evidence.externalId !== externalId ||
      evidence.totalMinor !== invoice.totalAmount ||
      evidence.currency !== invoice.currency
    ) {
      status = 'needs_reconciliation';
      reason = 'EVIDENCE_SCOPE_OR_TOTAL_MISMATCH';
    } else {
      projection = projectQuickBooksPilotEvidence(evidence as never);
      const syncs = await AccountingPaymentSyncCollection.create({
        db: input.db,
      });
      for (const t of projection.transactions) {
        if (t.kind !== 'payment') continue;
        const known = await syncs.list({
          where: {
            tenantId: input.tenantId,
            realmId: scope.realmId,
            environment: scope.environment,
            status: 'synced',
            externalId: t.id,
          },
          limit: 1,
        });
        if (known.length === 0) providerOnly.push(t.id);
      }
      if (
        projection.state === 'voided' &&
        invoice.status !== InvoiceStatus.CANCELLED
      ) {
        status = 'drift';
        reason = 'VOIDED_IN_PROVIDER';
      } else if (projection.paidMinor !== localPaidMinor) {
        status = 'drift';
        reason =
          providerOnly.length > 0
            ? 'PROVIDER_ONLY_PAYMENT'
            : 'PAID_AMOUNT_DIFFERS';
      } else if (providerOnly.length > 0) {
        status = 'drift';
        reason = 'PROVIDER_ONLY_PAYMENT';
      }
    }
  } catch (error) {
    status = 'needs_reconciliation';
    reason = isReauthRequired(error) ? 'REAUTH_REQUIRED' : 'EVIDENCE_INVALID';
  }

  const collection = await AccountingInvoiceReadbackCollection.create({
    db: input.db,
  });
  const row =
    (await collection.findForInvoice(input.tenantId, input.invoiceId)) ??
    (await collection.build({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
    } as never));
  row.realmId = scope.realmId;
  row.environment = scope.environment;
  row.externalId = externalId;
  row.status = status;
  row.lastError = reason;
  row.projectionJson = projection ? JSON.stringify(projection) : '';
  row.localPaidMinor = localPaidMinor;
  row.providerOnlyJson = JSON.stringify(providerOnly);
  row.observedAt = input.now ?? new Date();
  await writeAccountingSyncRecord(row, () => row.save());
  return {
    invoiceId: input.invoiceId,
    externalId,
    status,
    reason,
    localPaidMinor,
    projection,
    providerOnlyPayments: providerOnly,
  };
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

const DEFAULT_BATCH = 25;
const MAX_BATCH = 100;
/** Rows one call may examine, however many it pushes. */
const SCAN_CAP = 200;
const SCAN_PAGE = 50;

function bound(limit: number | undefined): number {
  const n = limit ?? DEFAULT_BATCH;
  if (!Number.isInteger(n) || n < 1)
    refuse('INVALID_INPUT', 'limit must be a positive integer');
  return Math.min(n, MAX_BATCH);
}

/** What one batch did to one item. */
export interface AccountingBatchItem {
  readonly kind: 'invoice' | 'credit_note' | 'payment' | 'readback';
  readonly id: string;
  readonly outcome: 'synced' | 'unchanged' | 'skipped' | 'failed' | string;
  /** Short code for `skipped` and `failed`. */
  readonly reason?: string;
}

/** Result of a batch entry point. */
export interface AccountingBatchResult {
  readonly items: readonly AccountingBatchItem[];
  /**
   * Opaque position after the last row examined; pass it back as `cursor` to
   * continue. `null` when the sweep reached the end (the next call without a
   * cursor starts a new sweep).
   */
  readonly nextCursor: string | null;
}

type Phase = 'invoices' | 'payments';

/**
 * A cursor is a keyset position (`<phase>:<last row id>`), not an offset, so
 * rows that leave the pending set while the job runs never make it skip others.
 */
function parseCursor(cursor: string | undefined): {
  phase: Phase;
  afterId: string;
} {
  if (cursor === undefined) return { phase: 'invoices', afterId: '' };
  const match = /^(invoices|payments):([0-9a-zA-Z-]*)$/.exec(cursor);
  if (!match)
    refuse('INVALID_INPUT', 'cursor is not a position from a previous call');
  return { phase: match[1] as Phase, afterId: match[2] as string };
}

/** Input of {@link syncPending}. */
export interface SyncPendingInput {
  readonly db: DatabaseInterface;
  /** Must be the active tenant. */
  readonly tenantId: string;
  readonly provider: SyncFrozenInvoiceToAccountingInput['provider'];
  readonly payments: AccountingPaymentPort;
  /** Most items to push in this call (default 25, at most 100). */
  readonly limit?: number;
  /** Position from the previous call's `nextCursor`. */
  readonly cursor?: string;
  /**
   * Resolve a missing customer mapping instead of skipping the invoice. An
   * ambiguous match is skipped (`customer_needs_confirmation`), never created.
   */
  readonly customers?: {
    readonly directory: AccountingCustomerDirectory;
    readonly describe: (customerId: string) => Promise<AccountingCustomerFacts>;
  };
}

function code(error: unknown): string {
  const c = (error as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'ERROR';
}

/** Errors that make every item fail the same way: stop the batch. */
function isBatchFatal(error: unknown): boolean {
  const c = code(error);
  return (
    c === 'LIVE_ACCOUNTING_NOT_ENABLED' ||
    c === 'ACCOUNTING_ENVIRONMENT_MISMATCH' ||
    c === 'NOT_CONNECTED' ||
    c === 'NEEDS_RECONNECT'
  );
}

/**
 * Push the tenant's pending frozen invoices and credit notes, then their
 * recorded payments: at most `limit` pushes and at most {@link SCAN_CAP} rows
 * examined per call, resumable through `cursor`. Each item is independent: a
 * missing mapping, an unsynced source or a provider failure is reported on the
 * item and the batch continues. A closed live-mode gate or a dead connection
 * stops the batch (it would fail every item). Items already in flight or of
 * unknown outcome are reported as skipped (`in_flight`, `reconciliation`) so a
 * stuck push surfaces. Idempotent: re-running pushes nothing already synced.
 * The app job only schedules and locks.
 */
export async function syncPending(
  input: SyncPendingInput,
): Promise<AccountingBatchResult> {
  principal(input.tenantId);
  const limit = bound(input.limit);
  const scope = await getAccountingMappingScope(input, input.tenantId);
  await assertAccountingWriteAllowed({
    db: input.db,
    tenantId: input.tenantId,
    provider: input.provider,
    scope,
  });
  const items: AccountingBatchItem[] = [];
  const invoices = await InvoiceCollection.create({ db: input.db });
  const payments = await PaymentCollection.create({ db: input.db });
  const syncs = await AccountingPaymentSyncCollection.create({ db: input.db });
  let { phase, afterId } = parseCursor(input.cursor);
  let pushed = 0;
  let scanned = 0;

  const pushInvoice = async (invoice: Invoice) => {
    const id = String(invoice.id);
    const kind = invoice.kind === 'credit_note' ? 'credit_note' : 'invoice';
    const eligible =
      invoice.moneySnapshotId &&
      invoice.moneyAuthority === 'calculated' &&
      ![InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED].includes(
        invoice.status,
      ) &&
      !invoice.ordinaryAccountingStateJson &&
      !invoice.retentionAccountingStateJson &&
      !invoice.retentionStateJson;
    if (!eligible) return;
    const state = readFrozenAccountingSyncState(invoice);
    if (state?.status === 'synced') return;
    if (state && state.status !== 'rejected') {
      items.push({
        kind,
        id,
        outcome: 'skipped',
        reason: state.status === 'in_flight' ? 'in_flight' : 'reconciliation',
      });
      return;
    }
    try {
      let mapping: Awaited<ReturnType<typeof buildFrozenInvoiceMapping>>;
      try {
        mapping = await buildFrozenInvoiceMapping({
          db: input.db,
          tenantId: input.tenantId,
          invoiceId: id,
        });
      } catch (error) {
        const missing = (error as AccountingMappingError).missing ?? [];
        const onlyCustomer =
          code(error) === 'MAPPING_INCOMPLETE' &&
          missing.length === 1 &&
          missing[0]?.kind === 'customer';
        if (!onlyCustomer || !input.customers) throw error;
        const resolved = await resolveAccountingCustomer({
          db: input.db,
          tenantId: input.tenantId,
          customer: await input.customers.describe(String(invoice.customerId)),
          directory: input.customers.directory,
        });
        if (resolved.status !== 'mapped') {
          items.push({
            kind,
            id,
            outcome: 'skipped',
            reason: 'customer_needs_confirmation',
          });
          return;
        }
        mapping = await buildFrozenInvoiceMapping({
          db: input.db,
          tenantId: input.tenantId,
          invoiceId: id,
        });
      }
      const result = await syncFrozenInvoiceToAccounting({
        db: input.db,
        tenantId: input.tenantId,
        invoiceId: id,
        mapping,
        provider: input.provider,
      });
      pushed += 1;
      items.push({ kind, id, outcome: result.status });
    } catch (error) {
      if (isBatchFatal(error)) throw error;
      items.push({
        kind,
        id,
        outcome: code(error) === 'MAPPING_INCOMPLETE' ? 'skipped' : 'failed',
        reason: code(error),
      });
    }
  };

  const pushPayment = async (payment: Payment) => {
    const id = String(payment.id);
    const prior = await syncs.findForPayment({
      tenantId: input.tenantId,
      realmId: scope.realmId,
      environment: scope.environment,
      paymentId: id,
    });
    if (prior?.status === 'synced') return;
    if (prior && prior.status !== 'rejected') {
      items.push({
        kind: 'payment',
        id,
        outcome: 'skipped',
        reason: prior.status === 'in_flight' ? 'in_flight' : 'reconciliation',
      });
      return;
    }
    try {
      const result = await syncPaymentToAccounting({
        db: input.db,
        tenantId: input.tenantId,
        paymentId: id,
        payments: input.payments,
        provider: input.provider,
      });
      pushed += 1;
      items.push({ kind: 'payment', id, outcome: result.status });
    } catch (error) {
      if (isBatchFatal(error)) throw error;
      const c = code(error);
      items.push({
        kind: 'payment',
        id,
        outcome: [
          'INVOICE_NOT_SYNCED',
          'PAYMENT_NOT_SYNCABLE',
          'MAPPING_INCOMPLETE',
        ].includes(c)
          ? 'skipped'
          : 'failed',
        reason: c,
      });
    }
  };

  while (pushed < limit && scanned < SCAN_CAP) {
    const size = Math.min(SCAN_PAGE, SCAN_CAP - scanned);
    const after = afterId ? { 'id >': afterId } : {};
    const page =
      phase === 'invoices'
        ? await invoices.list({
            where: { tenantId: input.tenantId, ...after },
            orderBy: 'id ASC',
            limit: size,
          })
        : await payments.list({
            where: {
              tenantId: input.tenantId,
              kind: 'payment',
              status: PaymentStatus.COMPLETED,
              ...after,
            },
            orderBy: 'id ASC',
            limit: size,
          });
    if (page.length === 0) {
      if (phase === 'payments') return { items, nextCursor: null };
      phase = 'payments';
      afterId = '';
      continue;
    }
    for (const row of page) {
      afterId = String(row.id);
      scanned += 1;
      if (phase === 'invoices') await pushInvoice(row as Invoice);
      else await pushPayment(row as Payment);
      if (pushed >= limit) break;
    }
  }
  return { items, nextCursor: `${phase}:${afterId}` };
}

/** Input of {@link readbackDue}. */
export interface ReadbackDueInput {
  readonly db: DatabaseInterface;
  /** Must be the active tenant. */
  readonly tenantId: string;
  readonly reader: AccountingInvoiceReader;
  /** Most invoices to read in this call (default 25, at most 100). */
  readonly limit?: number;
  /** Re-read invoices last read at or before this instant (default: 15 minutes ago). */
  readonly olderThan?: Date;
  /** Position from the previous call's `nextCursor`. */
  readonly cursor?: string;
  readonly now?: Date;
}

/**
 * Read back the tenant's synced invoices that have never been read, or were last
 * read before `olderThan`: at most `limit` reads and {@link SCAN_CAP} rows
 * examined per call, resumable through `cursor`. A failing read is recorded on
 * the invoice (`needs_reconciliation`) and the batch continues.
 */
export async function readbackDue(
  input: ReadbackDueInput,
): Promise<AccountingBatchResult> {
  principal(input.tenantId);
  const limit = bound(input.limit);
  const now = input.now ?? new Date();
  const cutoff = input.olderThan ?? new Date(now.getTime() - 15 * 60_000);
  const invoices = await InvoiceCollection.create({ db: input.db });
  const readbacks = await AccountingInvoiceReadbackCollection.create({
    db: input.db,
  });
  const items: AccountingBatchItem[] = [];
  let afterId =
    input.cursor === undefined ? '' : parseCursor(input.cursor).afterId;
  let done = 0;
  let scanned = 0;
  while (done < limit && scanned < SCAN_CAP) {
    const page = await invoices.list({
      where: {
        tenantId: input.tenantId,
        externalProvider: 'quickbooks',
        ...(afterId ? { 'id >': afterId } : {}),
      },
      orderBy: 'id ASC',
      limit: Math.min(SCAN_PAGE, SCAN_CAP - scanned),
    });
    if (page.length === 0) return { items, nextCursor: null };
    for (const invoice of page) {
      afterId = String(invoice.id);
      scanned += 1;
      const state = readFrozenAccountingSyncState(invoice);
      if (
        state?.status === 'synced' &&
        invoice.externalId &&
        invoice.kind === 'invoice' &&
        !invoice.ordinaryAccountingStateJson &&
        !invoice.retentionAccountingStateJson
      ) {
        const id = String(invoice.id);
        const last = await readbacks.findForInvoice(input.tenantId, id);
        if (
          !last?.observedAt ||
          last.observedAt.getTime() <= cutoff.getTime()
        ) {
          try {
            const result = await readbackInvoice({
              db: input.db,
              tenantId: input.tenantId,
              invoiceId: id,
              reader: input.reader,
              now,
            });
            done += 1;
            items.push({
              kind: 'readback',
              id,
              outcome: result.status,
              reason: result.reason || undefined,
            });
          } catch (error) {
            items.push({
              kind: 'readback',
              id,
              outcome: 'failed',
              reason: code(error),
            });
          }
        }
      }
      if (done >= limit) break;
    }
  }
  return { items, nextCursor: `invoices:${afterId}` };
}
