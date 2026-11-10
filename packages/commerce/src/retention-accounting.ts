/** Durable retained-invoice provider orchestration. Every remote write is a separate recoverable step. */
import { createHash } from 'node:crypto';
import {
  type AccountingProvider,
  type CreditMemoInput,
  prepareQuickBooksReceivableRequest,
  type QuickBooksReceivableMapping,
  type QuickBooksReceivableReadback,
  type QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { mapFrozenAccountingSnapshot } from './accounting-snapshot.js';
import {
  type AccountingStep,
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
  type FrozenInvoiceAccountingInput,
  loadFrozenInvoiceAccountingSnapshot,
  type QuickBooksFrozenInvoiceMapping,
  type ReconcileFrozenInvoiceAccountingInput,
  reconcileFrozenInvoiceAccountingSync,
  syncFrozenInvoiceToAccounting,
  toFrozenInvoiceAccountingInput,
} from './invoice-accounting-sync.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import { withRetentionAccountingAuthority } from './retention-accounting-internal.js';
import {
  calculateInvoicePayable,
  type InvoiceRetentionEvidence,
  parseInvoiceRetention,
  validateRetentionEvidence,
} from './retention-money.js';
import { lockTenantMoneyRuntime } from './tenant-money-barrier.js';
import { type AccountingInvoiceInput, InvoiceStatus } from './types/index.js';

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
  retainedMinor: number;
  appliedMinor: number;
  mapping: QuickBooksFrozenInvoiceMapping;
  committed: boolean;
}
interface Release extends InvoiceRetentionEvidence {
  amountMinor: number;
  effectiveOn: string;
  dueOn: string;
  stepKey: string;
  committed: boolean;
}
export interface RetainedInvoiceAccountingState {
  version: 1;
  invoiceId: string;
  moneySnapshotId: string;
  requestId: string;
  evidenceRef: string;
  currency: string;
  grossMinor: number;
  retainedMinor: number;
  retentionAgreementHash: string;
  effectiveOn: string;
  mapping: QuickBooksReceivableMapping;
  invoiceMapping: QuickBooksFrozenInvoiceMapping;
  status: 'pending' | 'ready';
  steps: AccountingStep[];
  releases: Release[];
  credits: CreditAdjustment[];
  refunds: RefundRecording[];
}
export interface SyncRetainedInvoiceToAccountingInput extends Scope {
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
  mapping: QuickBooksReceivableMapping;
  invoiceMapping: QuickBooksFrozenInvoiceMapping;
}
export interface ReleaseRetainedInvoiceToAccountingInput
  extends Scope,
    InvoiceRetentionEvidence {
  amountMinor: number;
  effectiveOn: string;
  dueOn: string;
  expectedUpdatedAt: string;
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
    reject('Retention accounting requires its active tenant');
  if (isMoneyTransaction(input.db))
    reject(
      'Provider writes cannot run inside a caller-owned money transaction',
    );
  if (
    input.provider.type !== 'quickbooks' ||
    !input.provider.receivableTransfers
  )
    reject('Provider lacks the reviewed receivable transfer capability');
}
export function readRetainedInvoiceAccountingState(
  invoice: Invoice,
): RetainedInvoiceAccountingState | null {
  if (!invoice.retentionAccountingStateJson) return null;
  let state: RetainedInvoiceAccountingState;
  try {
    state = JSON.parse(invoice.retentionAccountingStateJson);
  } catch {
    return reject('Malformed retained accounting state');
  }
  if (
    state.version !== 1 ||
    state.invoiceId !== invoice.id ||
    state.moneySnapshotId !== invoice.moneySnapshotId ||
    state.currency !== invoice.currency ||
    state.grossMinor !== invoice.totalAmount ||
    state.mapping.customerRef !== invoice.customerExternalId ||
    !Array.isArray(state.steps) ||
    !Array.isArray(state.releases) ||
    !Array.isArray(state.credits) ||
    !Array.isArray(state.refunds)
  )
    reject('Retention provider source identity changed');
  const retention = parseInvoiceRetention(invoice.retentionStateJson);
  if (!retention) reject('Provider retention agreement is missing');
  const { releases: _releases, ...agreement } = retention;
  if (state.retentionAgreementHash !== hash(agreement))
    reject('Provider retention agreement changed');
  return state;
}
/** Read-only review of the exact retained document; generic export stays blocked.
 * The host supplies authorization, and every read stays on the caller's executor.
 */
