/** Stored-money projection for the generated Invoice MCP get tool. */

import type { PublicJsonOptions } from '@happyvertical/smrt-core';
import { getInvoiceMoneyFacts, settingsForTenant } from './document-money.js';
import type { Invoice } from './models/Invoice.js';
import { MoneyValidationError } from './money.js';

export type InvoiceMcpGetResult = Record<string, unknown> & {
  money?: Awaited<ReturnType<typeof getInvoiceMoneyFacts>>;
};

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
  const base = invoice.toPublicJSON(options);
  const settings = await settingsForTenant(invoice.db, invoice.tenantId);
  if (settings?.moneyModel === 'migrating') {
    throw new MoneyValidationError(
      'FROZEN_DOCUMENT',
      'Tenant money migration is in progress',
    );
  }
  if (settings?.moneyModel !== 'v2') return base;
  if (!invoice.id || !invoice.tenantId) {
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice MCP money facts require a persisted tenant invoice',
    );
  }
  return {
    ...base,
    money: await getInvoiceMoneyFacts({
      db: invoice.db,
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
    }),
  };
}
