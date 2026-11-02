import { assertContractScheduleInvoiceFreeze } from './contract-billing-schedule.js';
import {
  getHistoricalSalesMoney,
  readHistoricalSalesLines,
} from './historical-sales-money.js';
import type { HistoricalSalesMoneySnapshot } from './historical-sales-types.js';
/** Transactional Invoice money aggregate persistence. */

import type { SmrtSaveOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from './collections/CustomerCollection.js';
import {
  DocumentTaxCollection,
  type DocumentTaxWriteInput,
} from './collections/DocumentTaxCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import {
  allocateFrozenCredit,
  type FrozenCreditAllocation,
  type IssuedCreditConsumption,
} from './credit-allocation.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
  withDocumentMoneyObjectTransaction,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import type { DocumentTax } from './models/DocumentTax.js';
import type { Invoice } from './models/Invoice.js';
import { InvoiceLineItem } from './models/InvoiceLineItem.js';
import type { TaxSettings } from './models/TaxSettings.js';
import {
  calculateMoneyDocument,
  type MoneyDiscountInput,
  MoneyValidationError,
  type ResolvableTaxCodeInput,
  resolveLineTaxCode,
} from './money.js';
import {
  lockTenantMoneyRuntime,
  withTenantMoneyRuntime,
} from './tenant-money-barrier.js';
import type { InvoiceTaxComponentSnapshot } from './types/index.js';
import { InvoiceStatus } from './types/index.js';

type ProductTaxDefaults = {
  tenantId: string | null;
  defaultSalesTaxCodeId: string;
};

type DeleteOptions = { expectedUpdatedAt?: Date | string };

export interface PreviewInvoiceMoneyInput {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  draft?: {
    header?: Partial<
      Pick<
        Invoice,
        | 'currency'
        | 'lineAmountType'
        | 'taxRoundingScope'
        | 'providerTaxAmount'
        | 'customerId'
      >
    >;
    lines?: Array<
      Partial<
        Pick<
          InvoiceLineItem,
          | 'id'
          | 'description'
          | 'productId'
          | 'quantity'
          | 'unitPrice'
          | 'discountType'
          | 'discountRate'
          | 'discount'
          | 'taxMode'
          | 'taxCodeId'
        >
      >
    >;
  };
}

export interface PreviewInvoiceMoneyResult {
  source: 'calculated';
  header: {
    currency: string;
    lineAmountType: Invoice['lineAmountType'];
    taxRoundingScope: Invoice['taxRoundingScope'];
    subtotalMinor: number;
    discountTotalMinor: number;
    taxAmountMinor: number;
    providerTaxAmountMinor: number;
    totalAmountMinor: number;
  };
  lines: Array<{
    id: string;
    grossMinor: number;
    discountMinor: number;
    amountMinor: number;
    taxMinor: number;
    taxCodeId: string | null;
    taxCodeCode: string | null;
    taxCodeName: string | null;
    taxComponents: InvoiceLineItem['taxComponents'];
  }>;
  taxes: DocumentTaxWriteInput[];
}

export interface GetInvoiceMoneyFactsInput {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
}

export interface InvoiceMoneyFacts {
  historical?: {
    snapshot: HistoricalSalesMoneySnapshot;
    lines: Array<{ sourceKey: string; lineId: string }>;
  };
  source: 'stored';
  payable?: ReturnType<Invoice['getPayableFacts']>;
  invoiceId: string;
  moneySnapshotId: string;
  kind: Invoice['kind'];
  status: Invoice['status'];
  header: PreviewInvoiceMoneyResult['header'];
  lines: PreviewInvoiceMoneyResult['lines'];
  taxes: DocumentTaxWriteInput[];
}

const FROZEN_INVOICE_FIELDS = [
  'moneyAuthority',
  'historicalSalesMoneyJson',
  'historicalSourceKeyHash',
  'kind',
  'creditedInvoiceId',
  'tenantId',
  'customerId',
  'contractId',
  'invoiceNumber',
  'reference',
  'issueDate',
  'dueDate',
  'subtotal',
  'discountTotal',
  'taxAmount',
  'providerTaxAmount',
  'totalAmount',
  'currency',
  'lineAmountType',
  'taxRoundingScope',
  'sellerTaxRegistrationsJson',
  'partyTaxId',
  'moneySnapshotId',
  'notes',
  'customerNotes',
  'terms',
] as const;

const FROZEN_LINE_FIELDS = [
  'tenantId',
  'invoiceId',
  'creditedLineId',
  'creditCalculationBasisJson',
  'description',
  'sku',
  'productId',
  'quantity',
  'unitPrice',
  'discountType',
  'discountRate',
  'discount',
  'taxMode',
  'taxCodeId',
  'taxCodeCode',
  'taxCodeName',
  'taxComponentsJson',
  'taxAmount',
  'taxRate',
  'amount',
  'sourceType',
  'sourceId',
  'periodStart',
  'periodEnd',
  'revenueAccountId',
  'sortOrder',
  'moneySnapshotId',
] as const;

/** Frozen-field identity: an absent optional reference (`''`) equals a stored NULL. */
function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value === '' || value === undefined ? null : value;
}

function assertFieldsUnchanged<T extends object>(
  proposed: T,
  persisted: T,
  fields: readonly (keyof T)[],
  label: string,
): void {
  for (const field of fields) {
    if (comparable(proposed[field]) !== comparable(persisted[field])) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        `${label} ${String(field)} is frozen`,
      );
    }
  }
}

function assertTenantId(value: string | null): asserts value is string {
  if (!value || value.trim() !== value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money requires a tenant-owned invoice',
    );
}

function requireId(value: string | null | undefined, label: string): string {
  if (!value)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `${label} requires a persisted ID`,
    );
  return value;
}

/** Lock the tenant's settings row; every money document belongs to a tenant. */
async function lockRuntimeSettings(
  db: DatabaseInterface,
  tenantId: string | null,
): Promise<TaxSettings> {
  if (!tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Commerce money documents require a tenant',
    );
  return lockTenantMoneyRuntime(db, tenantId);
}

function isFrozen(invoice: Invoice): boolean {
  return (
    invoice.status !== InvoiceStatus.DRAFT ||
    !!invoice.arJournalId ||
    !!invoice.moneySnapshotId
  );
}

function aggregateSignature(invoice: Invoice): string {
  return JSON.stringify([
    invoice.lineAmountType,
    invoice.taxRoundingScope,
    invoice.subtotal,
    invoice.discountTotal,
    invoice.taxAmount,
    invoice.totalAmount,
  ]);
}