export async function loadRetainedInvoiceAccountingSnapshot(
  input: Omit<FrozenInvoiceAccountingInput, 'mapping'>,
) {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    reject('Retained accounting review requires its active tenant');
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    const retention = parseInvoiceRetention(invoice.retentionStateJson);
    if (
      !retention ||
      retention.retainedMinor <= 0 ||
      invoice.kind !== 'invoice' ||
      invoice.moneyAuthority === 'historical'
    )
      reject(
        'Retained accounting review requires a calculated retained invoice',
      );
    readRetainedInvoiceAccountingState(invoice);
    return withRetentionAccountingAuthority(
      input.tenantId,
      input.invoiceId,
      () => loadFrozenInvoiceAccountingSnapshot({ ...input, db: tx }),
    );
  });
}
/** Validate reviewed realm item/tax mapping without creating a provider operation. */
export async function toRetainedInvoiceAccountingInput(
  input: FrozenInvoiceAccountingInput,
) {
  const snapshot = await loadRetainedInvoiceAccountingSnapshot(input);
  return mapFrozenAccountingSnapshot(
    snapshot.document,
    input.mapping,
  ) as AccountingInvoiceInput;
}
type RetainedCreditReviewScope = Omit<
  FrozenInvoiceAccountingInput,
  'mapping'
