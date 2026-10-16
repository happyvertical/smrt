/** Owning collection for derived document tax totals. */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  DOCUMENT_MONEY_WRITE,
  type DocumentMoneyWriteCapability,
} from '../document-money-internal.js';
import { classifyContractPurchase } from '../models/Contract.js';
import {
  type CommerceDocumentType,
  DocumentTax,
  type DocumentTaxOptions,
} from '../models/DocumentTax.js';
import { MoneyValidationError, type TaxCodeKind } from '../money.js';
import { receivedPurchaseReportFacts } from '../received-purchase-money.js';
import { ContractCollection } from './ContractCollection.js';

export type DocumentTaxWriteInput = Required<
  Pick<
    DocumentTaxOptions,
    | 'tenantId'
    | 'documentType'
    | 'documentId'
    | 'currency'
    | 'taxCodeId'
    | 'taxCodeCode'
    | 'kind'
    | 'taxComponentId'
    | 'taxComponentName'
    | 'percent'
    | 'liabilityAccountId'
    | 'taxableMinor'
    | 'taxMinor'
    | 'recoverableMinor'
  >
>;

/** Normalized immutable document-tax snapshots for tax-summary materialization. */
export interface DocumentTaxReportFact {
  tenantId: string;
  documentType: CommerceDocumentType;
  documentId: string;
  /** A document number/reference supplied to drilldown consumers. */
  documentNumber: string;
  /** Tenant-scoped party identity for a host to resolve as its party display. */
  partyId: string | null;
  /** Positive credit snapshots are negated once by the pure report aggregation. */
  documentKind: CommerceDocumentType;
  issueDate: string;
  status: string;
  direction: 'sales' | 'purchase';
  currency: string;
  taxCodeId: string | null;
  /** Null is an unassigned/unknown snapshot and must remain visible as a warning. */
  taxCodeKind: TaxCodeKind | null;
  taxableMinor: number;
  taxMinor: number;
  recoverableMinor: number;
  taxComponentId: string | null;
  componentName: string | null;
  liabilityAccountId: string | null;
  /** Purchase Contracts are the expense commitment identity; other documents are unlinked. */
  commitmentId: string | null;
  /** Document-tax snapshots are contract-level, so they retain no line allocation. */
  commitmentLineId: string | null;
}

/** @deprecated Use DocumentTaxReportFact. Kept for report-adapter compatibility. */
export type InvoiceTaxReportFact = DocumentTaxReportFact;

export interface DocumentTaxReportFactsOptions {
  tenantId: string;
  from: Date;
  to: Date;
  currency?: string;
}

/** @deprecated Use DocumentTaxReportFactsOptions. */
export type InvoiceTaxReportFactsOptions = DocumentTaxReportFactsOptions;