async function loadInvoice(
  db: DatabaseInterface,
  id: string,
): Promise<{ collection: InvoiceCollection; invoice: Invoice }> {
  const collection = await InvoiceCollection.create({ db });
  const invoice = await collection.get({ id }, { cache: false });
  if (!invoice)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Invoice ${id} was not found`,
    );
  return { collection, invoice };
}

async function findInvoice(
  db: DatabaseInterface,
  id: string,
): Promise<Invoice | null> {
  const collection = await InvoiceCollection.create({ db });
  return collection.get({ id }, { cache: false });
}

/** @internal Acquire the invoice money lock and reload persisted authority. */
export async function lockAndReloadInvoice(
  db: DatabaseInterface,
  invoiceId: string,
  tenantId: string,
): Promise<{ collection: InvoiceCollection; invoice: Invoice }> {
  const first = await loadInvoice(db, invoiceId);
  await lockDocumentMoneyParents([
    { id: invoiceId, tenantId, collection: first.collection },
  ]);
  const invoice = await first.collection.get(
    { id: invoiceId },
    { cache: false },
  );
  if (!invoice || invoice.tenantId !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice tenant identity changed while acquiring its money lock',
    );
  return { collection: first.collection, invoice };
}

async function lockAndReloadMoneyInvoice(
  db: DatabaseInterface,
  invoiceId: string,
  tenantId: string,
  creditedInvoiceId: string | null,
): Promise<{
  collection: InvoiceCollection;
  invoice: Invoice;
  source: Invoice | null;
}> {
  const collection = await InvoiceCollection.create({ db });
  const ids = [invoiceId, ...(creditedInvoiceId ? [creditedInvoiceId] : [])];
  const loaded = await Promise.all(
    ids.map((id) => collection.get({ id }, { cache: false })),
  );
  if (loaded.some((row) => !row || row.tenantId !== tenantId))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money parents must exist in the active tenant',
    );
  await lockDocumentMoneyParents(
    ids.map((id) => ({ id, tenantId, collection })),
  );
  const invoice = await collection.get({ id: invoiceId }, { cache: false });
  const source = creditedInvoiceId
    ? await collection.get({ id: creditedInvoiceId }, { cache: false })
    : null;
  if (
    !invoice ||
    invoice.tenantId !== tenantId ||
    (source && source.tenantId !== tenantId)
  )
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money parent identity changed while acquiring its lock',
    );
  return { collection, invoice, source };
}

function discountInput(line: InvoiceLineItem): MoneyDiscountInput {
  if (line.discountType === 'percent')
    return { kind: 'percent', rate: String(line.discountRate) };
  if (line.discountType === 'amount' || line.discount !== 0)
    return { kind: 'amount', minor: line.discount };
  if (line.discountType !== 'none')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Unknown discount type: ${line.discountType}`,
    );
  return { kind: 'none' };
}

type CreditPreparation = {
  allocationByLineId: Map<string, FrozenCreditAllocation>;
  sourceByLineId: Map<string, InvoiceLineItem>;
  issuedLines: InvoiceLineItem[];
  issuedParentById: Map<string, Invoice>;
  sourceInvoice: Invoice;
  sourceTaxes: DocumentTax[];
  exhaustsDocument: boolean;
};

function issuedCredit(invoice: Invoice): boolean {
  return (
    invoice.kind === 'credit_note' &&
    invoice.status !== InvoiceStatus.DRAFT &&
    invoice.status !== InvoiceStatus.CANCELLED
  );
}

/** @internal Refresh one economic credit effect, including historical issued credits. */
export async function refreshIssuedCreditBalance(
  db: DatabaseInterface,
  source: Invoice,
): Promise<void> {
  const sourceId = requireId(source.id, 'Credited invoice');
  const credits = await (await InvoiceCollection.create({ db })).list({
    where: { tenantId: source.tenantId, creditedInvoiceId: sourceId },
    limit: 100001,
  });
  if (credits.length > 100000)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Issued credit scope exceeds its bounded source limit',
    );
  const issued = credits.filter(issuedCredit).sort((left, right) => {
    const date = left.issueDate.getTime() - right.issueDate.getTime();
    if (date) return date;
    return String(left.id) < String(right.id)
      ? -1
      : String(left.id) > String(right.id)
        ? 1
        : 0;
  });
  const total = issued.reduce((sum, credit) => sum + credit.totalAmount, 0);
  if (!Number.isSafeInteger(total) || total < 0)
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      'Issued credit total is not a nonnegative safe integer',
    );
  let remainingSource = Math.max(0, source.totalAmount - source.amountPaid);
  const managed = new Map<string, number>();
  if (
    source.retentionAccountingStateJson ||
    source.ordinaryAccountingStateJson
  ) {
    const providerState = JSON.parse(
      source.retentionAccountingStateJson || source.ordinaryAccountingStateJson,
    );
    for (const entry of providerState.credits) {
      const credit = issued.find(
        (candidate) => candidate.id === entry.creditId,
      );
      const retainedMinor = source.retentionAccountingStateJson
        ? entry.retainedMinor
        : 0;
      const frozen = retainedMinor + entry.appliedMinor;
      if (
        !credit ||
        managed.has(entry.creditId) ||
        !Number.isSafeInteger(retainedMinor) ||
        retainedMinor < 0 ||
        !Number.isSafeInteger(entry.appliedMinor) ||
        entry.appliedMinor < 0 ||
        !Number.isSafeInteger(frozen) ||
        frozen > credit.totalAmount ||
        frozen !== credit.creditedAmount ||
        frozen > remainingSource
      )
        throw new MoneyValidationError(
          'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
          'Provider-managed credit allocation cannot change without an explicit reversal contract',
        );
      managed.set(entry.creditId, frozen);
      remainingSource -= frozen;
    }
  }
  // Provider applications are immutable authority, not a fresh allocation choice.
  // Reserve them before assigning residual capacity; neither database order nor
  // a later same-day credit's UUID may take an already committed application.
  for (const credit of [
    ...issued,
    ...credits.filter((entry) => !issued.includes(entry)),
  ]) {
    const included = issued.includes(credit);
    const frozen = managed.get(requireId(credit.id, 'Credit invoice'));
    const applied =
      frozen ?? (included ? Math.min(credit.totalAmount, remainingSource) : 0);
    if (included && frozen === undefined) remainingSource -= applied;
    if (credit.creditedAmount !== applied) {
      credit.creditedAmount = applied;
      credit.updatePaymentStatus(credit.amountPaid);
      // A zero application is not an issuance reversal. SENT can be recorded
      // without delivery timestamps, so payment status alone cannot restore it.
      if (included && credit.status === InvoiceStatus.DRAFT)
        credit.status = InvoiceStatus.SENT;
      await credit.saveDerived(DOCUMENT_MONEY_WRITE);
    }
  }
  if (
    (source.retentionAccountingStateJson ||
      source.ordinaryAccountingStateJson) &&
    total !== source.creditedAmount
  ) {
    const state = JSON.parse(
      source.retentionAccountingStateJson || source.ordinaryAccountingStateJson,
    );
    if (
      state.status !== 'ready' ||
      state.steps.some(
        (step: { status: string }) => step.status !== 'confirmed',
      )
    )
      throw new MoneyValidationError(
        'ACCOUNTING_SYNC_RECONCILIATION_REQUIRED',
        'Provider retention operation must reconcile before changing source credits',
      );
  }
  source.creditedAmount = total;
  source.updatePaymentStatus(source.amountPaid);
  await source.saveDerived(DOCUMENT_MONEY_WRITE);
}

function lineNet(line: InvoiceLineItem, parent: Invoice): number {
  return parent.lineAmountType === 'inclusive'
    ? line.amount - line.taxAmount
    : line.amount;
}

