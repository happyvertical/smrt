/** Transactional Invoice money aggregate persistence. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from './collections/CustomerCollection.js';
import { DocumentTaxCollection } from './collections/DocumentTaxCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from './collections/TaxCodeCollection.js';
import { TaxComponentCollection } from './collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from './collections/TaxSettingsCollection.js';
import {
  DOCUMENT_MONEY_WRITE,
  lockDocumentMoneyParents,
  withDocumentMoneyTransaction,
} from './document-money-internal.js';
import type { Invoice } from './models/Invoice.js';
import type { InvoiceLineItem } from './models/InvoiceLineItem.js';
import type { TaxCode } from './models/TaxCode.js';
import type { TaxSettings } from './models/TaxSettings.js';
import {
  calculateMoneyDocument,
  type MoneyDiscountInput,
  MoneyValidationError,
  type ResolvableTaxCodeInput,
  resolveLineTaxCode,
} from './money.js';
import { InvoiceStatus } from './types/index.js';

type ProductTaxDefaults = {
  tenantId: string | null;
  defaultSalesTaxCodeId: string;
};

type DeleteOptions = { expectedUpdatedAt?: Date | string };

const FROZEN_INVOICE_FIELDS = [
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

function comparable(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
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
      'Money v2 requires a tenant-owned invoice',
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

/** @internal Shared by capability-bound posting and migration coordinators. */
export async function settingsForTenant(
  db: DatabaseInterface,
  tenantId: string | null,
): Promise<TaxSettings | null> {
  if (!tenantId) return null;
  // Older hosts and focused legacy manifests legitimately omit the money-v2
  // tables. Absence selects the legacy path; runtime code never creates schema.
  if (db.tableExists && !(await db.tableExists('tax_settings'))) return null;
  const collection = await TaxSettingsCollection.create({ db });
  return collection.getForTenant(tenantId);
}

function assertRuntimeAvailable(settings: TaxSettings | null): void {
  if (settings?.moneyModel === 'migrating') {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration is in progress',
    );
  }
}

function isFrozen(invoice: Invoice): boolean {
  return invoice.status !== InvoiceStatus.DRAFT || !!invoice.arJournalId;
}