const TAX_CODE_KINDS = new Set<TaxCodeKind>([
  'taxable',
  'zero-rated',
  'exempt',
  'out-of-scope',
]);

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Invoice tax report ${label} must be a nonempty string.`);
  return value;
}

function storedMinor(value: unknown, label: string): number {
  const parsed =
    typeof value === 'bigint'
      ? Number(value)
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d+$/.test(value)
          ? Number(value)
          : Number.NaN;
  if (!Number.isSafeInteger(parsed))
    throw new RangeError(
      `Invoice tax report ${label} must be a safe integer minor-unit value.`,
    );
  return parsed;
}

function reportDate(value: unknown, label: string): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new Error(`Invoice tax report ${label} must be a valid date.`);
  return date.toISOString();
}

function invoiceDocumentType(value: unknown): 'invoice' | 'credit_note' {
  if (value === 'invoice' || value === 'credit_note') return value;
  throw new Error(
    'Invoice tax report document type must be invoice or credit_note.',
  );
}

function invoiceKind(value: unknown): 'invoice' | 'credit_note' {
  if (value === 'invoice' || value === 'credit_note') return value;
  throw new Error('Invoice tax report kind must be invoice or credit_note.');
}

function contractDocumentType(value: unknown): 'contract' {
  if (value === 'contract') return value;
  throw new Error('Contract tax report document type must be contract.');
}

function taxCodeKind(value: unknown): TaxCodeKind | null {
  return typeof value === 'string' && TAX_CODE_KINDS.has(value as TaxCodeKind)
    ? (value as TaxCodeKind)
    : null;
}

function assertReportFactOptions(options: DocumentTaxReportFactsOptions): void {
  if (!options.tenantId?.trim())
    throw new Error('Invoice tax report facts require a tenant.');
  if (!(options.from instanceof Date) || Number.isNaN(options.from.getTime()))
    throw new Error('Invoice tax report facts require a valid start date.');
  if (!(options.to instanceof Date) || Number.isNaN(options.to.getTime()))
    throw new Error('Invoice tax report facts require a valid end date.');
  if (options.from > options.to)
    throw new Error('Invoice tax report facts require an ordered date range.');
  if (options.currency !== undefined && !options.currency.trim())
    throw new Error(
      'Invoice tax report currency must be nonempty when supplied.',
    );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function identity(
  row: Pick<DocumentTaxWriteInput, 'taxCodeId' | 'taxComponentId'>,
): string {
  return `${row.taxCodeId === null ? '0:' : `1:${row.taxCodeId}`}\u0000${
    row.taxComponentId === null ? '0:' : `1:${row.taxComponentId}`
  }`;
}

const BUSINESS_FIELDS = [
  'tenantId',
  'documentType',
  'documentId',
  'currency',
  'taxCodeId',
  'taxCodeCode',
  'kind',
  'taxComponentId',
  'taxComponentName',
  'percent',
  'liabilityAccountId',
  'taxableMinor',
  'taxMinor',
  'recoverableMinor',
] as const;

function unchanged(row: DocumentTax, input: DocumentTaxWriteInput): boolean {
  return BUSINESS_FIELDS.every((field) => {
    const persisted = row[field];
    const proposed = input[field];
    if (field === 'percent' && persisted !== null && proposed !== null) {
      return String(persisted) === String(proposed);
    }
    return (persisted ?? null) === (proposed ?? null);
  });
}

export class DocumentTaxCollection extends SmrtCollection<DocumentTax> {
  static readonly _itemClass = DocumentTax;

  /**
   * Read immutable commerce document-tax snapshots for one tenant.
   *
   * Invoice/credit rows join their shared storage by identity and tenant.
   * Purchase Contract rows first use the Contract owner's bounded hydrated
   * candidate API so custom PurchaseContract descendants retain their STI
   * classification. The query then joins only those candidate ids by identity
   * and tenant. Stored snapshots remain authoritative; this never recalculates
   * money or resolves present-day tax configuration.
   */
  async listReportFacts(
    options: DocumentTaxReportFactsOptions,
  ): Promise<DocumentTaxReportFact[]> {
    assertReportFactOptions(options);
    const [invoiceFacts, purchaseFacts] = await Promise.all([
      this.listInvoiceReportFacts(options),
      this.listPurchaseContractReportFacts(options),
    ]);
    return [...invoiceFacts, ...purchaseFacts].sort(
      (left, right) =>
        left.issueDate.localeCompare(right.issueDate) ||
        left.documentId.localeCompare(right.documentId) ||
        String(left.taxCodeId).localeCompare(String(right.taxCodeId)) ||
        String(left.taxComponentId).localeCompare(String(right.taxComponentId)),
    );
  }

  private async listInvoiceReportFacts(
    options: DocumentTaxReportFactsOptions,
  ): Promise<DocumentTaxReportFact[]> {
    const currencyClause = options.currency ? ' AND d.currency = ?' : '';
    const result = await this.db.query(
      `SELECT d.tenant_id, d.document_type, d.document_id, d.currency, d.tax_code_id, d.kind,
              d.tax_component_id, d.tax_component_name, d.liability_account_id,
              d.taxable_minor, d.tax_minor, d.recoverable_minor,
              i.kind AS invoice_kind, i.invoice_number, i.customer_id, i.issue_date, i.status
         FROM document_taxes d
         JOIN invoices i
           ON CAST(i.id AS TEXT) = CAST(d.document_id AS TEXT)
          AND i.tenant_id = d.tenant_id
        WHERE CAST(d.tenant_id AS TEXT) = ?
          AND CAST(i.tenant_id AS TEXT) = ?
          AND (
            (d.document_type = 'invoice' AND i.kind = 'invoice')
            OR (d.document_type = 'credit_note' AND i.kind = 'credit_note')
          )
          AND i.status NOT IN ('draft', 'cancelled')
          AND i.issue_date >= ?
          AND i.issue_date <= ?${currencyClause}
        ORDER BY i.issue_date ASC, i.id ASC, d.tax_code_id ASC, d.tax_component_id ASC`,
      options.tenantId,
      options.tenantId,
      options.from.toISOString(),
      options.to.toISOString(),
      ...(options.currency ? [options.currency] : []),
    );
    return result.rows.map((row) => ({
      tenantId: requiredText(row.tenant_id, 'tenant id'),
      documentType: invoiceDocumentType(row.document_type),
      documentId: requiredText(row.document_id, 'document id'),
      documentNumber: requiredText(row.invoice_number, 'invoice number'),
      partyId:
        typeof row.customer_id === 'string' && row.customer_id.trim()
          ? row.customer_id
          : null,
      documentKind: invoiceKind(row.invoice_kind),
      issueDate: reportDate(row.issue_date, 'issue date'),
      status: requiredText(row.status, 'invoice status'),
      direction: 'sales' as const,
      currency: requiredText(row.currency, 'currency'),
      taxCodeId: row.tax_code_id == null ? null : String(row.tax_code_id),
      taxCodeKind: taxCodeKind(row.kind),
      taxableMinor: storedMinor(row.taxable_minor, 'taxable minor'),
      taxMinor: storedMinor(row.tax_minor, 'tax minor'),
      recoverableMinor: storedMinor(row.recoverable_minor, 'recoverable minor'),
      taxComponentId:
        row.tax_component_id == null ? null : String(row.tax_component_id),
      componentName:
        row.tax_component_name == null ? null : String(row.tax_component_name),
      liabilityAccountId:
        row.liability_account_id == null
          ? null
          : String(row.liability_account_id),
      commitmentId: null,
      commitmentLineId: null,
    }));
  }

  private async listPurchaseContractReportFacts(
    options: DocumentTaxReportFactsOptions,
  ): Promise<DocumentTaxReportFact[]> {
    const contracts = await withTenant({ tenantId: options.tenantId }, () =>
      ContractCollection.create({ db: this.db }).then((collection) =>
        collection.listSnapshotReportContracts({
          tenantId: options.tenantId,
          from: options.from,
          to: options.to,
        }),
      ),
    );
    const candidates = contracts.filter(
      (contract) =>
        classifyContractPurchase(contract) &&
        (!options.currency || contract.currency === options.currency),
    );
    const receivedFacts = candidates
      .filter((contract) => contract.moneyAuthority === 'received')
      .flatMap(receivedPurchaseReportFacts);
    const purchases = candidates.filter(
      (contract) => contract.moneyAuthority !== 'received',
    );
    const ids = purchases.flatMap((contract) =>
      contract.id ? [contract.id] : [],
    );
    if (ids.length === 0) return receivedFacts;
    const byId = new Map(
      purchases.flatMap((contract) =>
        contract.id ? ([[contract.id, contract]] as const) : [],
      ),
    );
    const placeholders = ids.map(() => '?').join(', ');
    const currencyClause = options.currency ? ' AND d.currency = ?' : '';
    const result = await this.db.query(
      `SELECT d.tenant_id, d.document_type, d.document_id, d.currency, d.tax_code_id, d.kind,
              d.tax_component_id, d.tax_component_name, d.liability_account_id,
              d.taxable_minor, d.tax_minor, d.recoverable_minor
         FROM document_taxes d
         JOIN contracts c
           ON CAST(c.id AS TEXT) = CAST(d.document_id AS TEXT)
          AND c.tenant_id = d.tenant_id
        WHERE CAST(d.tenant_id AS TEXT) = ?
          AND CAST(c.tenant_id AS TEXT) = ?
          AND d.document_type = 'contract'
          AND c.status NOT IN ('draft', 'cancelled')
          AND CAST(d.document_id AS TEXT) IN (${placeholders})${currencyClause}
        ORDER BY c.issue_date ASC, c.id ASC, d.tax_code_id ASC, d.tax_component_id ASC`,
      options.tenantId,
      options.tenantId,
      ...ids,
      ...(options.currency ? [options.currency] : []),
    );
    const calculatedFacts = result.rows.flatMap(
      (row): DocumentTaxReportFact[] => {
        const documentId = requiredText(row.document_id, 'contract id');
        const contract = byId.get(documentId);
        if (!contract) return [];
        return [
          {
            tenantId: requiredText(row.tenant_id, 'tenant id'),
            documentType: contractDocumentType(row.document_type),
            documentId,
            documentNumber: contract.reference.trim() || documentId,
            partyId:
              'vendorId' in contract &&
              typeof contract.vendorId === 'string' &&
              contract.vendorId.trim()
                ? contract.vendorId
                : null,
            documentKind: 'contract',
            issueDate: reportDate(contract.issueDate, 'contract issue date'),
            status: requiredText(contract.status, 'contract status'),
            direction: 'purchase',
            currency: requiredText(row.currency, 'currency'),
            taxCodeId: row.tax_code_id == null ? null : String(row.tax_code_id),
            taxCodeKind: taxCodeKind(row.kind),
            taxableMinor: storedMinor(row.taxable_minor, 'taxable minor'),
            taxMinor: storedMinor(row.tax_minor, 'tax minor'),
            recoverableMinor: storedMinor(
              row.recoverable_minor,
              'recoverable minor',
            ),
            taxComponentId:
              row.tax_component_id == null
                ? null
                : String(row.tax_component_id),
            componentName:
              row.tax_component_name == null
                ? null
                : String(row.tax_component_name),
            liabilityAccountId:
              row.liability_account_id == null
                ? null
                : String(row.liability_account_id),
            // Expenses reference their PurchaseContract id as commitmentId.
            commitmentId: documentId,
            commitmentLineId: null,
          },
        ];
      },
    );
    return [...calculatedFacts, ...receivedFacts];
  }

  async findByDocument(
    tenantId: string,
    documentType: CommerceDocumentType,
    documentId: string,
  ): Promise<DocumentTax[]> {
    return this.list({
      where: { tenantId, documentType, documentId },
      orderBy: ['taxCodeId ASC', 'taxComponentId ASC'],
    });
  }

  /**
   * Replace one draft document's derived rows on the caller's transaction.
   * Unchanged rows are not saved, preserving their exact persisted bytes.
   *
   * @internal Aggregate persistence only.
   */
  async replaceDerivedForDocument(
    capability: DocumentMoneyWriteCapability,
    input: {
      tenantId: string;
      documentType: CommerceDocumentType;
      documentId: string;
      rows: readonly DocumentTaxWriteInput[];
    },
  ): Promise<DocumentTax[]> {
    if (capability !== DOCUMENT_MONEY_WRITE) {
      throw new MoneyValidationError(
        'FROZEN_DOCUMENT',
        'DocumentTax write capability is required',
      );
    }
    const desired = new Map<string, DocumentTaxWriteInput>();
    for (const row of input.rows) {
      if (
        row.tenantId !== input.tenantId ||
        row.documentType !== input.documentType ||
        row.documentId !== input.documentId
      ) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'DocumentTax replacement rows must share tenant and document identity',
        );
      }
      const key = identity(row);
      if (desired.has(key)) {
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'DocumentTax replacement contains a duplicate code/component identity',
        );
      }
      desired.set(key, row);
    }

    const existing = await this.findByDocument(
      input.tenantId,
      input.documentType,
      input.documentId,
    );
    const byIdentity = new Map(existing.map((row) => [identity(row), row]));
    const result: DocumentTax[] = [];
    for (const [key, rowInput] of [...desired].sort(([left], [right]) =>
      compareCodeUnits(left, right),
    )) {
      const current = byIdentity.get(key);
      if (current) {
        byIdentity.delete(key);
        if (!unchanged(current, rowInput)) {
          Object.assign(current, rowInput);
          await current.saveDerived(capability);
        }
        result.push(current);
        continue;
      }
      const created = await this.createUnsaved(rowInput);
      await created.saveDerived(capability);
      result.push(created);
    }
    for (const stale of [...byIdentity.values()].sort((left, right) =>
      compareCodeUnits(String(left.id), String(right.id)),
    )) {
      await stale.deleteDerived(capability, {
        expectedUpdatedAt: stale.updated_at ?? undefined,
      });
    }
    return result;
  }
}