async function prepareCreditLines(
  db: DatabaseInterface,
  invoice: Invoice,
  lines: InvoiceLineItem[],
): Promise<CreditPreparation> {
  if (!invoice.creditedInvoiceId)
    throw new MoneyValidationError(
      'CREDIT_TARGET_NOT_ISSUED',
      'A credit note requires a credited invoice',
    );
  const sourceInvoice = await findInvoice(db, invoice.creditedInvoiceId);
  if (
    sourceInvoice?.kind !== 'invoice' ||
    sourceInvoice.tenantId !== invoice.tenantId ||
    sourceInvoice.status === InvoiceStatus.DRAFT ||
    sourceInvoice.status === InvoiceStatus.CANCELLED ||
    !sourceInvoice.moneySnapshotId
  )
    throw new MoneyValidationError(
      'CREDIT_TARGET_NOT_ISSUED',
      'Credit target must be an issued, non-cancelled invoice in the same tenant',
    );
  if (sourceInvoice.moneyAuthority === 'historical')
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Historical source credits require exact original monetary facts and concrete historical source line lineage, not calculated quantity or inferred tax',
    );
  if (sourceInvoice.currency !== invoice.currency)
    throw new MoneyValidationError(
      'CURRENCY_MISMATCH',
      'Credit note currency must match its credited invoice',
    );
  if (sourceInvoice.customerId !== invoice.customerId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Credit note customer must match its credited invoice',
    );
  invoice.lineAmountType = sourceInvoice.lineAmountType;
  invoice.taxRoundingScope = sourceInvoice.taxRoundingScope;
  const lineCollection = await InvoiceLineItemCollection.create({ db });
  const sourceLines = await lineCollection.findByInvoice(
    requireId(sourceInvoice.id, 'Credited invoice'),
  );
  const sourceTaxes = await (
    await DocumentTaxCollection.create({ db })
  ).findByDocument(
    requireId(sourceInvoice.tenantId, 'Credited invoice tenant'),
    'invoice',
    requireId(sourceInvoice.id, 'Credited invoice'),
  );
  const sourceByLineId = new Map(
    sourceLines.map((line) => [requireId(line.id, 'Credited line'), line]),
  );
  const invoices = await InvoiceCollection.create({ db });
  const priorCredits = (
    await invoices.list({
      where: {
        tenantId: invoice.tenantId,
        creditedInvoiceId: invoice.creditedInvoiceId,
      },
    })
  ).filter((row) => row.id !== invoice.id && issuedCredit(row));
  const issuedLines: InvoiceLineItem[] = [];
  const issuedParentById = new Map(
    priorCredits.map((row) => [requireId(row.id, 'Issued credit note'), row]),
  );
  const consumptions: IssuedCreditConsumption[] = [];
  for (const credit of priorCredits) {
    for (const line of await lineCollection.findByInvoice(
      requireId(credit.id, 'Issued credit note'),
    )) {
      if (!line.creditedLineId) continue;
      issuedLines.push(line);
      const basis = line.creditCalculationBasis;
      consumptions.push({
        creditedLineId: line.creditedLineId,
        quantity: basis?.kind === 'quantity' ? basis.quantity : '0',
        netMinor: lineNet(line, credit),
        discountMinor: line.discount,
      });
    }
  }
  const targeted = lines.filter((line) => line.creditedLineId);
  const allocation = targeted.length
    ? allocateFrozenCredit(
        sourceLines.map((line) => ({
          id: requireId(line.id, 'Credited line'),
          quantity: String(line.quantity),
          netMinor: lineNet(line, sourceInvoice),
          discountMinor: line.discount,
          unitPrice: line.unitPrice,
          discountType: line.discountType,
          discountRate: line.discountRate,
        })),
        consumptions,
        targeted.map((line) => {
          const basis = line.creditCalculationBasis;
          return basis?.kind === 'net_amount'
            ? {
                creditedLineId: requireId(line.creditedLineId, 'Credited line'),
                netMinor: basis.netMinor,
              }
            : {
                creditedLineId: requireId(line.creditedLineId, 'Credited line'),
                quantity:
                  basis?.kind === 'quantity'
                    ? basis.quantity
                    : String(line.quantity),
              };
        }),
      )
    : { allocations: [], exhaustsDocument: false };
  const allocationByLineId = new Map<string, FrozenCreditAllocation>();
  const targetBySource = new Map(
    targeted.map((line) => [
      requireId(line.creditedLineId, 'Credited line'),
      line,
    ]),
  );
  for (const row of allocation.allocations) {
    const line = targetBySource.get(row.creditedLineId);
    if (!line)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Credit allocation lost its target line',
      );
    line.creditCalculationBasis = row.basis;
    allocationByLineId.set(requireId(line.id, 'Credit line'), row);
  }
  return {
    allocationByLineId,
    sourceByLineId,
    issuedLines,
    issuedParentById,
    sourceInvoice,
    sourceTaxes,
    exhaustsDocument: allocation.exhaustsDocument,
  };
}