> & {
  creditInvoiceId: string;
};
async function reviewRetainedCredit<T>(
  input: RetainedCreditReviewScope,
  read: (scope: Omit<FrozenInvoiceAccountingInput, 'mapping'>) => Promise<T>,
): Promise<T> {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    reject('Retained credit review requires its active tenant');
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    // The existing owning reader proves the original calculated retained invoice.
    const original = await loadRetainedInvoiceAccountingSnapshot({
      ...input,
      db: tx,
    });
    const { invoice: credit } = await lockAndReloadInvoice(
      tx,
      input.creditInvoiceId,
      input.tenantId,
    );
    if (
      credit.kind !== 'credit_note' ||
      credit.creditedInvoiceId !== input.invoiceId ||
      credit.customerId !== original.document.customerId ||
      credit.currency !== original.document.currency ||
      credit.moneyAuthority === 'historical'
    )
      reject(
        'Retained credit review requires its exact calculated source lineage',
      );
    return withRetentionAccountingAuthority(
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
/** Read an issued retained-first credit without permitting generic credit export. */
export function loadRetainedCreditAccountingSnapshot(
  input: RetainedCreditReviewScope,
) {
  return reviewRetainedCredit(input, loadFrozenInvoiceAccountingSnapshot);
}
/** Map a retained-first credit using the existing frozen reader's realm/lineage checks. */
export function toRetainedCreditAccountingInput(
  input: RetainedCreditReviewScope & {
    mapping: QuickBooksFrozenInvoiceMapping;
  },
): Promise<CreditMemoInput> {
  return reviewRetainedCredit(input, async (scope) => {
    // The owning review above proves credit_note; the legacy generic converter's
    // return declaration names InvoiceInput for both runtime document variants.
    return (await toFrozenInvoiceAccountingInput({
      ...scope,
      mapping: input.mapping,
    })) as unknown as CreditMemoInput;
  });
}

async function locked<T>(
  input: Scope,
  operation: (
    invoice: Invoice,
    state: RetainedInvoiceAccountingState | null,
  ) => Promise<T>,
): Promise<T> {
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    return operation(invoice, readRetainedInvoiceAccountingState(invoice));
  });
}
async function save(invoice: Invoice, state: RetainedInvoiceAccountingState) {
  invoice.retentionAccountingStateJson = JSON.stringify(state);
  await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
}
function refreshStatus(state: RetainedInvoiceAccountingState) {
  state.status =
    state.steps.every((step) => step.status === 'confirmed') &&
    state.releases.every((event) => event.committed) &&
    state.credits.every((event) => event.committed) &&
    state.refunds.every((event) => event.committed)
      ? 'ready'
      : 'pending';
}
function requireReady(
  state: RetainedInvoiceAccountingState | null,
): RetainedInvoiceAccountingState {
  if (
    !state ||
    state.status !== 'ready' ||
    state.steps.some((s) => s.status !== 'confirmed')
  )
    reject(
      'Retention provider bundle requires reconciliation before a new operation',
    );
  return state;
}
function requestId(state: RetainedInvoiceAccountingState, key: string) {
  return `smrt_ret_${hash([state.invoiceId, state.moneySnapshotId, state.mapping.realmId, state.mapping.environment, key]).slice(0, 40)}`;
}
function source(invoice: Invoice, state: RetainedInvoiceAccountingState) {
  if (!invoice.externalId || invoice.externalProvider !== 'quickbooks')
    reject('Retention needs a reconciled provider invoice');
  return {
    type: 'Invoice' as const,
    id: invoice.externalId,
    customerRef: state.mapping.customerRef,
    evidenceRef: state.moneySnapshotId,
  };
}
async function executeStep(
  input: Scope,
  key: string,
  make: (
    invoice: Invoice,
    state: RetainedInvoiceAccountingState,
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
/** Export unchanged gross/tax, then reclassify and apply its exact retained amount. */
export async function syncRetainedInvoiceToAccounting(
  input: SyncRetainedInvoiceToAccountingInput,
): Promise<RetainedInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Retention request');
  text(input.evidenceRef, 'Retention evidence');
  date(input.effectiveOn, 'Retention effective date');
  await input.provider.receivableTransfers!.verifyMapping(input.mapping);
  await locked(input, async (invoice, state) => {
    if (
      input.mapping.realmId !== input.invoiceMapping.realmId ||
      input.mapping.environment !== input.invoiceMapping.environment ||
      input.mapping.currency !== invoice.currency ||
      input.mapping.customerRef !== invoice.customerExternalId
    )
      reject(
        'Retention mapping differs from frozen invoice provider authority',
      );
    if (state) {
      if (
        hash([
          state.requestId,
          state.evidenceRef,
          state.effectiveOn,
          state.mapping,
          state.invoiceMapping,
        ]) !==
        hash([
          input.requestId,
          input.evidenceRef,
          input.effectiveOn,
          input.mapping,
          input.invoiceMapping,
        ])
      )
        reject('Retention provider contract is immutable');
      return;
    }
    if ('moneyAuthority' in invoice && invoice.moneyAuthority === 'historical')
      reject(
        'Historical source-owned invoices require an explicit reconciled provider authority contract; original journals cannot be duplicated',
      );
    const retention = parseInvoiceRetention(invoice.retentionStateJson);
    if (
      !retention ||
      retention.retainedMinor <= 0 ||
      retention.releases.length ||
      invoice.creditedAmount ||
      invoice.amountPaid ||
      !invoice.moneySnapshotId ||
      invoice.kind !== 'invoice' ||
      [
        InvoiceStatus.DRAFT,
        InvoiceStatus.CANCELLED,
        InvoiceStatus.WRITTEN_OFF,
      ].includes(invoice.status) ||
      invoice.externalId ||
      invoice.externalProvider ||
      invoice.accountingSyncStateJson ||
      invoice.collectionMethod ||
      invoice.providerTaxAmount
    )
      reject(
        'Initial provider retention requires an issued, uncredited, unpaid, unreleased host-owned retained invoice',
      );
    const { releases: _releases, ...agreement } = retention;
    state = {
      version: 1,
      invoiceId: input.invoiceId,
      moneySnapshotId: invoice.moneySnapshotId,
      requestId: input.requestId,
      evidenceRef: input.evidenceRef,
      effectiveOn: input.effectiveOn,
      currency: invoice.currency,
      grossMinor: invoice.totalAmount,
      retainedMinor: retention.retainedMinor,
      retentionAgreementHash: hash(agreement),
      mapping: structuredClone(input.mapping),
      invoiceMapping: structuredClone(input.invoiceMapping),
      status: 'pending',
      steps: [],
      releases: [],
      credits: [],
      refunds: [],
    };
    await save(invoice, state);
  });
  await withRetentionAccountingAuthority(input.tenantId, input.invoiceId, () =>
    syncFrozenInvoiceToAccounting({ ...input, mapping: input.invoiceMapping }),
  );
  const withheld = await executeStep(input, 'withhold', (invoice, state) =>
    prepareQuickBooksReceivableRequest({
      kind: 'withhold',
      mapping: state.mapping,
      source: source(invoice, state),
      requestId: requestId(state, 'withhold'),
      effectiveOn: state.effectiveOn,
      evidenceRef: state.evidenceRef,
      amountMinor: state.retainedMinor,
    }),
  );
  await executeStep(input, 'withhold-application', (invoice, state) =>
    prepareQuickBooksReceivableRequest({
      kind: 'application',
      mapping: state.mapping,
      source: source(invoice, state),
      requestId: requestId(state, 'withhold-application'),
      effectiveOn: state.effectiveOn,
      evidenceRef: state.evidenceRef,
      amountMinor: state.retainedMinor,
      debit: { type: 'Invoice', id: invoice.externalId },
      credit: { type: 'JournalEntry', id: withheld.externalId },
    }),
  );
  return locked(input, async (invoice, state) => {
    if (!state) reject('Missing retained provider state');
    if (
      state.steps.some((step) => step.status !== 'confirmed') ||
      state.releases.some((release) => !release.committed)
    )
      reject('Another retention operation is unfinished');
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}
/** Release date is provider TxnDate; dueOn remains explicit host collection policy. */
export async function releaseRetainedInvoiceToAccounting(
  input: ReleaseRetainedInvoiceToAccountingInput,
): Promise<RetainedInvoiceAccountingState> {
  principal(input);
  validateRetentionEvidence(input);
  date(input.effectiveOn, 'Release effective date');
  date(input.dueOn, 'Release due date');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0)
    reject('Release amount or due date is invalid');
  const key = `release:${input.requestId}`;
  await locked(input, async (invoice, state) => {
    if (!state) reject('Retention provider contract is missing');
    const prior = state.releases.find((r) => r.requestId === input.requestId);
    const release: Release = {
      requestId: input.requestId,
      policyVersion: input.policyVersion,
      evidenceRef: input.evidenceRef,
      actorId: input.actorId,
      reason: input.reason,
      amountMinor: input.amountMinor,
      effectiveOn: input.effectiveOn,
      dueOn: input.dueOn,
      stepKey: key,
      committed: false,
    };
    if (prior) {
      if (hash({ ...prior, committed: false }) !== hash(release))
        reject('Release request identity reused with changed facts');
      return;
    }
    requireReady(state);
    if (
      !invoice.updated_at ||
      new Date(invoice.updated_at).toISOString() !==
        new Date(input.expectedUpdatedAt).toISOString()
    )
      reject('Stale retention release revision');
    if (
      invoice.creditedAmount !==
      state.credits
        .filter((c) => c.committed)
        .reduce((sum, c) => sum + c.grossMinor, 0)
    )
      reject(
        'Provider retention credit adjustment must reconcile before release',
      );
    if (
      input.amountMinor >
      calculateInvoicePayable(invoice).retainedRemainingMinor
    )
      reject('Release exceeds retained capacity');
    state.releases.push(release);
    state.status = 'pending';
    await save(invoice, state);
  });
  await executeStep(input, key, (invoice, state) =>
    prepareQuickBooksReceivableRequest({
      kind: 'release',
      mapping: state.mapping,
      source: source(invoice, state),
      requestId: requestId(state, key),
      effectiveOn: input.effectiveOn,
      evidenceRef: input.evidenceRef,
      amountMinor: input.amountMinor,
    }),
  );
  return locked(input, async (invoice, state) => {
    if (!state) reject('Retention provider contract is missing');
    const release = state.releases.find((r) => r.requestId === input.requestId);
    if (!release) reject('Release reservation disappeared');
    if (!release.committed) {
      if (
        invoice.creditedAmount !==
          state.credits
            .filter((c) => c.committed)
            .reduce((sum, c) => sum + c.grossMinor, 0) ||
        input.amountMinor >
          calculateInvoicePayable(invoice).retainedRemainingMinor
      )
        reject(
          'Source capacity changed after provider release; reconciliation required',
        );
      const retention = parseInvoiceRetention(invoice.retentionStateJson)!;
      retention.releases.push({
        requestId: release.requestId,
        policyVersion: release.policyVersion,
        evidenceRef: release.evidenceRef,
        actorId: release.actorId,
        reason: release.reason,
        amountMinor: release.amountMinor,
        effectiveOn: release.effectiveOn,
        recordedAt: new Date().toISOString(),
      });
      invoice.retentionStateJson = JSON.stringify(retention);
      release.committed = true;
    }
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}
export interface ReconcileRetainedAccountingStepInput extends Scope {
  stepKey: string;
  requestId: string;
  attemptId: string;
  confirmInterruptedOwnerStopped?: true;
  outcome:
    | { status: 'found'; externalId: string }
    | { status: 'absent'; evidenceRef: string };
}
/** Unknown remote outcomes never reset on a guessed absence or an unobserved owner. */
export async function reconcileRetainedAccountingStep(
  input: ReconcileRetainedAccountingStepInput,
): Promise<RetainedInvoiceAccountingState> {
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
/** Reconcile the existing frozen invoice step using its established owner proof. */
export async function reconcileRetainedBaseInvoice(
  input: ReconcileFrozenInvoiceAccountingInput & { provider: Provider },
) {
  principal(input);
  await locked(input, async (_invoice, state) => {
    if (!state || hash(state.invoiceMapping) !== hash(input.mapping))
      reject('Retention base mapping differs');
  });
  return withRetentionAccountingAuthority(input.tenantId, input.invoiceId, () =>
    reconcileFrozenInvoiceAccountingSync(input),
  );
}

export interface SyncRetainedCreditToAccountingInput extends Scope {
  creditInvoiceId: string;
  creditMapping: QuickBooksFrozenInvoiceMapping;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
}
/** Apply retained-first credit to the retained asset, then to the original due balance. */
export async function syncRetainedCreditToAccounting(
  input: SyncRetainedCreditToAccountingInput,
): Promise<RetainedInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Credit adjustment request');
  text(input.evidenceRef, 'Credit adjustment evidence');
  date(input.effectiveOn, 'Credit adjustment date');
  const reserved = await locked(input, async (invoice, state) => {
    if (!state) reject('Retention provider contract is missing');
    const credit = await (
      await InvoiceCollection.create({ db: invoice.db })
    ).get({ id: input.creditInvoiceId }, { cache: false });
    if (
      !credit ||
      credit.tenantId !== input.tenantId ||
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
    const remainingRetained =
      state.retainedMinor -
      state.releases
        .filter((r) => r.committed)
        .reduce((sum, r) => sum + r.amountMinor, 0) -
      state.credits.reduce((sum, c) => sum + c.retainedMinor, 0);
    const retainedMinor = Math.min(remainingRetained, credit.totalAmount);
    if (retainedMinor < 0 || retainedMinor > credit.creditedAmount)
      reject('Retained-first credit exceeds its approved source allocation');
    const next: CreditAdjustment = {
      creditId: input.creditInvoiceId,
      moneySnapshotId: credit.moneySnapshotId,
      requestId: input.requestId,
      evidenceRef: input.evidenceRef,
      effectiveOn: input.effectiveOn,
      grossMinor: credit.totalAmount,
      retainedMinor,
      appliedMinor: credit.creditedAmount - retainedMinor,
      mapping: structuredClone(input.creditMapping),
      committed: false,
    };
    state.credits.push(next);
    state.status = 'pending';
    await save(invoice, state);
    return next;
  });
  const creditResult = await withRetentionAccountingAuthority(
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
  const creditSource = (state: RetainedInvoiceAccountingState) => ({
    type: 'CreditMemo' as const,
    id: creditResult.externalId,
    customerRef: state.mapping.customerRef,
    evidenceRef: reserved.moneySnapshotId,
  });
  if (reserved.retainedMinor > 0) {
    const cancelled = await executeStep(
      input,
      `${prefix}:retention`,
      (_invoice, state) =>
        prepareQuickBooksReceivableRequest({
          kind: 'release',
          mapping: state.mapping,
          source: creditSource(state),
          requestId: requestId(state, `${prefix}:retention`),
          effectiveOn: reserved.effectiveOn,
          evidenceRef: reserved.evidenceRef,
          amountMinor: reserved.retainedMinor,
        }),
    );
    await executeStep(
      input,
      `${prefix}:retention-application`,
      (_invoice, state) =>
        prepareQuickBooksReceivableRequest({
          kind: 'application',
          mapping: state.mapping,
          source: creditSource(state),
          requestId: requestId(state, `${prefix}:retention-application`),
          effectiveOn: reserved.effectiveOn,
          evidenceRef: reserved.evidenceRef,
          amountMinor: reserved.retainedMinor,
          debit: { type: 'JournalEntry', id: cancelled.externalId },
          credit: { type: 'CreditMemo', id: creditResult.externalId },
        }),
    );
  }
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
    if (!state) reject('Retention provider state is missing');
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

export interface SyncRetainedRefundToAccountingInput extends Scope {
  paymentId: string;
  creditInvoiceId: string;
  requestId: string;
  evidenceRef: string;
  effectiveOn: string;
}
/** Record an already settled local refund and consume its existing remote credit. No bank I/O. */
export async function syncRetainedRefundToAccounting(
  input: SyncRetainedRefundToAccountingInput,
): Promise<RetainedInvoiceAccountingState> {
  principal(input);
  text(input.requestId, 'Refund recording request');
  text(input.evidenceRef, 'Refund settlement evidence');
  date(input.effectiveOn, 'Refund effective date');
  const reservation = await locked(input, async (invoice, state) => {
    if (!state) reject('Retention provider contract is missing');
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
      payment.customerId !== invoice.customerId ||
      payment.currency !== state.currency ||
      payment.kind !== 'refund' ||
      payment.status !== 'completed' ||
      !payment.journalId ||
      !payment.paidAt ||
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
    if (
      already + payment.amount >
      credit.grossMinor - credit.retainedMinor - credit.appliedMinor
    )
      reject('Refund exceeds unapplied provider credit capacity');
    if (payment.retentionAccountingBindingJson)
      reject('Refund is already bound to a provider operation');
    payment.retentionAccountingBindingJson = JSON.stringify({
      invoiceId: input.invoiceId,
      tenantId: input.tenantId,
      requestId: input.requestId,
      paymentFingerprint: fingerprint,
    });
    await withRetentionAccountingAuthority(
      input.tenantId,
      input.invoiceId,
      () => payment.save(),
    );
    state.refunds.push(next);
    state.status = 'pending';
    await save(invoice, state);
    return { ...next, externalCreditId: creditInvoice.externalId };
  });
  const prefix = `refund:${input.requestId}`;
  const creditSource = (state: RetainedInvoiceAccountingState) => ({
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
    if (!state) reject('Retention provider state disappeared');
    const refund = state.refunds.find((r) => r.requestId === input.requestId);
    if (!refund) reject('Refund reservation disappeared');
    refund.committed = true;
    refreshStatus(state);
    await save(invoice, state);
    return state;
  });
}

export interface ReconcileRetainedCreditAccountingInput extends Scope {
  creditInvoiceId: string;
  requestId: string;
  attemptId: string;
  confirmInterruptedOwnerStopped?: true;
  outcome: ReconcileFrozenInvoiceAccountingInput['outcome'];
}
/** Resolve an interrupted credit-memo export before its retained-first applications resume. */
export async function reconcileRetainedCreditAccounting(
  input: ReconcileRetainedCreditAccountingInput,
) {
  principal(input);
  const mapping = await locked(input, async (_invoice, state) => {
    const reserved = state?.credits.find(
      (credit) => credit.creditId === input.creditInvoiceId,
    );
    if (!reserved)
      reject('Retained credit has no approved provider reservation');
    return structuredClone(reserved.mapping);
  });
  return withRetentionAccountingAuthority(input.tenantId, input.invoiceId, () =>
    reconcileFrozenInvoiceAccountingSync({
      ...input,
      invoiceId: input.creditInvoiceId,
      mapping,
    }),
  );
}