function aggregateSignature(invoice: Invoice): string {
  return JSON.stringify([
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

async function recomputeInvoiceAggregate(
  db: DatabaseInterface,
  invoice: Invoice,
  settings: TaxSettings,
  freezeSnapshotId = '',
): Promise<void> {
  assertTenantId(invoice.tenantId);
  const tenantId = invoice.tenantId;
  const linesCollection = await InvoiceLineItemCollection.create({ db });
  const codesCollection = await TaxCodeCollection.create({ db });
  const componentsCollection = await TaxComponentCollection.create({ db });
  const invoiceId = requireId(invoice.id, 'Invoice calculation');
  const lines = await linesCollection.findByInvoice(invoiceId);
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
  const exempt = await codesCollection.findByCode('exempt');
  const outOfScope = await codesCollection.findByCode('out-of-scope');
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

  const resolvedCodes = new Map<string, TaxCode | null>();
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
        requireId(line.id, 'Invoice line'),
        resolved.taxCode ? (codeById.get(resolved.taxCode.id) ?? null) : null,
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
    line.taxCodeId = code ? requireId(code.id, 'Tax code') : null;
    line.taxCodeCode = code?.code ?? null;
    line.taxCodeName = code?.name ?? null;
    line.taxComponents = result.components.map((entry) => {
      const component = componentById.get(entry.taxComponentId);
      if (!component)
        throw new MoneyValidationError(
          'TAX_CODE_NOT_FOUND',
          `Calculated component ${entry.taxComponentId} was not loaded`,
        );
      return {
        taxComponentId: requireId(component.id, 'Tax component'),
        name: component.name,
        percent: component.percent,
        taxMinor: entry.taxMinor,
      };
    });
    line.taxRate = code
      ? code.components.reduce(
          (sum, part) =>
            sum +
            Number(componentById.get(part.taxComponentId)?.percent ?? 0) / 100,
          0,
        )
      : 0;
    if (freezeSnapshotId) line.moneySnapshotId = freezeSnapshotId;
    await line.saveDerived(DOCUMENT_MONEY_WRITE, false);
  }

  const documentTaxes = await DocumentTaxCollection.create({ db });
  await documentTaxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
    tenantId,
    documentType: 'invoice',
    documentId: invoiceId,
    rows: calculated.taxes.map((tax) => {
      const code = tax.taxCodeId ? codeById.get(tax.taxCodeId) : null;
      const component = tax.taxComponentId
        ? componentById.get(tax.taxComponentId)
        : null;
      if (tax.taxCodeId && !code)
        throw new MoneyValidationError(
          'TAX_CODE_NOT_FOUND',
          `Document tax code ${tax.taxCodeId} was not loaded`,
        );
      if (tax.taxComponentId && !component)
        throw new MoneyValidationError(
          'TAX_CODE_NOT_FOUND',
          `Document tax component ${tax.taxComponentId} was not loaded`,
        );
      return {
        tenantId,
        documentType: 'invoice' as const,
        documentId: invoiceId,
        currency: invoice.currency,
        taxCodeId: code ? requireId(code.id, 'Tax code') : null,
        taxCodeCode: code?.code ?? null,
        kind: code?.kind ?? null,
        taxComponentId: component
          ? requireId(component.id, 'Tax component')
          : null,
        taxComponentName: component?.name ?? null,
        percent: component?.percent ?? null,
        liabilityAccountId: component?.liabilityAccountId || null,
        taxableMinor: tax.taxableMinor,
        taxMinor: tax.taxMinor,
        recoverableMinor: 0,
      };
    }),
  });
  invoice.subtotal = calculated.subtotalMinor;
  invoice.discountTotal = calculated.discountTotalMinor;
  invoice.taxAmount = calculated.taxMinor + invoice.providerTaxAmount;
  invoice.totalAmount = calculated.totalMinor + invoice.providerTaxAmount;
}

/** Persist an invoice through either legacy compatibility or the v2 aggregate. */
export async function saveInvoice(input: Invoice): Promise<Invoice> {
  return withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (invoice) => {
      const existing = invoice.id ? await findInvoice(tx, invoice.id) : null;
      const tenantId =
        existing?.tenantId ?? invoice.tenantId ?? getTenantId() ?? null;
      const settings = await settingsForTenant(tx, tenantId);
      assertRuntimeAvailable(settings);
      if (settings?.moneyModel !== 'v2') {
        return invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: true,
        });
      }
      assertTenantId(tenantId);
      if (!existing) {
        invoice.tenantId = tenantId;
        invoice.lineAmountType = settings.defaultLineAmountType;
        invoice.taxRoundingScope = settings.taxRoundingScope;
        invoice.subtotal = 0;
        invoice.discountTotal = 0;
        invoice.taxAmount = invoice.providerTaxAmount;
        invoice.totalAmount = invoice.providerTaxAmount;
        if (invoice.status !== InvoiceStatus.DRAFT || invoice.arJournalId) {
          const customers = await CustomerCollection.create({ db: tx });
          const customer = invoice.customerId
            ? await customers.get({ id: invoice.customerId }, { cache: false })
            : null;
          invoice.moneySnapshotId = crypto.randomUUID();
          invoice.sellerTaxRegistrations = structuredClone(
            settings.taxRegistrations,
          );
          invoice.partyTaxId = customer?.taxId ?? '';
        }
        return invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: false,
        });
      }
      if (invoice.tenantId !== existing.tenantId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Invoice tenant identity cannot change',
        );
      const existingId = requireId(existing.id, 'Invoice');
      const locked = await lockAndReloadInvoice(tx, existingId, tenantId);
      if (isFrozen(locked.invoice)) {
        if (invoice.arReversalJournalId !== locked.invoice.arReversalJournalId)
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
          locked.invoice.arJournalId &&
          !locked.invoice.arReversalJournalId
        )
          throw new MoneyValidationError(
            'FROZEN_DOCUMENT',
            'A posted money-v2 invoice requires an atomic reversal before cancellation',
          );
        assertFieldsUnchanged(
          invoice,
          locked.invoice,
          FROZEN_INVOICE_FIELDS,
          'Invoice',
        );
        return invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: false,
        });
      }
      const freezing =
        invoice.status !== InvoiceStatus.DRAFT || !!invoice.arJournalId;
      const snapshotId = freezing
        ? locked.invoice.moneySnapshotId || crypto.randomUUID()
        : '';
      await recomputeInvoiceAggregate(tx, invoice, settings, snapshotId);
      if (freezing) {
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
      return invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
        recomputeLegacy: false,
      });
    }),
  );
}

