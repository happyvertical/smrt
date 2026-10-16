/** Frozen Invoice projection and guarded accounting-provider synchronization. */

import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountingProvider,
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

interface PreparedSync {
  kind: 'push';
  documentKind: 'invoice' | 'creditMemo';
  accountingInput: AccountingSnapshotInput;
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
  if (invoice.getPayableFacts().retainedRemainingMinor > 0)
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
      dueDate: invoice.dueDate,
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
  input: SyncFrozenInvoiceToAccountingInput,
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
    const snapshot = await loadSnapshot(tx, input.tenantId, invoice);
    const sdkInput = toSdkInput(snapshot, input.mapping);
    const prior = parseSyncState(invoice.accountingSyncStateJson);
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
    const identity: FrozenSyncIdentity = {
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
    } satisfies FrozenSyncState);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    return {
      kind: 'push',
      documentKind: snapshot.document.kind,
      accountingInput,
      identity,
      attemptId,
    };
  });
}

async function recordFailure(
  input: SyncFrozenInvoiceToAccountingInput,
  prepared: PreparedSync,
  error: unknown,
): Promise<void> {
  const rejected =
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

async function recordSuccess(
  input: SyncFrozenInvoiceToAccountingInput,
  prepared: PreparedSync,
  result: SyncResult,
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
      invoice.moneySnapshotId !== prepared.identity.moneySnapshotId
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Accounting sync ownership or frozen snapshot changed after provider write',
      );
    const syncedAt = result.syncedAt.toISOString();
    invoice.externalId = result.externalId;
    invoice.externalProvider = prepared.identity.provider;
    invoice.syncedAt = result.syncedAt;
    invoice.accountingSyncStateJson = JSON.stringify({
      ...state,
      status: 'synced',
      externalId: result.externalId,
      syncedAt,
    } satisfies FrozenSyncState);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    return {
      status: 'synced',
      externalId: result.externalId,
      syncedAt: result.syncedAt,
      moneySnapshotId: prepared.identity.moneySnapshotId,
    };
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
  assertPrincipalTenant(input.tenantId);
  const prepared = await prepareSync(input);
  if (prepared.kind === 'unchanged') return prepared.result;
  let result: SyncResult;
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
  } catch (error) {
    await recordFailure(input, prepared, error);
    throw error;
  }
  return recordSuccess(input, prepared, result);
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
    const identity: FrozenSyncIdentity = {
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
    const state = parseSyncState(invoice.accountingSyncStateJson);
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
    const syncedAt = input.outcome.syncedAt.toISOString();
    invoice.externalId = externalId;
    invoice.externalProvider = identity.provider;
    invoice.syncedAt = input.outcome.syncedAt;
    invoice.accountingSyncStateJson = JSON.stringify({
      ...state,
      status: 'synced',
      externalId,
      syncedAt,
    } satisfies FrozenSyncState);
    await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    return {
      status: 'synced',
      externalId,
      syncedAt: input.outcome.syncedAt,
      moneySnapshotId: identity.moneySnapshotId,
    };
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