async function recomputeInvoiceAggregate(
  db: DatabaseInterface,
  invoice: Invoice,
  settings: TaxSettings,
  freezeSnapshotId = '',
  persist = true,
  proposedLines?: InvoiceLineItem[],
): Promise<{ lines: InvoiceLineItem[]; taxRows: DocumentTaxWriteInput[] }> {
  assertTenantId(invoice.tenantId);
  const tenantId = invoice.tenantId;
  const linesCollection = await InvoiceLineItemCollection.create({ db });
  const codesCollection = await TaxCodeCollection.create({ db });
  const componentsCollection = await TaxComponentCollection.create({ db });
  const invoiceId = requireId(invoice.id, 'Invoice calculation');
  const lines =
    proposedLines ?? (await linesCollection.findByInvoice(invoiceId));
  const credit =
    invoice.kind === 'credit_note'
      ? await prepareCreditLines(db, invoice, lines)
      : null;
  const codes = await codesCollection.list({ where: { tenantId } });
  const components = await componentsCollection.list({ where: { tenantId } });
  const componentById = new Map(
    components.map((row) => [requireId(row.id, 'Tax component'), row]),
  );
  const codeById = new Map(
    codes.map((row) => [requireId(row.id, 'Tax code'), row]),
  );
  const codeInputs: Record<string, ResolvableTaxCodeInput> = {};
  for (const code of codes) {
    const codeId = requireId(code.id, 'Tax code');
    codeInputs[codeId] = {
      id: codeId,
      kind: code.kind,
      active: code.active,
      appliesTo: code.appliesTo,
      components: code.components.map((part) => {
        const component = componentById.get(part.taxComponentId);
        if (!component)
          throw new MoneyValidationError(
            'TAX_CODE_NOT_FOUND',
            `Tax component ${part.taxComponentId} was not loaded`,
          );
        return {
          taxComponentId: requireId(component.id, 'Tax component'),
          percent: component.percent,
          compound: part.compound,
        };
      }),
    };
  }
  if (credit) {
    for (const source of credit.sourceByLineId.values()) {
      if (!source.taxCodeId) continue;
      const frozenKind = credit.sourceTaxes.find(
        (row) => row.taxCodeId === source.taxCodeId,
      )?.kind;
      codeInputs[source.taxCodeId] = {
        id: source.taxCodeId,
        kind:
          frozenKind ??
          (source.taxComponents.length ? 'taxable' : 'zero-rated'),
        active: true,
        appliesTo: 'sales',
        components: source.taxComponents.map((component) => ({
          taxComponentId: component.taxComponentId,
          percent: component.percent,
          compound: component.compound ?? false,
        })),
      };
    }
  }
  const exempt = await codesCollection.findByCode('exempt', tenantId);
  const outOfScope = await codesCollection.findByCode('out-of-scope', tenantId);
  const customers = await CustomerCollection.create({ db });
  const customer = invoice.customerId
    ? await customers.get({ id: invoice.customerId }, { cache: false })
    : null;
  if (customer && customer.tenantId !== tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice customer must belong to its tenant',
    );

  // Products owns catalog reads. Load it lazily, on the aggregate transaction,
  // so commerce keeps the same runtime-only package edge used for ledgers.
  const productIds = [
    ...new Set(
      lines
        .filter((line) => !line.creditedLineId)
        .map((line) => line.productId)
        .filter((productId): productId is string => !!productId),
    ),
  ];
  const productById = new Map<string, ProductTaxDefaults>();
  if (productIds.length > 0) {
    const { ProductCollection } = await import(
      '@happyvertical/smrt-products/collections'
    );
    const products = await ProductCollection.create({ db });
    for (const productId of productIds) {
      const product = await products.get({ id: productId }, { cache: false });
      if (!product)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `Invoice product ${productId} was not found`,
        );
      if (product.tenantId !== null && product.tenantId !== tenantId)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `Invoice product ${productId} must be global or belong to its tenant`,
        );
      productById.set(productId, product);
    }
  }

  type ResolvedMetadata = {
    id: string;
    code: string | null;
    name: string | null;
    kind: 'taxable' | 'zero-rated' | 'exempt' | 'out-of-scope';
    components: InvoiceTaxComponentSnapshot[];
  };
  const resolvedCodes = new Map<string, ResolvedMetadata | null>();
  const calculated = calculateMoneyDocument({
    currency: invoice.currency,
    lineAmountType: invoice.lineAmountType,
    roundingScope: invoice.taxRoundingScope,
    lines: lines.map((line) => {
      if (line.tenantId !== tenantId)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          `Invoice line ${line.id} must belong to its parent tenant`,
        );
      const lineId = requireId(line.id, 'Invoice line');
      if (line.creditedLineId) {
        if (!credit)
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Only a credit note may reference a credited line',
          );
        const source = credit.sourceByLineId.get(line.creditedLineId);
        const allocation = credit.allocationByLineId.get(lineId);
        if (!source || !allocation)
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Credited line is not part of the frozen source invoice',
          );
        const taxCode = source.taxCodeId
          ? (codeInputs[source.taxCodeId] ?? null)
          : null;
        resolvedCodes.set(
          lineId,
          source.taxCodeId
            ? {
                id: source.taxCodeId,
                code: source.taxCodeCode,
                name: source.taxCodeName,
                kind: taxCode?.kind ?? 'zero-rated',
                components: structuredClone(source.taxComponents),
              }
            : null,
        );
        line.description ||= source.description;
        line.sku ||= source.sku;
        line.productId = source.productId;
        line.revenueAccountId = source.revenueAccountId;
        if (allocation.basis.kind === 'quantity') {
          line.quantity = Number(allocation.basis.quantity);
          line.unitPrice = allocation.basis.sourceUnitPrice;
          line.discountType = allocation.discountMinor ? 'amount' : 'none';
          line.discountRate = '0';
        } else {
          line.quantity = 1;
          line.unitPrice = allocation.netMinor ?? allocation.basis.netMinor;
          line.discountType = 'none';
          line.discountRate = '0';
        }
        line.discount = allocation.discountMinor;
        return {
          id: lineId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          netAmountMinor:
            allocation.basis.kind === 'net_amount'
              ? (allocation.netMinor ?? allocation.basis.netMinor)
              : undefined,
          discount: allocation.discountMinor
            ? ({ kind: 'amount', minor: allocation.discountMinor } as const)
            : ({ kind: 'none' } as const),
          taxCode,
        };
      }
      if (invoice.kind === 'invoice' && line.creditCalculationBasis)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Ordinary invoice lines cannot carry a credit calculation basis',
        );
      if (invoice.kind === 'credit_note' && line.taxMode !== 'override')
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Free-form credit lines require an explicit tax-code override',
        );
      const resolved = resolveLineTaxCode(
        {
          lineAmountType: invoice.lineAmountType,
          lineOverride: line.taxMode === 'override' ? line.taxCodeId : null,
        },
        {
          direction: 'sales',
          codes: codeInputs,
          customerTaxExempt: customer?.taxExempt ?? false,
          exemptCodeId: exempt?.id,
          productCodeId: line.productId
            ? productById.get(line.productId)?.defaultSalesTaxCodeId || null
            : null,
          partyCodeId: customer?.defaultTaxCodeId,
          appDefaultCodeId: settings.defaultSalesTaxCodeId,
          outOfScopeCodeId: outOfScope?.id,
        },
      );
      resolvedCodes.set(
        lineId,
        resolved.taxCode
          ? (() => {
              const code = codeById.get(resolved.taxCode.id);
              if (!code)
                throw new MoneyValidationError(
                  'TAX_CODE_NOT_FOUND',
                  `Tax code ${resolved.taxCode.id} was not loaded`,
                );
              return {
                id: requireId(code.id, 'Tax code'),
                code: code.code,
                name: code.name,
                kind: code.kind,
                components: code.components.map((part) => {
                  const component = componentById.get(part.taxComponentId);
                  if (!component)
                    throw new MoneyValidationError(
                      'TAX_CODE_NOT_FOUND',
                      `Tax component ${part.taxComponentId} was not loaded`,
                    );
                  return {
                    taxComponentId: part.taxComponentId,
                    name: component.name,
                    percent: component.percent,
                    ...(part.compound ? { compound: true } : {}),
                    taxMinor: 0,
                  };
                }),
              };
            })()
          : null,
      );
      return {
        id: requireId(line.id, 'Invoice line'),
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: discountInput(line),
        taxCode: resolved.taxCode,
      };
    }),
  });

  // When every original line is exhausted, consume the exact remaining frozen
  // component and taxable residual. This preserves document-rounding cents
  // without consulting today's rates; free-form goodwill lines remain separate.
  if (credit?.exhaustsDocument) {
    const resultById = new Map(calculated.lines.map((row) => [row.id, row]));
    const targeted = lines.filter((line) => !!line.creditedLineId);
    for (const line of targeted) {
      const source = credit.sourceByLineId.get(
        requireId(line.creditedLineId, 'Credited line'),
      );
      const result = resultById.get(requireId(line.id, 'Credit line'));
      if (!source || !result) continue;
      const prior = credit.issuedLines.filter(
        (candidate) => candidate.creditedLineId === source.id,
      );
      const priorNet = prior.reduce((sum, candidate) => {
        const parent = credit.issuedParentById.get(candidate.invoiceId);
        return sum + (parent ? lineNet(candidate, parent) : 0);
      }, 0);
      const desiredNet = lineNet(source, credit.sourceInvoice) - priorNet;
      const netDelta = desiredNet - result.netMinor;
      result.netMinor = desiredNet;
      result.amountMinor += netDelta;
      for (const sourceComponent of source.taxComponents) {
        const component = result.components.find(
          (candidate) =>
            candidate.taxComponentId === sourceComponent.taxComponentId,
        );
        if (!component) continue;
        const priorTax = prior.reduce(
          (sum, candidate) =>
            sum +
            (candidate.taxComponents.find(
              (part) => part.taxComponentId === sourceComponent.taxComponentId,
            )?.taxMinor ?? 0),
          0,
        );
        const desiredTax = sourceComponent.taxMinor - priorTax;
        const taxDelta = desiredTax - component.taxMinor;
        component.taxMinor = desiredTax;
        if (sourceComponent.compound) {
          component.compound = true;
          component.taxableMinor =
            (sourceComponent.taxableMinor ?? 0) -
            prior.reduce(
              (sum, candidate) =>
                sum +
                (candidate.taxComponents.find(
                  (part) =>
                    part.taxComponentId === sourceComponent.taxComponentId,
                )?.taxableMinor ?? 0),
              0,
            );
        }
        result.taxMinor += taxDelta;
        if (invoice.lineAmountType === 'inclusive')
          result.amountMinor += taxDelta;
      }
    }
    const rebuilt = new Map<
      string,
      {
        taxCodeId: string | null;
        taxComponentId: string | null;
        taxableMinor: number;
        netMinor?: number;
        taxMinor: number;
      }
    >();
    for (const result of calculated.lines) {
      const metadata = resolvedCodes.get(result.id) ?? null;
      const parts = result.components.length
        ? result.components
        : [
            {
              taxComponentId: null,
              taxMinor: 0,
              compound: false,
              taxableMinor: undefined,
            },
          ];
      for (const part of parts) {
        const key = `${metadata?.id ?? ''}\u0000${part.taxComponentId ?? ''}`;
        const row = rebuilt.get(key) ?? {
          taxCodeId: metadata?.id ?? null,
          taxComponentId: part.taxComponentId,
          taxableMinor: 0,
          taxMinor: 0,
        };
        row.taxableMinor += part.taxableMinor ?? result.netMinor;
        if (part.compound) row.netMinor = (row.netMinor ?? 0) + result.netMinor;
        row.taxMinor += part.taxMinor;
        rebuilt.set(key, row);
      }
    }
    calculated.taxes = [...rebuilt.values()].sort((left, right) => {
      const a = `${left.taxCodeId ?? ''}\u0000${left.taxComponentId ?? ''}`;
      const b = `${right.taxCodeId ?? ''}\u0000${right.taxComponentId ?? ''}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    calculated.subtotalMinor = calculated.lines.reduce(
      (sum, row) => sum + row.netMinor,
      0,
    );
    calculated.taxMinor = calculated.lines.reduce(
      (sum, row) => sum + row.taxMinor,
      0,
    );
    calculated.totalMinor = calculated.subtotalMinor + calculated.taxMinor;
  }

  if (credit) {
    const resultById = new Map(calculated.lines.map((row) => [row.id, row]));
    for (const [lineId, allocation] of credit.allocationByLineId) {
      if (allocation.basis.kind !== 'quantity') continue;
      const result = resultById.get(lineId);
      const hasAmountBasisConsumption = credit.issuedLines.some(
        (line) =>
          line.creditedLineId === allocation.creditedLineId &&
          line.creditCalculationBasis?.kind === 'net_amount',
      );
      if (
        result &&
        Math.abs(result.netMinor) > Math.abs(allocation.remainingNetMinor) &&
        (!allocation.exhaustsLine || hasAmountBasisConsumption)
      )
        throw new MoneyValidationError(
          'CREDIT_EXCEEDS_LINE',
          'Credit quantity exceeds the remaining frozen net amount',
        );
    }
  }

  const lineById = new Map(
    lines.map((line) => [requireId(line.id, 'Invoice line'), line]),
  );
  for (const result of calculated.lines) {
    const line = lineById.get(result.id);
    if (!line)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        `Calculated line ${result.id} was not loaded`,
      );
    const code = resolvedCodes.get(requireId(line.id, 'Invoice line')) ?? null;
    line.discount = result.discountMinor;
    line.amount = result.amountMinor;
    line.taxAmount = result.taxMinor;
    line.taxCodeId = code?.id ?? null;
    line.taxCodeCode = code?.code ?? null;
    line.taxCodeName = code?.name ?? null;
    line.taxComponents = result.components.map((entry) => {
      const component = code?.components.find(
        (candidate) => candidate.taxComponentId === entry.taxComponentId,
      );
      if (!component)
        throw new MoneyValidationError(
          'TAX_CODE_NOT_FOUND',
          `Calculated component ${entry.taxComponentId} was not loaded`,
        );
      return {
        taxComponentId: component.taxComponentId,
        name: component.name,
        percent: component.percent,
        taxMinor: entry.taxMinor,
        ...(entry.compound
          ? { compound: true, taxableMinor: entry.taxableMinor }
          : {}),
      };
    });
    line.taxRate = result.components.some((part) => part.compound)
      ? result.netMinor === 0
        ? 0
        : result.taxMinor / result.netMinor
      : code
        ? code.components.reduce(
            (sum, part) => sum + Number(part.percent) / 100,
            0,
          )
        : 0;
    if (freezeSnapshotId) line.moneySnapshotId = freezeSnapshotId;
    if (persist) await line.saveDerived(DOCUMENT_MONEY_WRITE);
  }

  const taxRows = calculated.taxes.map((tax): DocumentTaxWriteInput => {
    const code = tax.taxCodeId
      ? ([...resolvedCodes.values()].find(
          (candidate) => candidate?.id === tax.taxCodeId,
        ) ?? null)
      : null;
    const snapshotComponent = tax.taxComponentId
      ? code?.components.find(
          (candidate) => candidate.taxComponentId === tax.taxComponentId,
        )
      : null;
    const currentComponent = tax.taxComponentId
      ? componentById.get(tax.taxComponentId)
      : null;
    const sourceTax = credit?.sourceTaxes.find(
      (row) =>
        row.taxCodeId === tax.taxCodeId &&
        row.taxComponentId === tax.taxComponentId,
    );
    if (tax.taxCodeId && !code)
      throw new MoneyValidationError(
        'TAX_CODE_NOT_FOUND',
        `Document tax code ${tax.taxCodeId} was not loaded`,
      );
    if (tax.taxComponentId && !snapshotComponent)
      throw new MoneyValidationError(
        'TAX_CODE_NOT_FOUND',
        `Document tax component ${tax.taxComponentId} was not loaded`,
      );
    return {
      tenantId,
      documentType: invoice.kind,
      documentId: invoiceId,
      currency: invoice.currency,
      taxCodeId: code ? requireId(code.id, 'Tax code') : null,
      taxCodeCode: code?.code ?? null,
      kind: code?.kind ?? null,
      taxComponentId: snapshotComponent?.taxComponentId ?? null,
      taxComponentName: snapshotComponent?.name ?? null,
      percent: snapshotComponent?.percent ?? null,
      liabilityAccountId:
        sourceTax?.liabilityAccountId ||
        currentComponent?.liabilityAccountId ||
        null,
      taxableMinor: tax.taxableMinor,
      netMinor: tax.netMinor ?? null,
      taxMinor: tax.taxMinor,
      recoverableMinor: 0,
    };
  });
  if (persist) {
    const documentTaxes = await DocumentTaxCollection.create({ db });
    await documentTaxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
      tenantId,
      documentType: invoice.kind,
      documentId: invoiceId,
      rows: taxRows,
    });
  }
  invoice.subtotal = calculated.subtotalMinor;
  invoice.discountTotal = calculated.discountTotalMinor;
  invoice.taxAmount = calculated.taxMinor + invoice.providerTaxAmount;
  invoice.totalAmount = calculated.totalMinor + invoice.providerTaxAmount;
  return { lines, taxRows };
}

async function previewInvoiceMoneyOnScope(
  input: PreviewInvoiceMoneyInput,
  settings: TaxSettings,
): Promise<PreviewInvoiceMoneyResult> {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice preview requires its active principal tenant',
    );
  const { invoice } = await loadInvoice(input.db, input.invoiceId);
  if (invoice.tenantId !== input.tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice preview cannot cross tenant boundaries',
    );
  if (invoice.status !== InvoiceStatus.DRAFT || invoice.moneySnapshotId)
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Frozen invoice money cannot be previewed as a proposed draft',
    );
  const proposedHeader = input.draft?.header;
  if (proposedHeader)
    for (const field of [
      'currency',
      'lineAmountType',
      'taxRoundingScope',
      'providerTaxAmount',
      'customerId',
    ] as const)
      if (proposedHeader[field] !== undefined)
        invoice[field] = proposedHeader[field] as never;
  const storedLines = await (
    await InvoiceLineItemCollection.create({ db: input.db })
  ).findByInvoice(input.invoiceId);
  const storedById = new Map(storedLines.map((line) => [line.id, line]));
  const providedIds =
    input.draft?.lines
      ?.map((line) => line.id)
      .filter((id): id is string => !!id) ?? [];
  if (new Set(providedIds).size !== providedIds.length)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice preview line ids must be distinct',
    );
  const unknownId = providedIds.find((id) => !storedById.has(id));
  if (unknownId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Invoice preview line ${unknownId} was not found on the invoice`,
    );
  const proposedLines = input.draft?.lines
    ? input.draft.lines.map((proposed) => {
        const line = proposed.id ? storedById.get(proposed.id) : undefined;
        const result = line ?? new InvoiceLineItem();
        for (const field of [
          'description',
          'productId',
          'quantity',
          'unitPrice',
          'discountType',
          'discountRate',
          'discount',
          'taxMode',
          'taxCodeId',
        ] as const)
          if (proposed[field] !== undefined)
            result[field] = proposed[field] as never;
        result.id ||= crypto.randomUUID();
        result.invoiceId = input.invoiceId;
        result.tenantId = input.tenantId;
        return result;
      })
    : storedLines;
  const calculated = await recomputeInvoiceAggregate(
    input.db,
    invoice,
    settings,
    '',
    false,
    proposedLines,
  );
  return {
    source: 'calculated',
    header: {
      currency: invoice.currency,
      lineAmountType: invoice.lineAmountType,
      taxRoundingScope: invoice.taxRoundingScope,
      subtotalMinor: invoice.subtotal,
      discountTotalMinor: invoice.discountTotal,
      taxAmountMinor: invoice.taxAmount,
      providerTaxAmountMinor: invoice.providerTaxAmount,
      totalAmountMinor: invoice.totalAmount,
    },
    lines: calculated.lines.map((line) => ({
      id: requireId(line.id, 'Preview line'),
      grossMinor: line.amount + line.discount,
      discountMinor: line.discount,
      amountMinor: line.amount,
      taxMinor: line.taxAmount,
      taxCodeId: line.taxCodeId,
      taxCodeCode: line.taxCodeCode,
      taxCodeName: line.taxCodeName,
      taxComponents: structuredClone(line.taxComponents),
    })),
    taxes: calculated.taxRows,
  };
}

/** Calculate a proposed draft invoice in memory through the owning resolver. */
export async function previewInvoiceMoney(
  input: PreviewInvoiceMoneyInput,
): Promise<PreviewInvoiceMoneyResult> {
  return withTenantMoneyRuntime(input.db, input.tenantId, async (scope) =>
    previewInvoiceMoneyOnScope({ ...input, db: scope.db }, scope.settings),
  );
}

async function getInvoiceMoneyFactsOnScope(
  input: GetInvoiceMoneyFactsInput,
): Promise<InvoiceMoneyFacts> {
  if (!input.tenantId || getTenantId() !== input.tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money facts require their active principal tenant',
    );
  const { invoice } = await loadInvoice(input.db, input.invoiceId);
  if (invoice.tenantId !== input.tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice money facts cannot cross tenant boundaries',
    );
  const lines = await (
    await InvoiceLineItemCollection.create({ db: input.db })
  ).findByInvoice(input.invoiceId);
  const taxes = await (
    await DocumentTaxCollection.create({ db: input.db })
  ).findByDocument(input.tenantId, invoice.kind, input.invoiceId);
  const historical = getHistoricalSalesMoney(invoice);
  return {
    source: 'stored',
    ...(historical
      ? {
          historical: {
            snapshot: historical,
            lines: (await readHistoricalSalesLines(input.db, invoice)).map(
              (line) => ({
                sourceKey: line.sourceKey,
                lineId: String(line.id),
              }),
            ),
          },
        }
      : {}),
    ...(invoice.retentionStateJson
      ? { payable: invoice.getPayableFacts() }
      : {}),
    invoiceId: input.invoiceId,
    moneySnapshotId: invoice.moneySnapshotId,
    kind: invoice.kind,
    status: invoice.status,
    header: {
      currency: invoice.currency,
      lineAmountType: invoice.lineAmountType,
      taxRoundingScope: invoice.taxRoundingScope,
      subtotalMinor: invoice.subtotal,
      discountTotalMinor: invoice.discountTotal,
      taxAmountMinor: invoice.taxAmount,
      providerTaxAmountMinor: invoice.providerTaxAmount,
      totalAmountMinor: invoice.totalAmount,
    },
    lines: lines.map((line) => ({
      id: requireId(line.id, 'Invoice line'),
      grossMinor: line.amount + line.discount,
      discountMinor: line.discount,
      amountMinor: line.amount,
      taxMinor: line.taxAmount,
      taxCodeId: line.taxCodeId,
      taxCodeCode: line.taxCodeCode,
      taxCodeName: line.taxCodeName,
      taxComponents: structuredClone(line.taxComponents),
    })),
    taxes: taxes.map((row) => ({
      tenantId: requireId(row.tenantId, 'Document tax tenant'),
      documentType: row.documentType,
      documentId: row.documentId,
      currency: row.currency,
      taxCodeId: row.taxCodeId,
      taxCodeCode: row.taxCodeCode,
      kind: row.kind,
      taxComponentId: row.taxComponentId,
      taxComponentName: row.taxComponentName,
      percent: row.percent,
      liabilityAccountId: row.liabilityAccountId,
      taxableMinor: row.taxableMinor,
      ...(row.netMinor !== null ? { netMinor: row.netMinor } : {}),
      taxMinor: row.taxMinor,
      recoverableMinor: row.recoverableMinor,
    })),
  };
}

/** Read authoritative persisted money facts without resolution or recalculation. */
export async function getInvoiceMoneyFacts(
  input: GetInvoiceMoneyFactsInput,
): Promise<InvoiceMoneyFacts> {
  return withTenantMoneyRuntime(input.db, input.tenantId, async (scope) =>
    getInvoiceMoneyFactsOnScope({ ...input, db: scope.db }),
  );
}

/** Persist an invoice and recompute its complete money aggregate. */
export async function saveInvoice(
  input: Invoice,
  options?: SmrtSaveOptions,
): Promise<Invoice> {
  const priorRevision = input.updated_at;
  try {
    return await withDocumentMoneyTransaction(input.db, async (tx) =>
      input.withDatabase(tx, async (invoice) => {
        if (invoice.kind !== 'invoice' && invoice.kind !== 'credit_note')
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Invoice kind must be invoice or credit_note',
          );
        if (invoice.kind === 'invoice' && invoice.creditedInvoiceId)
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Only a credit note may reference a credited invoice',
          );
        if (invoice.kind === 'credit_note' && !invoice.creditedInvoiceId)
          throw new MoneyValidationError(
            'CREDIT_TARGET_NOT_ISSUED',
            'A credit note requires a credited invoice',
          );
        const candidateTenantId = getTenantId() ?? invoice.tenantId ?? null;
        const settings = await lockRuntimeSettings(tx, candidateTenantId);
        const existing = invoice.id ? await findInvoice(tx, invoice.id) : null;
        const tenantId = existing?.tenantId ?? candidateTenantId;
        if (
          invoice.retentionAccountingStateJson !==
            (existing?.retentionAccountingStateJson ?? '') ||
          invoice.ordinaryAccountingStateJson !==
            (existing?.ordinaryAccountingStateJson ?? '')
        )
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Retention accounting state is managed by provider commands',
          );
        if (
          invoice.moneyAuthority !==
            (existing?.moneyAuthority ?? 'calculated') ||
          invoice.historicalSalesMoneyJson !==
            (existing?.historicalSalesMoneyJson ?? '') ||
          invoice.historicalSourceKeyHash !==
            (existing?.historicalSourceKeyHash ?? null)
        )
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Historical source authority is managed only by historical sales commands',
          );
        if (existing?.moneyAuthority === 'historical')
          getHistoricalSalesMoney(existing);

        if (invoice.retentionStateJson !== (existing?.retentionStateJson ?? ''))
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Retention state is managed by retention commands',
          );
        if (
          candidateTenantId &&
          existing?.tenantId &&
          existing.tenantId !== candidateTenantId
        )
          throw new MoneyValidationError(
            'INVALID_MONEY_INPUT',
            'Invoice tenant does not match its active money barrier',
          );
        assertTenantId(tenantId);
        if (!existing) {
          invoice.tenantId = tenantId;
          invoice.creditedAmount = 0;
          let source: Invoice | null = null;
          if (invoice.kind === 'credit_note') {
            source = await findInvoice(
              tx,
              requireId(invoice.creditedInvoiceId, 'Credited invoice'),
            );
            if (!source || source.tenantId !== tenantId)
              throw new MoneyValidationError(
                'CREDIT_TARGET_NOT_ISSUED',
                'Credit target must exist in the active tenant',
              );
            await lockDocumentMoneyParents([
              {
                id: requireId(source.id, 'Credited invoice'),
                tenantId,
                collection: await InvoiceCollection.create({ db: tx }),
              },
            ]);
            if (
              source.kind !== 'invoice' ||
              source.status === InvoiceStatus.DRAFT ||
              source.status === InvoiceStatus.CANCELLED ||
              !source.moneySnapshotId
            )
              throw new MoneyValidationError(
                'CREDIT_TARGET_NOT_ISSUED',
                'Credit target must be an issued, non-cancelled invoice',
              );
            if (
              invoice.currency !== source.currency ||
              invoice.customerId !== source.customerId
            )
              throw new MoneyValidationError(
                invoice.currency !== source.currency
                  ? 'CURRENCY_MISMATCH'
                  : 'INVALID_MONEY_INPUT',
                'Credit note currency and customer must match its source invoice',
              );
          }
          invoice.lineAmountType =
            invoice.kind === 'credit_note' && source
              ? source.lineAmountType
              : settings.defaultLineAmountType;
          invoice.taxRoundingScope =
            invoice.kind === 'credit_note' && source
              ? source.taxRoundingScope
              : settings.taxRoundingScope;
          invoice.subtotal = 0;
          invoice.discountTotal = 0;
          invoice.taxAmount = invoice.providerTaxAmount;
          invoice.totalAmount = invoice.providerTaxAmount;
          if (invoice.status !== InvoiceStatus.DRAFT || invoice.arJournalId) {
            await assertContractScheduleInvoiceFreeze(tx, invoice);
            const customers = await CustomerCollection.create({ db: tx });
            const customer = invoice.customerId
              ? await customers.get(
                  { id: invoice.customerId },
                  { cache: false },
                )
              : null;
            invoice.moneySnapshotId = crypto.randomUUID();
            invoice.sellerTaxRegistrations = structuredClone(
              settings.taxRegistrations,
            );
            invoice.partyTaxId = customer?.taxId ?? '';
          }
          return invoice.saveDerived(DOCUMENT_MONEY_WRITE, options);
        }
        if (invoice.tenantId !== existing.tenantId)
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Invoice tenant identity cannot change',
          );
        if (
          invoice.kind !== existing.kind ||
          invoice.creditedInvoiceId !== existing.creditedInvoiceId
        )
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'Invoice kind and credited invoice identity are immutable',
          );
        const existingId = requireId(existing.id, 'Invoice');
        const locked = await lockAndReloadMoneyInvoice(
          tx,
          existingId,
          tenantId,
          existing.creditedInvoiceId,
        );
        invoice.creditedAmount = locked.invoice.creditedAmount;
        if (isFrozen(locked.invoice)) {
          if (
            invoice.arReversalJournalId !== locked.invoice.arReversalJournalId
          )
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'Invoice reversal journal identity is server-managed',
            );
          if (
            locked.invoice.arJournalId &&
            invoice.arJournalId !== locked.invoice.arJournalId
          )
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'Invoice revenue journal identity is frozen once assigned',
            );
          if (
            invoice.status === InvoiceStatus.CANCELLED &&
            locked.invoice.status !== InvoiceStatus.CANCELLED &&
            locked.invoice.kind === 'invoice' &&
            locked.invoice.isPaid()
          )
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'A paid invoice cannot be cancelled',
            );
          if (
            invoice.status === InvoiceStatus.CANCELLED &&
            locked.invoice.status !== InvoiceStatus.CANCELLED &&
            locked.invoice.kind === 'credit_note' &&
            locked.invoice.amountPaid > 0
          )
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'A refunded credit note cannot be cancelled',
            );
          if (
            invoice.status === InvoiceStatus.CANCELLED &&
            locked.invoice.status !== InvoiceStatus.CANCELLED &&
            locked.invoice.arJournalId &&
            !locked.invoice.arReversalJournalId
          )
            throw new MoneyValidationError(
              'FROZEN_DOCUMENT',
              'A posted invoice requires an atomic reversal before cancellation',
            );
          assertFieldsUnchanged(
            invoice,
            locked.invoice,
            FROZEN_INVOICE_FIELDS,
            'Invoice',
          );
          const saved = await invoice.saveDerived(
            DOCUMENT_MONEY_WRITE,
            options,
          );
          if (locked.source)
            await refreshIssuedCreditBalance(tx, locked.source);
          return saved;
        }
        const freezing =
          invoice.status !== InvoiceStatus.DRAFT || !!invoice.arJournalId;
        const snapshotId = freezing
          ? locked.invoice.moneySnapshotId || crypto.randomUUID()
          : '';
        await recomputeInvoiceAggregate(tx, invoice, settings, snapshotId);
        if (freezing) {
          await assertContractScheduleInvoiceFreeze(tx, invoice);
          const customers = await CustomerCollection.create({ db: tx });
          const customer = invoice.customerId
            ? await customers.get({ id: invoice.customerId }, { cache: false })
            : null;
          invoice.sellerTaxRegistrations = structuredClone(
            settings.taxRegistrations,
          );
          invoice.partyTaxId = customer?.taxId ?? '';
          invoice.moneySnapshotId = snapshotId;
        }
        const saved = await invoice.saveDerived(DOCUMENT_MONEY_WRITE, options);
        if (locked.source) await refreshIssuedCreditBalance(tx, locked.source);
        return saved;
      }),
    );
  } catch (error) {
    input.updated_at = priorRevision;
    throw error;
  }
}

