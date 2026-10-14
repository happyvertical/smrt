/** Stored-money projection for the generated Invoice MCP get tool. */

import type { PublicJsonOptions } from '@happyvertical/smrt-core';
import { DocumentTaxCollection } from './collections/DocumentTaxCollection.js';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from './collections/InvoiceLineItemCollection.js';
import { getInvoiceMoneyFacts } from './document-money.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';

export type InvoiceMcpGetResult = Record<string, unknown> & {
  money?: Awaited<ReturnType<typeof getInvoiceMoneyFacts>>;
};

const REQUIRED_INVOICE_MONEY_FIELDS = [
  'id',
  'moneySnapshotId',
  'kind',
  'status',
  'currency',
  'lineAmountType',
  'taxRoundingScope',
  'subtotal',
  'discountTotal',
  'taxAmount',
  'providerTaxAmount',
  'totalAmount',
] as const;

const REQUIRED_LINE_MONEY_FIELDS = [
  'id',
  'amount',
  'discount',
  'taxAmount',
  'taxCodeId',
  'taxCodeCode',
  'taxCodeName',
  'taxComponentsJson',
] as const;

const REQUIRED_TAX_MONEY_FIELDS = [
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

function exposesFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => Object.hasOwn(value, field));
}

/**
 * Fail closed when any owning model hides a field used to derive a money alias.
 * Plain DTO aliases cannot carry model field policy themselves, so the whole
 * money projection is omitted instead of allowing a restricted source value to
 * reappear under a different key.
 */
async function mayExposeMoneyProjection(
  invoice: Invoice,
  invoiceId: string,
  tenantId: string,
  options?: PublicJsonOptions,
): Promise<boolean> {
  if (
    !exposesFields(invoice.toPublicJSON(options), REQUIRED_INVOICE_MONEY_FIELDS)
  )
    return false;
  const lines = await (
    await InvoiceLineItemCollection.create({ db: invoice.db })
  ).findByInvoice(invoiceId);
  if (
    lines.some(
      (line) =>
        !exposesFields(line.toPublicJSON(options), REQUIRED_LINE_MONEY_FIELDS),
    )
  )
    return false;
  const taxes = await (
    await DocumentTaxCollection.create({ db: invoice.db })
  ).findByDocument(tenantId, invoice.kind, invoiceId);
  return taxes.every((row) =>
    exposesFields(row.toPublicJSON(options), REQUIRED_TAX_MONEY_FIELDS),
  );
}

/**
 * Serialize one already-authorized Invoice get response.
 *
 * Legacy tenants keep the ordinary public Invoice shape. Money-v2 tenants get
 * the authoritative stored snapshot and DocumentTax rows under `money`; this
 * function never resolves current tax codes or recalculates totals.
 */
export async function serializeInvoiceMcpGet(
  invoice: Invoice,
  options?: PublicJsonOptions,
): Promise<InvoiceMcpGetResult> {
  if (!invoice.id || !invoice.tenantId) return invoice.toPublicJSON(options);
  const invoiceId = invoice.id;
  const tenantId = invoice.tenantId;
  return withTenantMoneyRuntime(
    invoice.db,
    tenantId,
    'legacy-or-v2',
    async (scope) => {
      if (scope.barrier.moneyModel !== 'v2')
        return invoice.toPublicJSON(options);
      const authoritative = await (
        await InvoiceCollection.create({ db: scope.db })
      ).get({ id: invoiceId }, { cache: false });
      if (!authoritative || authoritative.tenantId !== tenantId)
        throw new MoneyValidationError(
          'INVALID_MONEY_INPUT',
          'Invoice MCP money facts require a persisted tenant invoice',
        );
      const base = authoritative.toPublicJSON(options);
      if (
        !(await mayExposeMoneyProjection(
          authoritative,
          invoiceId,
          tenantId,
          options,
        ))
      )
        return base;
      return {
        ...base,
        money: await getInvoiceMoneyFacts({
          db: scope.db,
          tenantId,
          invoiceId,
        }),
      };
    },
  );
}
