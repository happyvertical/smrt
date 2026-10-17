/** Ordinary canonical receivables: exact provider credit application and already-settled refund recording. */
import { createHash } from 'node:crypto';
import {
  type AccountingProvider,
  type CreditMemoInput,
  prepareQuickBooksInvoiceRequest,
  prepareQuickBooksReceivableRequest,
  type QuickBooksOrdinaryReceivableMapping,
  type QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import {
  type AccountingStep,
  type AccountingStepReconciliation,
  executeAccountingStep,
  reconcileAccountingStep,
} from './accounting-steps-internal.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { PaymentAllocationCollection } from './collections/PaymentAllocationCollection.js';
import { PaymentCollection } from './collections/PaymentCollection.js';
import { lockAndReloadInvoice } from './document-money.js';
import {
  DOCUMENT_MONEY_WRITE,
  isMoneyTransaction,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import {
  loadFrozenInvoiceAccountingSnapshot,
  type QuickBooksFrozenInvoiceMapping,
  type ReconcileFrozenInvoiceAccountingInput,
  readFrozenAccountingSyncState,
  reconcileFrozenInvoiceAccountingSync,
  syncFrozenInvoiceToAccounting,
  toFrozenInvoiceAccountingInput,
} from './invoice-accounting-sync.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import { withOrdinaryAccountingAuthority } from './ordinary-accounting-internal.js';
import { lockTenantMoneyRuntime } from './tenant-money-barrier.js';
import { InvoiceStatus } from './types/index.js';

type Provider = Pick<
  AccountingProvider,
  'type' | 'invoices' | 'creditMemos' | 'receivableTransfers'
>;
interface Scope {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  provider: Provider;
}
interface RefundRecording {
  paymentId: string;
  creditId: string;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
  amountMinor: number;
  paymentFingerprint: string;
  committed: boolean;
}
interface CreditAdjustment {
  creditId: string;
  moneySnapshotId: string;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
  grossMinor: number;
  appliedMinor: number;
  mapping: QuickBooksFrozenInvoiceMapping;
  committed: boolean;
}

export interface OrdinaryInvoiceAccountingState {
  version: 1;
  kind: 'ordinary';
  invoiceId: string;
  moneySnapshotId: string;
  externalInvoiceId: string | null;
  invoiceMapping: QuickBooksFrozenInvoiceMapping;
  requestId: string;
  evidenceRef: string;
  currency: string;
  grossMinor: number;
  mapping: QuickBooksOrdinaryReceivableMapping;
  status: 'pending' | 'ready';
  steps: AccountingStep[];
  credits: CreditAdjustment[];
  refunds: RefundRecording[];
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function reject(message: string): never {
  throw new MoneyValidationError(
    'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
    message,
  );
}
function text(value: string, label: string) {
  if (typeof value !== 'string' || !value || value.trim() !== value)
    reject(`${label} is required`);
}
function date(value: string, label: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    reject(`${label} is invalid`);
}
function principal(input: Scope) {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    reject('Ordinary accounting requires its active tenant');
  if (isMoneyTransaction(input.db))
    reject(
      'Provider writes cannot run inside a caller-owned money transaction',
    );
  if (
    input.provider.type !== 'quickbooks' ||
    !input.provider.receivableTransfers
  )
    reject('Provider lacks reviewed receivable operations');
}
function syncedIdentity(
  invoice: Invoice,
  mapping: QuickBooksOrdinaryReceivableMapping,
) {
  const sync = readFrozenAccountingSyncState(invoice);
  if (
    !sync ||
    sync.status !== 'synced' ||
    sync.documentKind !== 'invoice' ||
    sync.provider !== 'quickbooks' ||
    sync.moneySnapshotId !== invoice.moneySnapshotId ||
    sync.realmId !== mapping.realmId ||
    sync.environment !== mapping.environment ||
    invoice.externalProvider !== 'quickbooks' ||
    !invoice.externalId
  )
    reject(
      'Ordinary accounting requires its reconciled frozen invoice export identity',
    );
}
export function readOrdinaryInvoiceAccountingState(
  invoice: Invoice,
): OrdinaryInvoiceAccountingState | null {
  if (!invoice.ordinaryAccountingStateJson) return null;
  let state: OrdinaryInvoiceAccountingState;
  try {
    state = JSON.parse(invoice.ordinaryAccountingStateJson);
  } catch {
    return reject('Malformed ordinary accounting state');
  }
  if (
    !state ||
    !state.mapping ||
    state.version !== 1 ||
    state.kind !== 'ordinary' ||
    state.mapping.kind !== 'ordinary' ||
    state.invoiceId !== invoice.id ||
    state.moneySnapshotId !== invoice.moneySnapshotId ||
    (state.externalInvoiceId !== null &&
      state.externalInvoiceId !== invoice.externalId) ||
    state.currency !== invoice.currency ||
    state.grossMinor !== invoice.totalAmount ||
    state.mapping.customerRef !== invoice.customerExternalId ||
    !Array.isArray(state.steps) ||
    !Array.isArray(state.credits) ||
    !Array.isArray(state.refunds) ||
    invoice.retentionStateJson ||
    invoice.retentionAccountingStateJson ||
    invoice.moneyAuthority !== 'calculated'
  )
    reject('Ordinary provider source identity changed');
  if (state.externalInvoiceId !== null) syncedIdentity(invoice, state.mapping);
  return state;
}
async function locked<T>(
  input: Scope,
  operation: (
    invoice: Invoice,
    state: OrdinaryInvoiceAccountingState | null,
  ) => Promise<T>,
): Promise<T> {
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    return operation(invoice, readOrdinaryInvoiceAccountingState(invoice));
  });
}
async function save(invoice: Invoice, state: OrdinaryInvoiceAccountingState) {
  invoice.ordinaryAccountingStateJson = JSON.stringify(state);
  await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
}
function refreshStatus(state: OrdinaryInvoiceAccountingState) {
  state.status =
    state.steps.every((s) => s.status === 'confirmed') &&
    state.credits.every((c) => c.committed) &&
    state.refunds.every((r) => r.committed)
      ? 'ready'
      : 'pending';
}
function requireReady(
  state: OrdinaryInvoiceAccountingState | null,
): OrdinaryInvoiceAccountingState {
  if (
    !state ||
    state.status !== 'ready' ||
    state.steps.some((s) => s.status !== 'confirmed')
  )
    reject('Ordinary provider operations require reconciliation');
  return state;
}
function requestId(state: OrdinaryInvoiceAccountingState, key: string) {
  return `smrt_ord_${hash([state.invoiceId, state.moneySnapshotId, state.mapping.realmId, state.mapping.environment, key]).slice(0, 40)}`;
}
function executeStep(
  input: Scope,
  key: string,
  make: (
    invoice: Invoice,
    state: OrdinaryInvoiceAccountingState,
  ) => QuickBooksReceivableRequest,
) {
  return executeAccountingStep(
    {
      locked: (operation) => locked(input, operation),
      save,
      provider: input.provider.receivableTransfers!,
    },
    key,
    make,
  );
}
export interface SyncOrdinaryInvoiceToAccountingInput extends Scope {
  requestId: string;
  evidenceRef: string;
  mapping: QuickBooksOrdinaryReceivableMapping;
  invoiceMapping: QuickBooksFrozenInvoiceMapping;
}
function validateOrdinarySource(
  invoice: Invoice,
  input: SyncOrdinaryInvoiceToAccountingInput,
) {
  if (
    invoice.kind !== 'invoice' ||
    !invoice.moneySnapshotId ||
    invoice.retentionStateJson ||
    invoice.retentionAccountingStateJson ||
    invoice.moneyAuthority !== 'calculated' ||
    [
      InvoiceStatus.DRAFT,
      InvoiceStatus.CANCELLED,
      InvoiceStatus.WRITTEN_OFF,
    ].includes(invoice.status) ||
    invoice.collectionMethod ||
    invoice.providerTaxAmount ||
    invoice.currency !== input.mapping.currency ||
    invoice.customerExternalId !== input.mapping.customerRef ||
    input.invoiceMapping.realmId !== input.mapping.realmId ||
    input.invoiceMapping.environment !== input.mapping.environment
  )
    reject(
      'Ordinary accounting requires its issued, nonretained canonical frozen source',
    );
}
/** Retain exact reviewed mapping before the first possible remote invoice write. */
export async function syncOrdinaryInvoiceToAccounting(
  input: SyncOrdinaryInvoiceToAccountingInput,
): Promise<OrdinaryInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Ordinary request');
  text(input.evidenceRef, 'Ordinary evidence');
  if (input.mapping.kind !== 'ordinary') reject('Ordinary mapping is required');
  await locked(input, async (invoice) => {
    validateOrdinarySource(invoice, input);
    await toFrozenInvoiceAccountingInput({
      db: invoice.db,
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      mapping: input.invoiceMapping,
    });
  });
  await input.provider.receivableTransfers!.verifyMapping(input.mapping);
  await locked(input, async (invoice, state) => {
    validateOrdinarySource(invoice, input);
    // A generic exporter may already own this document. Compare its exact
    // prepared request while holding the same lock before retaining a mapping.
    const prior = readFrozenAccountingSyncState(invoice);
    if (prior) {
      const sdkInput = await toFrozenInvoiceAccountingInput({
        db: invoice.db,
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        mapping: input.invoiceMapping,
      });
      // Reconstruct the original creation payload, not an update to its result.
      const request = prepareQuickBooksInvoiceRequest(
        { ...sdkInput, externalId: undefined },
        {
          requestId: prior.requestId,
          realmId: input.invoiceMapping.realmId,
          environment: input.invoiceMapping.environment,
        },
      );
      if (
        prior.provider !== 'quickbooks' ||
        prior.documentKind !== 'invoice' ||
        prior.moneySnapshotId !== invoice.moneySnapshotId ||
        prior.realmId !== request.realmId ||
        prior.environment !== request.environment ||
        prior.request.payloadHash !== request.payloadHash
      )
        reject(
          'Ordinary invoice mapping differs from its frozen export request',
        );
    }
    if (state) {
      if (
        hash([
          state.requestId,
          state.evidenceRef,
          state.mapping,
          state.invoiceMapping,
        ]) !==
        hash([
          input.requestId,
          input.evidenceRef,
          input.mapping,
          input.invoiceMapping,
        ])
      )
        reject('Ordinary accounting initialization changed');
      return;
    }
    const next: OrdinaryInvoiceAccountingState = {
      version: 1,
      kind: 'ordinary',
      invoiceId: input.invoiceId,
      moneySnapshotId: invoice.moneySnapshotId,
      externalInvoiceId: null,
      invoiceMapping: structuredClone(input.invoiceMapping),
      requestId: input.requestId,
      evidenceRef: input.evidenceRef,
      currency: invoice.currency,
      grossMinor: invoice.totalAmount,
      mapping: structuredClone(input.mapping),
      status: 'pending',
      steps: [],
      credits: [],
      refunds: [],
    };
    await save(invoice, next);
  });
  const result = await withOrdinaryAccountingAuthority(
    input.tenantId,
    input.invoiceId,
    () =>
      syncFrozenInvoiceToAccounting({
        ...input,
        mapping: input.invoiceMapping,
      }),
  );
  return locked(input, async (invoice, state) => {
    if (!state) reject('Ordinary provider reservation disappeared');
    syncedIdentity(invoice, state.mapping);
    state.externalInvoiceId = result.externalId;
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}
export async function reconcileOrdinaryBaseInvoice(
  input: ReconcileFrozenInvoiceAccountingInput & { provider: Provider },
) {
  principal(input);
  await locked(input, async (_invoice, state) => {
    if (!state || hash(state.invoiceMapping) !== hash(input.mapping))
      reject('Ordinary base mapping differs');
  });
  return reconcileFrozenInvoiceAccountingSync(input);
}
export interface ReconcileOrdinaryAccountingStepInput
  extends Scope,
    AccountingStepReconciliation {}
export async function reconcileOrdinaryAccountingStep(
  input: ReconcileOrdinaryAccountingStepInput,
): Promise<OrdinaryInvoiceAccountingState> {
  principal(input);
  return reconcileAccountingStep(
    {
      locked: (operation) => locked(input, operation),
      save,
      provider: input.provider.receivableTransfers!,
    },
    input,
  );
}
export interface SyncOrdinaryCreditToAccountingInput extends Scope {
  creditInvoiceId: string;
  creditMapping: QuickBooksFrozenInvoiceMapping;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
}
/** Apply the reserved ordinary credit amount to its original due balance. */
export async function syncOrdinaryCreditToAccounting(
  input: SyncOrdinaryCreditToAccountingInput,
): Promise<OrdinaryInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Credit adjustment request');
  text(input.evidenceRef, 'Credit adjustment evidence');
  date(input.effectiveOn, 'Credit adjustment date');
  const reserved = await locked(input, async (invoice, state) => {
    if (!state) reject('Ordinary provider contract is missing');
    const credit = await (
      await InvoiceCollection.create({ db: invoice.db })
    ).get({ id: input.creditInvoiceId }, { cache: false });
    if (
      !credit ||
      credit.tenantId !== input.tenantId ||
      credit.customerId !== invoice.customerId ||
      credit.creditedInvoiceId !== invoice.id ||
      credit.kind !== 'credit_note' ||
      !credit.moneySnapshotId ||
      [InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED].includes(credit.status) ||
      credit.currency !== state.currency ||
      credit.customerExternalId !== state.mapping.customerRef
    )
      reject(
        'Credit adjustment requires its issued same-customer source credit',
      );
    if (
      input.creditMapping.realmId !== state.mapping.realmId ||
      input.creditMapping.environment !== state.mapping.environment
    )
      reject('Credit adjustment provider scope differs');
    const prior = state.credits.find(
      (c) =>
        c.creditId === input.creditInvoiceId || c.requestId === input.requestId,
    );
    if (prior) {
      if (
        prior.creditId !== input.creditInvoiceId ||
        prior.requestId !== input.requestId ||
        prior.moneySnapshotId !== credit.moneySnapshotId ||
        prior.grossMinor !== credit.totalAmount ||
        prior.evidenceRef !== input.evidenceRef ||
        prior.effectiveOn !== input.effectiveOn ||
        hash(prior.mapping) !== hash(input.creditMapping)
      )
        reject('Credit adjustment identity reused with changed facts');
      return structuredClone(prior);
    }
    requireReady(state);
    const previousGross = state.credits.reduce(
      (sum, c) => sum + c.grossMinor,
      0,
    );
    if (previousGross + credit.totalAmount > invoice.creditedAmount)
      reject('Provider credit exceeds issued source credit capacity');
    const next: CreditAdjustment = {
      creditId: input.creditInvoiceId,
      moneySnapshotId: credit.moneySnapshotId,
      requestId: input.requestId,
      evidenceRef: input.evidenceRef,
      effectiveOn: input.effectiveOn,
      grossMinor: credit.totalAmount,
      appliedMinor: credit.creditedAmount,
      mapping: structuredClone(input.creditMapping),
      committed: false,
    };
    state.credits.push(next);
    state.status = 'pending';
    await save(invoice, state);
    return next;
  });
  const creditResult = await withOrdinaryAccountingAuthority(
    input.tenantId,
    input.invoiceId,
    () =>
      syncFrozenInvoiceToAccounting({
        db: input.db,
        tenantId: input.tenantId,
        invoiceId: input.creditInvoiceId,
        provider: input.provider,
        mapping: input.creditMapping,
      }),
  );
  const prefix = `credit:${input.requestId}`;
  const creditSource = (state: OrdinaryInvoiceAccountingState) => ({
    type: 'CreditMemo' as const,
    id: creditResult.externalId,
    customerRef: state.mapping.customerRef,
    evidenceRef: reserved.moneySnapshotId,
  });
  if (reserved.appliedMinor > 0)
    await executeStep(input, `${prefix}:due-application`, (invoice, state) =>
      prepareQuickBooksReceivableRequest({
        kind: 'application',
        mapping: state.mapping,
        source: creditSource(state),
        requestId: requestId(state, `${prefix}:due-application`),
        effectiveOn: reserved.effectiveOn,
        evidenceRef: reserved.evidenceRef,
        amountMinor: reserved.appliedMinor,
        debit: { type: 'Invoice', id: invoice.externalId },
        credit: { type: 'CreditMemo', id: creditResult.externalId },
      }),
    );
  return locked(input, async (invoice, state) => {
    if (!state) reject('Ordinary provider state is missing');
    const credit = state.credits.find(
      (c) => c.creditId === input.creditInvoiceId,
    );
    if (!credit) reject('Credit reservation disappeared');
    credit.committed = true;
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}

export interface SyncOrdinaryRefundToAccountingInput extends Scope {
  paymentId: string;
  creditInvoiceId: string;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
}
/** Record an already settled local refund and consume its existing remote credit. No bank I/O. */
export async function syncOrdinaryRefundToAccounting(
  input: SyncOrdinaryRefundToAccountingInput,
): Promise<OrdinaryInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Refund recording request');
  text(input.evidenceRef, 'Refund settlement evidence');
  date(input.effectiveOn, 'Refund effective date');
  const reservation = await locked(input, async (invoice, state) => {
    if (!state) reject('Ordinary provider contract is missing');
    const credit = state.credits.find(
      (c) => c.creditId === input.creditInvoiceId && c.committed,
    );
    if (!credit) reject('Refund requires its reconciled provider credit');
    const payments = await PaymentCollection.create({ db: invoice.db }),
      payment = await payments.get({ id: input.paymentId }, { cache: false });
    const creditInvoice = await (
      await InvoiceCollection.create({ db: invoice.db })
    ).get({ id: input.creditInvoiceId }, { cache: false });
    if (
      !payment ||
      !creditInvoice ||
      payment.tenantId !== input.tenantId ||
      creditInvoice.tenantId !== input.tenantId ||
      creditInvoice.customerId !== invoice.customerId ||
      creditInvoice.currency !== state.currency ||
      creditInvoice.creditedInvoiceId !== invoice.id ||
      payment.customerId !== invoice.customerId ||
      payment.currency !== state.currency ||
      payment.kind !== 'refund' ||
      payment.status !== 'completed' ||
      !payment.journalId ||
      !payment.paidAt ||
      new Date(payment.paidAt).toISOString().slice(0, 10) !==
        input.effectiveOn ||
      !creditInvoice.externalId ||
      creditInvoice.moneySnapshotId !== credit.moneySnapshotId
    )
      reject(
        'Provider refund requires its completed same-customer local cash journal and source credit',
      );
    const allocations = await (
      await PaymentAllocationCollection.create({ db: invoice.db })
    ).findByPayment(input.paymentId);
    if (
      allocations.length !== 1 ||
      allocations[0].invoiceId !== input.creditInvoiceId ||
      allocations[0].amount !== payment.amount
    )
      reject(
        'Refund recording requires one exact full source-credit allocation',
      );
    const fingerprint = hash([
      payment.id,
      payment.customerId,
      payment.currency,
      payment.amount,
      payment.journalId,
      new Date(payment.paidAt).toISOString(),
      allocations[0].id,
      allocations[0].amount,
      credit.moneySnapshotId,
    ]);
    const next: RefundRecording = {
      paymentId: input.paymentId,
      creditId: input.creditInvoiceId,
      requestId: input.requestId,
      evidenceRef: input.evidenceRef,
      effectiveOn: input.effectiveOn,
      amountMinor: payment.amount,
      paymentFingerprint: fingerprint,
      committed: false,
    };
    const prior = state.refunds.find(
      (r) => r.paymentId === input.paymentId || r.requestId === input.requestId,
    );
    if (prior) {
      if (hash({ ...prior, committed: false }) !== hash(next))
        reject('Refund recording identity reused with changed facts');
      return { ...prior, externalCreditId: creditInvoice.externalId };
    }
    requireReady(state);
    if (!state.mapping.cashAccountRef)
      reject('Refund provider bank account must be explicitly reviewed');
    const already = state.refunds
      .filter((r) => r.creditId === input.creditInvoiceId)
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (already + payment.amount > credit.grossMinor - credit.appliedMinor)
      reject('Refund exceeds unapplied provider credit capacity');
    if (
      payment.ordinaryAccountingBindingJson ||
      payment.retentionAccountingBindingJson
    )
      reject('Refund is already bound to a provider operation');
    payment.ordinaryAccountingBindingJson = JSON.stringify({
      invoiceId: input.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      paymentFingerprint: fingerprint,
    });
    await withOrdinaryAccountingAuthority(input.tenantId, input.invoiceId, () =>
      payment.save(),
    );
    state.refunds.push(next);
    state.status = 'pending';
    await save(invoice, state);
    return { ...next, externalCreditId: creditInvoice.externalId };
  });
  const prefix = `refund:${input.requestId}`;
  const creditSource = (state: OrdinaryInvoiceAccountingState) => ({
    type: 'CreditMemo' as const,
    id: reservation.externalCreditId,
    customerRef: state.mapping.customerRef,
    evidenceRef: reservation.paymentFingerprint,
  });
  const journal = await executeStep(input, prefix, (_invoice, state) =>
    prepareQuickBooksReceivableRequest({
      kind: 'cash-refund',
      mapping: state.mapping,
      source: creditSource(state),
      requestId: requestId(state, prefix),
      effectiveOn: reservation.effectiveOn,
      evidenceRef: reservation.evidenceRef,
      amountMinor: reservation.amountMinor,
    }),
  );
  await executeStep(input, `${prefix}:application`, (_invoice, state) =>
    prepareQuickBooksReceivableRequest({
      kind: 'application',
      mapping: state.mapping,
      source: creditSource(state),
      requestId: requestId(state, `${prefix}:application`),
      effectiveOn: reservation.effectiveOn,
      evidenceRef: reservation.evidenceRef,
      amountMinor: reservation.amountMinor,
      debit: { type: 'JournalEntry', id: journal.externalId },
      credit: { type: 'CreditMemo', id: reservation.externalCreditId },
    }),
  );
  return locked(input, async (invoice, state) => {
    if (!state) reject('Ordinary provider state disappeared');
    const refund = state.refunds.find((r) => r.requestId === input.requestId);
    if (!refund) reject('Refund reservation disappeared');
    refund.committed = true;
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}

export interface ReconcileOrdinaryCreditAccountingInput extends Scope {
  creditInvoiceId: string;
  requestId: string;
  attemptId: string;
  confirmInterruptedOwnerStopped?: true;
  outcome: ReconcileFrozenInvoiceAccountingInput['outcome'];
}
/** Resolve an interrupted credit-memo export before its ordinary applications resume. */
export async function reconcileOrdinaryCreditAccounting(
  input: ReconcileOrdinaryCreditAccountingInput,
) {
  principal(input);
  const mapping = await locked(input, async (_invoice, state) => {
    const reserved = state?.credits.find(
      (credit) => credit.creditId === input.creditInvoiceId,
    );
    if (!reserved)
      reject('Ordinary credit has no approved provider reservation');
    return structuredClone(reserved.mapping);
  });
  return withOrdinaryAccountingAuthority(input.tenantId, input.invoiceId, () =>
    reconcileFrozenInvoiceAccountingSync({
      ...input,
      invoiceId: input.creditInvoiceId,
      mapping,
    }),
  );
}

export interface OrdinaryCreditReviewScope {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  creditInvoiceId: string;
}
async function reviewOrdinaryCredit<T>(
  input: OrdinaryCreditReviewScope,
  read: (scope: {
    db: DatabaseInterface;
    tenantId: string;
    invoiceId: string;
  }) => Promise<T>,
): Promise<T> {
  if (getTenantId() !== input.tenantId)
    reject('Ordinary review requires its active tenant');
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    if (!readOrdinaryInvoiceAccountingState(invoice))
      reject('Ordinary provider contract is missing');
    const credit = await (await InvoiceCollection.create({ db: tx })).get(
      { id: input.creditInvoiceId },
      { cache: false },
    );
    if (
      !credit ||
      credit.tenantId !== input.tenantId ||
      credit.creditedInvoiceId !== invoice.id ||
      credit.kind !== 'credit_note' ||
      credit.customerId !== invoice.customerId ||
      credit.currency !== invoice.currency ||
      credit.moneyAuthority !== 'calculated'
    )
      reject('Ordinary credit review requires exact source lineage');
    return withOrdinaryAccountingAuthority(
      input.tenantId,
      input.invoiceId,
      () =>
        read({
          db: tx,
          tenantId: input.tenantId,
          invoiceId: input.creditInvoiceId,
        }),
    );
  });
}
export function loadOrdinaryCreditAccountingSnapshot(
  input: OrdinaryCreditReviewScope,
) {
  return reviewOrdinaryCredit(input, loadFrozenInvoiceAccountingSnapshot);
}
export function toOrdinaryCreditAccountingInput(
  input: OrdinaryCreditReviewScope & {
    mapping: QuickBooksFrozenInvoiceMapping;
  },
): Promise<CreditMemoInput> {
  return reviewOrdinaryCredit(
    input,
    async (scope) =>
      (await toFrozenInvoiceAccountingInput({
        ...scope,
        mapping: input.mapping,
      })) as unknown as CreditMemoInput,
  );
}