/** Persist a line and recompute its complete invoice aggregate. */
export async function saveInvoiceLineItem(
  input: InvoiceLineItem,
  options?: SmrtSaveOptions,
): Promise<InvoiceLineItem> {
  return withDocumentMoneyObjectTransaction(input, async (line, tx) => {
    const candidateTenantId = getTenantId() ?? line.tenantId ?? null;
    const settings = await lockRuntimeSettings(tx, candidateTenantId);
    const persisted = line.id
      ? await (await InvoiceLineItemCollection.create({ db: tx })).get(
          { id: line.id },
          { cache: false },
        )
      : null;
    const parentId = persisted?.invoiceId ?? line.invoiceId;
    const first = await loadInvoice(tx, parentId);
    if (candidateTenantId && first.invoice.tenantId !== candidateTenantId)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Invoice line tenant does not match its active money barrier',
      );
    assertTenantId(first.invoice.tenantId);
    const { invoice, source } = await lockAndReloadMoneyInvoice(
      tx,
      parentId,
      first.invoice.tenantId,
      first.invoice.creditedInvoiceId,
    );
    if (persisted && line.invoiceId !== persisted.invoiceId)
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'Invoice line cannot move between parents',
      );
    line.invoiceId = requireId(invoice.id, 'Invoice');
    line.tenantId = invoice.tenantId;
    if (invoice.kind === 'invoice' && line.creditedLineId)
      throw new MoneyValidationError(
        'INVALID_MONEY_INPUT',
        'Ordinary invoice lines cannot reference credited lines',
      );
    if (
      invoice.kind === 'credit_note' &&
      line.creditedLineId &&
      (!source || source.id !== invoice.creditedInvoiceId)
    )
      throw new MoneyValidationError(
        'CREDIT_TARGET_NOT_ISSUED',
        'Credit source changed while saving its line',
      );
    if (isFrozen(invoice)) {
      if (!persisted)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Cannot add a line to a frozen invoice',
        );
      assertFieldsUnchanged(
        line,
        persisted,
        FROZEN_LINE_FIELDS,
        'Invoice line',
      );
      return line.saveDerived(DOCUMENT_MONEY_WRITE, options);
    }
    await line.saveDerived(DOCUMENT_MONEY_WRITE, options);
    const priorAggregate = aggregateSignature(invoice);
    await recomputeInvoiceAggregate(tx, invoice, settings);
    if (aggregateSignature(invoice) !== priorAggregate) {
      await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
    }
    const refreshed = await (
      await InvoiceLineItemCollection.create({ db: tx })
    ).get({ id: requireId(line.id, 'Invoice line') }, { cache: false });
    if (refreshed) {
      for (const field of [
        'discount',
        'amount',
        'taxAmount',
        'taxRate',
        'taxCodeId',
        'taxCodeCode',
        'taxCodeName',
        'taxComponentsJson',
        'moneySnapshotId',
        'updated_at',
      ] as const) {
        line[field] = refreshed[field] as never;
      }
    }
    return line;
  });
}

