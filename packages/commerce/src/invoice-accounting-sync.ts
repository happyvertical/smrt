import { hasOrdinaryAccountingAuthority } from './ordinary-accounting-internal.js';
import { hasRetentionAccountingAuthority } from './retention-accounting-internal.js';
/** Frozen Invoice projection and guarded accounting-provider synchronization. */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
  InvoiceInput,
  QuickBooksCreditMemoRequest,
  QuickBooksInvoiceRequest,
  SyncResult,
} from '@happyvertical/accounting';
import {
  prepareQuickBooksCreditMemoRequest,
  prepareQuickBooksInvoiceRequest,
  requireCreditMemoOperations,
} from '@happyvertical/accounting';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import {
  type AccountingSnapshotInput,
  type FrozenAccountingDocumentSnapshot,
  type FrozenQuickBooksTaxMapping,
  mapFrozenAccountingSnapshot,
} from './accounting-snapshot.js';
import { DocumentTaxCollection } from './collections/DocumentTaxCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { lockAndReloadInvoice } from './document-money.js';
import {
  DOCUMENT_MONEY_WRITE,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import type { Invoice } from './models/Invoice.js';
import type { InvoiceLineItem } from './models/InvoiceLineItem.js';
import { MoneyValidationError } from './money.js';
import {
  pilotDisagreement,
  projectQuickBooksPilotEvidence,
  type QuickBooksPilotAcceptance,
  type QuickBooksPilotInvoiceEvidence,
  type QuickBooksPilotProjection,
  type QuickBooksPilotScope,
  quickBooksPilotInvoiceId,
} from './quickbooks-pilot-evidence.js';
import { lockTenantMoneyRuntime } from './tenant-money-barrier.js';
import { type AccountingInvoiceInput, InvoiceStatus } from './types/index.js';

export interface QuickBooksFrozenInvoiceMapping
  extends FrozenQuickBooksTaxMapping {
  readonly realmId: string;
  readonly environment: 'sandbox' | 'production';
}

export interface FrozenInvoiceAccountingOptions {
  readonly mapping: QuickBooksFrozenInvoiceMapping;
}

export interface FrozenInvoiceAccountingInput
  extends FrozenInvoiceAccountingOptions {
  readonly db: DatabaseInterface;
  readonly tenantId: string;
  readonly invoiceId: string;
}

export interface FrozenInvoiceAccountingSnapshot {
  readonly document: FrozenAccountingDocumentSnapshot;
  readonly moneySnapshotId: string;
  readonly creditedInvoiceScope?: Readonly<{
    provider: 'quickbooks';
    realmId: string;
    environment: 'sandbox' | 'production';
  }>;
}

type FrozenSyncStatus = 'in_flight' | 'unknown' | 'rejected' | 'synced';

interface FrozenSyncIdentity {
  provider: 'quickbooks';
  documentKind: 'invoice' | 'creditMemo';
  realmId: string;
  environment: 'sandbox' | 'production';
  invoiceId: string;
  moneySnapshotId: string;
  requestId: string;
  payloadHash: string;
  creditedInvoiceExternalId?: string;
}

interface FrozenSyncState {
  version: 1;
  status: FrozenSyncStatus;
  identity: FrozenSyncIdentity;
  attemptId: string;
  startedAt: string;
  externalId?: string;
  syncedAt?: string;
  pilot?: QuickBooksPilotAcceptance;
  pilotProjection?: QuickBooksPilotProjection;
}

export interface FrozenAccountingSyncResult {
  readonly status: 'synced' | 'unchanged';
  readonly externalId: string;
  readonly syncedAt: Date;
  readonly moneySnapshotId: string;
}

export interface SyncFrozenInvoiceToAccountingInput
  extends FrozenInvoiceAccountingInput {
  readonly provider: Pick<
    AccountingProvider,
    'type' | 'invoices' | 'creditMemos'
  >;
}

export interface ReconcileFrozenInvoiceAccountingInput
  extends FrozenInvoiceAccountingInput {
  /** The request descriptor observed before checking QuickBooks. */
  readonly requestId: string;
  /** The unresolved local owner observed with that request descriptor. */
  readonly attemptId: string;
  /**
   * Required only for an interrupted `in_flight` record. The trusted server
   * caller must first establish that the original process/request owner can no
   * longer complete. A provider lookup reporting absence is not sufficient.
   */
  readonly confirmInterruptedOwnerStopped?: true;
  /**
   * The authoritative result of looking up that request in QuickBooks.
   * `absent` means QuickBooks confirmed that no document was created.
   */
  readonly outcome:
    | {
        readonly status: 'found';
        readonly externalId: string;
        readonly syncedAt: Date;
      }
    | { readonly status: 'absent' };
}

export interface FrozenAccountingReconciliationReady {
  readonly status: 'ready';
  readonly moneySnapshotId: string;
  readonly requestId: string;
}

type FrozenInvoicePushInput = Omit<
  SyncFrozenInvoiceToAccountingInput,
  'provider'
> & {
  readonly provider: Omit<
    SyncFrozenInvoiceToAccountingInput['provider'],
    'invoices'
  > & {
    readonly invoices: Pick<AccountingProvider['invoices'], 'push'>;
  };
};

interface PreparedSync {
  kind: 'push';
  documentKind: 'invoice' | 'creditMemo';
  accountingInput: AccountingSnapshotInput;
  invoice: Invoice;
  identity: FrozenSyncIdentity;
  attemptId: string;
}

interface UnchangedSync {
  kind: 'unchanged';
  result: FrozenAccountingSyncResult;
}

function requiredText(value: string, label: string): string {
  if (!value || value.trim() !== value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} must be a nonempty trimmed string`,
    );
  return value;
}

function assertPrincipalTenant(tenantId: string): void {
  requiredText(tenantId, 'Accounting tenant');
  if (getTenantId() !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Accounting sync requires its active principal tenant',
    );
}

function unsupported(message: string): never {
  throw new MoneyValidationError('ACCOUNTING_SYNC_UNSUPPORTED', message);
}

function parseSyncState(value: string): FrozenSyncState | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') throw new Error('not object');
    const state = parsed as Partial<FrozenSyncState>;
    const identity = state.identity as Partial<FrozenSyncIdentity> | undefined;
    if (
      state.version !== 1 ||
      !['in_flight', 'unknown', 'rejected', 'synced'].includes(
        String(state.status),
      ) ||
      !identity ||
      identity.provider !== 'quickbooks' ||
      typeof identity.realmId !== 'string' ||
      (identity.environment !== 'sandbox' &&
        identity.environment !== 'production') ||
      typeof identity.invoiceId !== 'string' ||
      typeof identity.moneySnapshotId !== 'string' ||
      typeof identity.requestId !== 'string' ||
      typeof identity.payloadHash !== 'string' ||
      (identity.documentKind !== undefined &&
        identity.documentKind !== 'invoice' &&
        identity.documentKind !== 'creditMemo') ||
      (identity.creditedInvoiceExternalId !== undefined &&
        typeof identity.creditedInvoiceExternalId !== 'string') ||
      typeof state.attemptId !== 'string' ||
      typeof state.startedAt !== 'string'
    )
      throw new Error('invalid shape');
    return {
      ...(state as FrozenSyncState),
      identity: {
        ...(identity as FrozenSyncIdentity),
        documentKind: identity.documentKind ?? 'invoice',
      },
    };
  } catch {
    throw new MoneyValidationError(
      'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      'Stored accounting sync state is malformed and requires reconciliation',
    );
  }
}

function sameIdentity(
  left: FrozenSyncIdentity,
  right: FrozenSyncIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.documentKind === right.documentKind &&
    left.realmId === right.realmId &&
    left.environment === right.environment &&
    left.invoiceId === right.invoiceId &&
    left.moneySnapshotId === right.moneySnapshotId &&
    left.requestId === right.requestId &&
    left.payloadHash === right.payloadHash &&
    left.creditedInvoiceExternalId === right.creditedInvoiceExternalId
  );
}

function sameSyncScope(
  identity: FrozenSyncIdentity,
  snapshot: FrozenInvoiceAccountingSnapshot,
  mapping: QuickBooksFrozenInvoiceMapping,
): boolean {
  return (
    identity.provider === 'quickbooks' &&
    identity.documentKind === snapshot.document.kind &&
    identity.realmId === mapping.realmId &&
    identity.environment === mapping.environment &&
    identity.invoiceId === snapshot.document.id &&
    identity.moneySnapshotId === snapshot.moneySnapshotId
  );
}

function sum(values: readonly number[]): number {
  let result = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value))
      throw new MoneyValidationError(
        'UNSAFE_MONEY',
        'Frozen accounting facts require safe integer minor units',
      );
    result += BigInt(value);
  }
  if (
    result > BigInt(Number.MAX_SAFE_INTEGER) ||
    result < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      'Frozen accounting totals exceed safe integer minor units',
    );
  return Number(result);
}

function componentTotals(
  lines: readonly InvoiceLineItem[],
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    for (const component of line.taxComponents) {
      totals.set(
        component.taxComponentId,
        sum([totals.get(component.taxComponentId) ?? 0, component.taxMinor]),
      );
    }
  }
  return totals;
}

async function loadSnapshot(
  db: DatabaseInterface,
  tenantId: string,
  invoice: Invoice,
): Promise<FrozenInvoiceAccountingSnapshot> {
  if (invoice.moneyAuthority === 'historical')
    throw new MoneyValidationError(
      'ACCOUNTING_SYNC_UNSUPPORTED',
      'Historical sales source money requires an explicit reviewed provider representation; no quantities or tax breakdown will be invented',
    );

  if (invoice.tenantId !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Accounting invoice cannot cross tenant boundaries',
    );
  if (invoice.status === InvoiceStatus.DRAFT || !invoice.moneySnapshotId)
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Accounting sync requires an issued frozen invoice',
    );
  if (
    (invoice.getPayableFacts().retainedRemainingMinor > 0 ||
      invoice.retentionAccountingStateJson) &&
    !hasRetentionAccountingAuthority(invoice.tenantId, invoice.id)
  )
    unsupported(
      'Unreleased retention requires a provider payable representation',
    );
  if (invoice.status === InvoiceStatus.CANCELLED)
    unsupported('Cancelled documents cannot be created by accounting sync');

  const lines = await (
    await InvoiceLineItemCollection.create({ db })
  ).findByInvoice(requiredText(invoice.id ?? '', 'Accounting invoice ID'));
  if (lines.length === 0)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Frozen accounting invoice requires at least one line',
    );
  for (const line of lines) {
    if (
      line.tenantId !== tenantId ||
      line.moneySnapshotId !== invoice.moneySnapshotId
    )
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Accounting line snapshot does not match its frozen invoice',
      );
  }
  const taxes = await (
    await DocumentTaxCollection.create({ db })
  ).findByDocument(tenantId, invoice.kind, invoice.id ?? '');
  const lineTax = sum(lines.map((line) => line.taxAmount));
  const storedTax = sum(taxes.map((row) => row.taxMinor));
  if (
    lineTax + invoice.providerTaxAmount !== invoice.taxAmount ||
    storedTax !== lineTax
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Frozen line, DocumentTax, and invoice tax totals do not reconcile',
    );
  const lineComponents = componentTotals(lines);
  const storedComponents = new Map<string, number>();
  for (const row of taxes) {
    if (!row.taxComponentId) continue;
    storedComponents.set(
      row.taxComponentId,
      sum([storedComponents.get(row.taxComponentId) ?? 0, row.taxMinor]),
    );
  }
  if (
    [...new Set([...lineComponents.keys(), ...storedComponents.keys()])].some(
      (id) => (lineComponents.get(id) ?? 0) !== (storedComponents.get(id) ?? 0),
    )
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Frozen line components do not reconcile to DocumentTax',
    );

  let creditedInvoiceExternalId: string | undefined;
  let creditedInvoiceScope:
    | FrozenInvoiceAccountingSnapshot['creditedInvoiceScope']
    | undefined;
  if (invoice.kind === 'credit_note') {
    if (!invoice.creditedInvoiceId)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Frozen credit note requires its credited invoice',
      );
    const source = await (await InvoiceCollection.create({ db })).get(
      { id: invoice.creditedInvoiceId },
      { cache: false },
    );
    if (!source || source.tenantId !== tenantId || !source.externalId)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Frozen credit note requires the source invoice external ID',
      );
    if (
      source.retentionAccountingStateJson &&
      !hasRetentionAccountingAuthority(source.tenantId, source.id)
    )
      unsupported(
        'Provider-retained credit requires the retained-first accounting adjustment command',
      );
    if (
      source.ordinaryAccountingStateJson &&
      !hasOrdinaryAccountingAuthority(source.tenantId, source.id)
    )
      unsupported(
        'Provider ordinary credit requires its owning accounting adjustment command',
      );
    const sourceState = parseSyncState(source.accountingSyncStateJson);
    if (
      sourceState?.status !== 'synced' ||
      sourceState.externalId !== source.externalId
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Frozen credit note requires a reconciled source invoice accounting identity',
      );
    creditedInvoiceExternalId = source.externalId;
    creditedInvoiceScope = {
      provider: sourceState.identity.provider,
      realmId: sourceState.identity.realmId,
      environment: sourceState.identity.environment,
    };
  }

  return {
    moneySnapshotId: invoice.moneySnapshotId,
    creditedInvoiceScope,
    document: {
      kind: invoice.kind === 'invoice' ? 'invoice' : 'creditMemo',
      id: invoice.id ?? '',
      number: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerExternalId: invoice.customerExternalId || undefined,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate ?? undefined,
      currency: invoice.currency,
      lineAmountType: invoice.lineAmountType,
      taxRoundingScope: invoice.taxRoundingScope,
      subtotalMinor: invoice.subtotal,
      taxAmountMinor: invoice.taxAmount,
      providerTaxMinor: invoice.providerTaxAmount,
      totalAmountMinor: invoice.totalAmount,
      lineItems: lines.map((line) => ({
        id: requiredText(line.id ?? '', 'Accounting line ID'),
        description: line.description,
        sku: line.sku || undefined,
        quantity: line.quantity,
        unitPriceMinor: line.unitPrice,
        discountMinor: line.discount,
        amountMinor:
          invoice.lineAmountType === 'inclusive'
            ? line.amount - line.taxAmount
            : line.amount,
        taxMinor: line.taxAmount,
        taxComponents: structuredClone(line.taxComponents),
      })),
      creditedInvoiceExternalId,
      externalId: invoice.externalId || undefined,
      reference: invoice.reference || undefined,
      memo: invoice.customerNotes || undefined,
    },
  };
}

function validateMapping(mapping: QuickBooksFrozenInvoiceMapping): void {
  requiredText(mapping.realmId, 'QuickBooks realm ID');
  if (mapping.environment !== 'sandbox' && mapping.environment !== 'production')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'QuickBooks environment must be sandbox or production',
    );
  if (!mapping.lines || typeof mapping.lines !== 'object')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'QuickBooks line mapping is required',
    );
  if (!mapping.components || typeof mapping.components !== 'object')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'QuickBooks component mapping is required',
    );
}

function toSdkInput(
  snapshot: FrozenInvoiceAccountingSnapshot,
  mapping: QuickBooksFrozenInvoiceMapping,
): AccountingSnapshotInput {
  validateMapping(mapping);
  if (
    snapshot.document.kind === 'creditMemo' &&
    (snapshot.creditedInvoiceScope?.provider !== 'quickbooks' ||
      snapshot.creditedInvoiceScope.realmId !== mapping.realmId ||
      snapshot.creditedInvoiceScope.environment !== mapping.environment)
  )
    throw new MoneyValidationError(
      'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
      'Credit note and credited invoice must use the same accounting provider, realm, and environment',
    );
  if (
    snapshot.document.lineItems.some(
      (line) =>
        line.quantity < 0 || line.amountMinor < 0 || line.unitPriceMinor < 0,
    )
  )
    unsupported(
      'Signed-line accounting sync requires a public accounting SDK signed-line representation',
    );
  return mapFrozenAccountingSnapshot(snapshot.document, mapping);
}

/** Load and validate one authoritative issued snapshot without provider I/O. */
export async function loadFrozenInvoiceAccountingSnapshot(
  input: Omit<FrozenInvoiceAccountingInput, 'mapping'>,
): Promise<FrozenInvoiceAccountingSnapshot> {
  assertPrincipalTenant(input.tenantId);
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    return loadSnapshot(tx, input.tenantId, invoice);
  });
}

/** Convert authoritative persisted facts into the released SDK invoice shape. */
export async function toFrozenInvoiceAccountingInput(
  input: FrozenInvoiceAccountingInput,
): Promise<AccountingInvoiceInput> {
  const snapshot = await loadFrozenInvoiceAccountingSnapshot(input);
  return toSdkInput(snapshot, input.mapping) as AccountingInvoiceInput;
}

function prepareRequest(
  snapshot: FrozenInvoiceAccountingSnapshot,
  mapping: QuickBooksFrozenInvoiceMapping,
  sdkInput: AccountingSnapshotInput,
): {
  accountingInput: AccountingSnapshotInput;
  request: QuickBooksInvoiceRequest | QuickBooksCreditMemoRequest;
} {
  const identity = {
    requestId: requestIdFor(snapshot, mapping),
    realmId: mapping.realmId,
    environment: mapping.environment,
  } as const;
  if (snapshot.document.kind === 'invoice') {
    if (!('invoiceNumber' in sdkInput))
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Frozen invoice mapping produced the wrong accounting document kind',
      );
    const request = prepareQuickBooksInvoiceRequest(sdkInput, identity);
    return {
      request,
      accountingInput: {
        ...sdkInput,
        idempotencyKey: request.requestId,
        quickbooksRequest: request,
      },
    };
  }
  if (!('creditMemoNumber' in sdkInput))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Frozen credit-note mapping produced the wrong accounting document kind',
    );
  const request = prepareQuickBooksCreditMemoRequest(sdkInput, identity);
  return {
    request,
    accountingInput: {
      ...sdkInput,
      quickbooksCreditMemoRequest: request,
    },
  };
}

function requestIdFor(
  snapshot: FrozenInvoiceAccountingSnapshot,
  mapping: QuickBooksFrozenInvoiceMapping,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'quickbooks',
        mapping.realmId,
        mapping.environment,
        snapshot.document.id,
        snapshot.moneySnapshotId,
      ]),
    )
    .digest('hex');
  return `smrt_${digest.slice(0, 40)}`;
}

async function prepareSync(
  input: FrozenInvoicePushInput,
  pilot?: QuickBooksPilotAcceptance,
): Promise<PreparedSync | UnchangedSync> {
  if (input.provider.type !== 'quickbooks')
    unsupported(
      `Frozen accounting sync does not support provider '${input.provider.type}'`,
    );
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    if (
      invoice.ordinaryAccountingStateJson &&
      !hasOrdinaryAccountingAuthority(invoice.tenantId, invoice.id)
    )
      unsupported(
        'Provider ordinary invoice requires its owning accounting command',
      );
    const snapshot = await loadSnapshot(tx, input.tenantId, invoice);
    const sdkInput = toSdkInput(snapshot, input.mapping);
    const prior = parseSyncState(invoice.accountingSyncStateJson);
    checkPilotAcceptance(invoice, prior, pilot);
    if (pilot) assertPilotInvoice(invoice);
    if (
      prior?.status === 'synced' &&
      sameSyncScope(prior.identity, snapshot, input.mapping)
    ) {
      if (!prior.externalId || !prior.syncedAt)
        throw new MoneyValidationError(
          'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
          'Completed accounting sync state is incomplete',
        );
      return {
        kind: 'unchanged',
        result: {
          status: 'unchanged',
          externalId: prior.externalId,
          syncedAt: new Date(prior.syncedAt),
          moneySnapshotId: prior.identity.moneySnapshotId,
        },
      };
    }
    if (prior?.status === 'in_flight')
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_IN_PROGRESS',
        'Another accounting sync owns this invoice',
      );
    if (prior?.status === 'unknown')
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'The prior accounting write outcome is unknown and must be reconciled',
      );
    if (prior?.status === 'synced' || invoice.externalId)
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Invoice accounting identity changed across provider, realm, environment, or snapshot',
      );
    if (snapshot.document.kind === 'creditMemo') {
      try {
        requireCreditMemoOperations(input.provider);
      } catch (error) {
        unsupported(error instanceof Error ? error.message : String(error));
      }
    }
    const { accountingInput, request } = prepareRequest(
      snapshot,
      input.mapping,
      sdkInput,
    );
    const identity = frozenIdentity(snapshot, request);
    if (prior && !sameIdentity(prior.identity, identity))
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Invoice accounting identity changed across provider, realm, environment, or snapshot',
      );

    const attemptId = randomUUID();
    invoice.accountingSyncStateJson = JSON.stringify({
      version: 1,
      status: 'in_flight',
      identity,
      attemptId,
      startedAt: new Date().toISOString(),
      pilot,
    } satisfies FrozenSyncState);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    return {
      kind: 'push',
      documentKind: snapshot.document.kind,
      accountingInput,
      invoice,
      identity,
      attemptId,
    };
  });
}

async function recordFailure(
  input: FrozenInvoicePushInput,
  prepared: PreparedSync,
  error: unknown,
  pushReturned: boolean,
): Promise<void> {
  const rejected =
    !pushReturned &&
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'QBO_WRITE_ERROR' &&
    (error as { outcome?: unknown }).outcome === 'rejected';
  await withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    const state = parseSyncState(invoice.accountingSyncStateJson);
    if (
      !state ||
      state.attemptId !== prepared.attemptId ||
      !sameIdentity(state.identity, prepared.identity)
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Accounting sync ownership changed after provider failure',
      );
    invoice.accountingSyncStateJson = JSON.stringify({
      ...state,
      status: rejected ? 'rejected' : 'unknown',
    } satisfies FrozenSyncState);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
  });
}

async function saveSyncedInvoice(
  invoice: Invoice,
  state: FrozenSyncState,
  externalId: string,
  syncedAt: Date,
): Promise<FrozenAccountingSyncResult> {
  invoice.externalId = externalId;
  invoice.externalProvider = state.identity.provider;
  invoice.syncedAt = syncedAt;
  invoice.accountingSyncStateJson = JSON.stringify({
    ...state,
    status: 'synced',
    externalId,
    syncedAt: syncedAt.toISOString(),
  } satisfies FrozenSyncState);
  await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
  return {
    status: 'synced',
    externalId,
    syncedAt,
    moneySnapshotId: state.identity.moneySnapshotId,
  };
}

async function recordSuccess(
  input: FrozenInvoicePushInput,
  prepared: PreparedSync,
  result: SyncResult,
  pilotProjection?: QuickBooksPilotProjection,
): Promise<FrozenAccountingSyncResult> {
  requiredText(result.externalId, 'Accounting external ID');
  if (
    !(result.syncedAt instanceof Date) ||
    Number.isNaN(result.syncedAt.valueOf())
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Accounting provider returned an invalid sync timestamp',
    );
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    const state = parseSyncState(invoice.accountingSyncStateJson);
    if (
      state?.status !== 'in_flight' ||
      state.attemptId !== prepared.attemptId ||
      !sameIdentity(state.identity, prepared.identity) ||
      invoice.moneySnapshotId !== prepared.identity.moneySnapshotId ||
      (state.pilot &&
        invoice.customerExternalId !== prepared.invoice.customerExternalId)
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Accounting sync ownership or frozen snapshot changed after provider write',
      );
    if (state.pilot)
      await assertUnusedPilotExternalId(
        tx,
        invoice,
        state.identity,
        result.externalId,
      );
    return saveSyncedInvoice(
      invoice,
      { ...state, pilotProjection },
      result.externalId,
      result.syncedAt,
    );
  });
}

/**
 * Push one frozen invoice exactly once per provider/realm/environment/snapshot.
 * Local and remote writes are intentionally separate phases. An unknown remote
 * outcome is persisted and requires reconciliation instead of a blind replay.
 */
export async function syncFrozenInvoiceToAccounting(
  input: SyncFrozenInvoiceToAccountingInput,
): Promise<FrozenAccountingSyncResult> {
  return syncFrozenInvoice(input);
}

async function syncFrozenInvoice(
  input: FrozenInvoicePushInput,
  pilot?: {
    acceptance: QuickBooksPilotAcceptance;
    verify(
      invoice: Invoice,
      result: SyncResult,
    ): Promise<QuickBooksPilotProjection>;
  },
): Promise<FrozenAccountingSyncResult> {
  assertPrincipalTenant(input.tenantId);
  const prepared = await prepareSync(input, pilot?.acceptance);
  if (prepared.kind === 'unchanged') return prepared.result;
  let result: SyncResult;
  let pushReturned = false;
  let projection: QuickBooksPilotProjection | undefined;
  try {
    if (prepared.documentKind === 'invoice') {
      if (!('invoiceNumber' in prepared.accountingInput))
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Prepared invoice has the wrong accounting document kind',
        );
      result = await input.provider.invoices.push(prepared.accountingInput);
    } else {
      if (!('creditMemoNumber' in prepared.accountingInput))
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Prepared credit note has the wrong accounting document kind',
        );
      result = await requireCreditMemoOperations(input.provider).push(
        prepared.accountingInput,
      );
    }
    pushReturned = true;
    projection = await pilot?.verify(prepared.invoice, result);
  } catch (error) {
    await recordFailure(input, prepared, error, pushReturned);
    throw error;
  }
  return recordSuccess(input, prepared, result, projection);
}

/**
 * Record an authoritative QuickBooks lookup after an unknown/interrupted push.
 * The caller must first query the exact persisted request descriptor and must
 * only report `absent` when the provider confirms that no document exists.
 */
export async function reconcileFrozenInvoiceAccountingSync(
  input: ReconcileFrozenInvoiceAccountingInput,
): Promise<FrozenAccountingSyncResult | FrozenAccountingReconciliationReady> {
  assertPrincipalTenant(input.tenantId);
  requiredText(input.requestId, 'Accounting request ID');
  requiredText(input.attemptId, 'Accounting attempt ID');
  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    const snapshot = await loadSnapshot(tx, input.tenantId, invoice);
    const sdkInput = toSdkInput(snapshot, input.mapping);
    const { request } = prepareRequest(snapshot, input.mapping, sdkInput);
    const identity = frozenIdentity(snapshot, request);
    const state = parseSyncState(invoice.accountingSyncStateJson);
    checkPilotAcceptance(invoice, state);
    if (
      !state ||
      (state.status !== 'unknown' && state.status !== 'in_flight') ||
      state.identity.requestId !== input.requestId ||
      state.attemptId !== input.attemptId ||
      !sameIdentity(state.identity, identity)
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Accounting reconciliation does not match the unresolved frozen request',
      );
    if (
      state.status === 'in_flight' &&
      input.confirmInterruptedOwnerStopped !== true
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_IN_PROGRESS',
        'Accounting reconciliation cannot release a live sync owner',
      );

    if (input.outcome.status === 'absent') {
      invoice.accountingSyncStateJson = JSON.stringify({
        ...state,
        status: 'rejected',
      } satisfies FrozenSyncState);
      await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
      return {
        status: 'ready',
        moneySnapshotId: identity.moneySnapshotId,
        requestId: identity.requestId,
      };
    }

    const externalId = requiredText(
      input.outcome.externalId,
      'Accounting external ID',
    );
    if (
      !(input.outcome.syncedAt instanceof Date) ||
      Number.isNaN(input.outcome.syncedAt.valueOf())
    )
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Accounting reconciliation requires a valid sync timestamp',
      );
    return saveSyncedInvoice(
      invoice,
      state,
      externalId,
      input.outcome.syncedAt,
    );
  });
}

/** Read the persisted coordination state for diagnostics/reconciliation. */
export function readFrozenAccountingSyncState(invoice: Invoice): Readonly<{
  status: FrozenSyncStatus;
  provider: string;
  realmId: string;
  environment: string;
  moneySnapshotId: string;
  requestId: string;
  attemptId: string;
  startedAt: string;
  documentKind: 'invoice' | 'creditMemo';
  request: QuickBooksInvoiceRequest | QuickBooksCreditMemoRequest;
  pilotProjection?: QuickBooksPilotProjection;
}> | null {
  const state = parseSyncState(invoice.accountingSyncStateJson);
  if (!state) return null;
  return {
    status: state.status,
    provider: state.identity.provider,
    realmId: state.identity.realmId,
    environment: state.identity.environment,
    documentKind: state.identity.documentKind,
    moneySnapshotId: state.identity.moneySnapshotId,
    requestId: state.identity.requestId,
    attemptId: state.attemptId,
    startedAt: state.startedAt,
    ...(state.pilotProjection
      ? { pilotProjection: state.pilotProjection }
      : {}),
    request: {
      requestId: state.identity.requestId,
      realmId: state.identity.realmId,
      environment: state.identity.environment,
      payloadHash: state.identity.payloadHash,
      ...(state.identity.documentKind === 'creditMemo'
        ? {
            creditedInvoiceExternalId: requiredText(
              state.identity.creditedInvoiceExternalId ?? '',
              'Credited invoice external ID',
            ),
          }
        : {}),
    },
  };
}

function frozenIdentity(
  snapshot: FrozenInvoiceAccountingSnapshot,
  request: QuickBooksInvoiceRequest | QuickBooksCreditMemoRequest,
): FrozenSyncIdentity {
  return {
    provider: 'quickbooks',
    documentKind: snapshot.document.kind,
    realmId: request.realmId,
    environment: request.environment,
    invoiceId: snapshot.document.id,
    moneySnapshotId: snapshot.moneySnapshotId,
    requestId: request.requestId,
    payloadHash: request.payloadHash,
    creditedInvoiceExternalId:
      'creditedInvoiceExternalId' in request
        ? request.creditedInvoiceExternalId
        : undefined,
  };
}

function checkPilotAcceptance(
  invoice: Invoice,
  state: FrozenSyncState | null,
  acceptance?: QuickBooksPilotAcceptance,
): void {
  if (acceptance && acceptance.moneySnapshotId !== invoice.moneySnapshotId)
    pilotDisagreement(
      'QuickBooks pilot acceptance does not match the frozen invoice',
    );
  if (
    state &&
    (state.pilot?.obligationId !== acceptance?.obligationId ||
      state.pilot?.quoteVersionId !== acceptance?.quoteVersionId ||
      state.pilot?.moneySnapshotId !== acceptance?.moneySnapshotId)
  )
    pilotDisagreement(
      'QuickBooks pilot acceptance differs from the existing reservation',
    );
}

async function assertUnusedPilotExternalId(
  db: DatabaseInterface,
  invoice: Invoice,
  identity: FrozenSyncIdentity,
  externalId: string,
): Promise<void> {
  const invoices = await InvoiceCollection.create({ db });
  const matches = await invoices.list({
    where: { externalId, tenantId: invoice.tenantId },
  });
  for (const other of matches) {
    if (other.id === invoice.id) continue;
    const binding = parseSyncState(other.accountingSyncStateJson);
    if (
      !binding ||
      (binding.identity.realmId === identity.realmId &&
        binding.identity.environment === identity.environment)
    )
      pilotDisagreement(
        'QuickBooks invoice is already bound to another local invoice',
      );
  }
}

/** The pilot has a fixture transport only. No credential or SDK factory is accepted. */
export interface QuickBooksPilotFixture {
  readonly mode: 'fixture';
  readonly scope: QuickBooksPilotScope;
  pushInvoice(input: InvoiceInput): Promise<SyncResult>;
  readInvoice(externalId: string): Promise<QuickBooksPilotInvoiceEvidence>;
  findInvoiceForRequest?(request: QuickBooksInvoiceRequest): Promise<{
    readonly requestId: string;
    readonly payloadHash: string;
    readonly invoice: QuickBooksPilotInvoiceEvidence;
  } | null>;
}

export type QuickBooksPilotCommand = FrozenInvoiceAccountingInput & {
  readonly acceptance: QuickBooksPilotAcceptance;
  readonly fixture: QuickBooksPilotFixture;
} & (
    | { readonly action: 'issue' | 'poll' }
    | { readonly action: 'link'; readonly externalId: string }
    | {
        readonly action: 'recover';
        readonly confirmInterruptedOwnerStopped?: true;
      }
  );

function assertPilotInvoice(invoice: Invoice): void {
  if (
    invoice.kind !== 'invoice' ||
    invoice.totalAmount <= 0 ||
    !invoice.customerExternalId ||
    invoice.ordinaryAccountingStateJson ||
    invoice.retentionAccountingStateJson
  )
    unsupported(
      'QuickBooks pilot requires an ordinary positive invoice and a mapped customer',
    );
}

function checkPilotEvidence(
  evidence: QuickBooksPilotInvoiceEvidence,
  scope: QuickBooksPilotScope,
  externalId: string,
  invoice: Pick<
    Invoice,
    | 'customerExternalId'
    | 'currency'
    | 'subtotal'
    | 'discountTotal'
    | 'taxAmount'
    | 'totalAmount'
    | 'dueDate'
  >,
): QuickBooksPilotProjection {
  if (
    !evidence ||
    evidence.tenantId !== scope.tenantId ||
    evidence.realmId !== scope.realmId ||
    evidence.environment !== scope.environment ||
    evidence.externalId !== externalId ||
    !invoice.customerExternalId ||
    evidence.customerExternalId !== invoice.customerExternalId ||
    evidence.currency !== invoice.currency ||
    evidence.subtotalMinor !== invoice.subtotal ||
    evidence.discountMinor !== invoice.discountTotal ||
    evidence.taxMinor !== invoice.taxAmount ||
    evidence.totalMinor !== invoice.totalAmount ||
    evidence.dueDate !== (invoice.dueDate?.toISOString().slice(0, 10) ?? null)
  )
    pilotDisagreement('QuickBooks invoice identity or frozen money differs');
  return projectQuickBooksPilotEvidence(evidence);
}

/**
 * Issue, link, recover or poll one accepted invoice using deterministic fixture
 * evidence. The trusted host authorizes the quote acceptance and manual link.
 * Every invocation revalidates the active tenant and fixture scope.
 */
export async function runQuickBooksPilot(
  input: QuickBooksPilotCommand,
): Promise<QuickBooksPilotProjection> {
  assertPrincipalTenant(input.tenantId);
  const { acceptance, fixture, mapping } = input;
  if (!['issue', 'poll', 'link', 'recover'].includes(input.action))
    unsupported('Unsupported QuickBooks pilot action');
  if (
    fixture?.mode !== 'fixture' ||
    fixture.scope?.environment !== 'sandbox' ||
    mapping.environment !== 'sandbox' ||
    fixture.scope.tenantId !== input.tenantId ||
    fixture.scope.realmId !== mapping.realmId
  )
    unsupported(
      'QuickBooks pilot requires an explicitly scoped sandbox fixture',
    );
  requiredText(mapping.realmId, 'QuickBooks realm');
  requiredText(acceptance.quoteVersionId, 'Accepted quote version');
  requiredText(acceptance.moneySnapshotId, 'Accepted money snapshot');
  const obligationId = requiredText(
    acceptance.obligationId,
    'Accepted obligation',
  );
  if (
    input.invoiceId !==
    (await quickBooksPilotInvoiceId(input.tenantId, obligationId))
  )
    pilotDisagreement(
      'QuickBooks pilot requires the canonical obligation invoice',
    );
  const scope = { ...fixture.scope };

  if (input.action === 'issue') {
    // The existing owner persists the descriptor before push and records any
    // unverifiable readback after push as an unresolved create.
    let projection: QuickBooksPilotProjection | undefined;
    await syncFrozenInvoice(
      {
        ...input,
        provider: {
          type: 'quickbooks',
          invoices: { push: (invoice) => fixture.pushInvoice(invoice) },
        },
      },
      {
        acceptance,
        async verify(invoice, result) {
          if (result.action !== 'created')
            pilotDisagreement('QuickBooks pilot did not return a new invoice');
          const id = requiredText(result.externalId, 'QuickBooks invoice ID');
          projection = checkPilotEvidence(
            await fixture.readInvoice(id),
            scope,
            id,
            invoice,
          );
          return projection;
        },
      },
    );
    if (projection) return projection;
  }

  return withDocumentMoneyTransaction(input.db, async (tx) => {
    await lockTenantMoneyRuntime(tx, input.tenantId);
    const { invoice } = await lockAndReloadInvoice(
      tx,
      input.invoiceId,
      input.tenantId,
    );
    const state = parseSyncState(invoice.accountingSyncStateJson);
    checkPilotAcceptance(invoice, state, acceptance);
    assertPilotInvoice(invoice);
    const snapshot = await loadSnapshot(tx, input.tenantId, invoice);
    // Validate the original create descriptor even after a binding exists.
    const sdkInput = toSdkInput(
      {
        ...snapshot,
        document: { ...snapshot.document, externalId: undefined },
      },
      mapping,
    );
    const { request } = prepareRequest(snapshot, mapping, sdkInput);
    const identity = frozenIdentity(snapshot, request);
    if (state && !sameIdentity(state.identity, identity))
      pilotDisagreement('QuickBooks pilot binding or frozen request changed');

    if (state?.status === 'synced') {
      const id = requiredText(state.externalId ?? '', 'QuickBooks invoice ID');
      if (
        invoice.externalId !== id ||
        invoice.externalProvider !== 'quickbooks'
      )
        pilotDisagreement('QuickBooks pilot provider binding changed');
      if (input.action === 'link' && input.externalId !== id)
        pilotDisagreement('QuickBooks invoice already has a different binding');
      const projection = checkPilotEvidence(
        await fixture.readInvoice(id),
        scope,
        id,
        invoice,
      );
      invoice.accountingSyncStateJson = JSON.stringify({
        ...state,
        pilotProjection: projection,
      } satisfies FrozenSyncState);
      await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
      return projection;
    }

    let externalId: string;
    let evidence: QuickBooksPilotInvoiceEvidence;
    if (
      input.action === 'link' &&
      (!state || state.status === 'rejected') &&
      !invoice.externalId
    ) {
      externalId = requiredText(input.externalId, 'QuickBooks invoice ID');
      evidence = await fixture.readInvoice(externalId);
    } else if (
      input.action === 'recover' &&
      (state?.status === 'unknown' ||
        (state?.status === 'in_flight' &&
          input.confirmInterruptedOwnerStopped === true))
    ) {
      const match = await fixture.findInvoiceForRequest?.(request);
      if (
        !match ||
        match.requestId !== identity.requestId ||
        match.payloadHash !== identity.payloadHash
      )
        pilotDisagreement(
          'QuickBooks create remains unresolved without verified request identity',
        );
      evidence = match.invoice;
      externalId = requiredText(evidence.externalId, 'QuickBooks invoice ID');
    } else {
      pilotDisagreement(
        'QuickBooks pilot has no verified invoice binding for this action',
      );
    }

    const projection = checkPilotEvidence(evidence, scope, externalId, invoice);
    await assertUnusedPilotExternalId(tx, invoice, identity, externalId);
    await saveSyncedInvoice(
      invoice,
      {
        version: 1,
        status: 'synced',
        identity,
        attemptId: state?.attemptId ?? randomUUID(),
        startedAt: state?.startedAt ?? projection.observedAt,
        pilot: acceptance,
        pilotProjection: projection,
      },
      externalId,
      new Date(projection.observedAt),
    );
    return projection;
  });
}