/** Persist a line and recompute its complete invoice aggregate. */
export async function saveInvoiceLineItem(
  input: InvoiceLineItem,
): Promise<InvoiceLineItem> {
  return withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (line) => {
      const persisted = line.id
        ? await (await InvoiceLineItemCollection.create({ db: tx })).get(
            { id: line.id },
            { cache: false },
          )
        : null;
      const parentId = persisted?.invoiceId ?? line.invoiceId;
      const first = await loadInvoice(tx, parentId);
      const settings = await settingsForTenant(tx, first.invoice.tenantId);
      assertRuntimeAvailable(settings);
      if (settings?.moneyModel !== 'v2')
        return line.saveDerived(DOCUMENT_MONEY_WRITE, true);
      assertTenantId(first.invoice.tenantId);
      const { invoice } = await lockAndReloadInvoice(
        tx,
        parentId,
        first.invoice.tenantId,
      );
      if (persisted && line.invoiceId !== persisted.invoiceId)
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Invoice line cannot move between parents',
        );
      line.invoiceId = requireId(invoice.id, 'Invoice');
      line.tenantId = invoice.tenantId;
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
        return line.saveDerived(DOCUMENT_MONEY_WRITE, false);
      }
      await line.saveDerived(DOCUMENT_MONEY_WRITE, false);
      const priorAggregate = aggregateSignature(invoice);
      await recomputeInvoiceAggregate(tx, invoice, settings);
      if (aggregateSignature(invoice) !== priorAggregate) {
        await invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: false,
        });
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
    }),
  );
}

export async function deleteInvoiceLineItem(
  input: InvoiceLineItem,
  options: DeleteOptions,
): Promise<void> {
  await withDocumentMoneyTransaction(input.db, async (tx) =>
    input.withDatabase(tx, async (line) => {
      const persisted = line.id
        ? await (await InvoiceLineItemCollection.create({ db: tx })).get(
            { id: line.id },
            { cache: false },
          )
        : null;
      if (!persisted) return;
      const first = await loadInvoice(tx, persisted.invoiceId);
      const settings = await settingsForTenant(tx, first.invoice.tenantId);
      assertRuntimeAvailable(settings);
      if (settings?.moneyModel !== 'v2') {
        await line.deleteDerived(DOCUMENT_MONEY_WRITE, options);
        return;
      }
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
        await invoice.saveDerived(DOCUMENT_MONEY_WRITE, {
          recomputeLegacy: false,
        });
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
      const persisted = invoice.id ? await findInvoice(tx, invoice.id) : null;
      if (!persisted) return;
      const settings = await settingsForTenant(tx, persisted.tenantId);
      assertRuntimeAvailable(settings);
      if (settings?.moneyModel === 'v2' && isFrozen(persisted))
        throw new MoneyValidationError(
          'FROZEN_DOCUMENT',
          'Cannot delete a frozen invoice',
        );
      if (settings?.moneyModel === 'v2') {
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
      }
      await invoice.deleteDerived(DOCUMENT_MONEY_WRITE, options);
    }),
  );
}