export async function deleteInvoiceLineItem(
  input: InvoiceLineItem,
  options: DeleteOptions,
): Promise<void> {
  await withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (line) => {
      const candidateTenantId = getTenantId() ?? line.tenantId ?? null;
      const settings = await lockRuntimeSettings(tx, candidateTenantId);
      const persisted = line.id
        ? await (await InvoiceLineItemCollection.create({ db: tx })).get(
            { id: line.id },
            { cache: false },
          )
        : null;
      if (!persisted) return;
      const first = await loadInvoice(tx, persisted.invoiceId);
      if (candidateTenantId && first.invoice.tenantId !== candidateTenantId)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Invoice line tenant does not match its active money barrier',
        );
      assertTenantId(first.invoice.tenantId);
      const { invoice } = await lockAndReloadInvoice(
        tx,
        persisted.invoiceId,
        first.invoice.tenantId,
      );
      if (isFrozen(invoice))
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Cannot delete a line from a frozen invoice',
        );
      await line.deleteDerived(DOCUMENT_MONEY_WRITE, options);
      const priorAggregate = aggregateSignature(invoice);
      await recomputeInvoiceAggregate(tx, invoice, settings);
      if (aggregateSignature(invoice) !== priorAggregate) {
        await invoice.saveDerived(DOCUMENT_MONEY_WRITE);
      }
    }),
  );
}

export async function deleteInvoice(
  input: Invoice,
  options: DeleteOptions,
): Promise<void> {
  await withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (invoice) => {
      const candidateTenantId = getTenantId() ?? invoice.tenantId ?? null;
      const settings = await lockRuntimeSettings(tx, candidateTenantId);
      const persisted = invoice.id ? await findInvoice(tx, invoice.id) : null;
      if (!persisted) return;
      if (candidateTenantId && persisted.tenantId !== candidateTenantId)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Invoice tenant does not match its active money barrier',
        );
      if (isFrozen(persisted))
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Cannot delete a frozen invoice',
        );
      assertTenantId(persisted.tenantId);
      const persistedId = requireId(persisted.id, 'Invoice');
      await lockAndReloadInvoice(tx, persistedId, persisted.tenantId);
      const documentTaxes = await DocumentTaxCollection.create({ db: tx });
      await documentTaxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: persisted.tenantId,
        documentType: 'invoice',
        documentId: persistedId,
        rows: [],
      });
      await invoice.deleteDerived(DOCUMENT_MONEY_WRITE, options);
    }),
  );
}
