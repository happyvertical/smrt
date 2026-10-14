/** Explicit policy and persistence guards for canonical invoice rounding. */

import type { InvoiceAllocatedLine } from './invoice-rounding.js';
import type { Invoice } from './models/Invoice.js';
import type { InvoiceLineItem } from './models/InvoiceLineItem.js';
import type { RecognizeRevenueOptions } from './types/index.js';

/** Caller-authorized tenant policy retained with the invoice, never inferred from locale. */
export interface InvoiceRoundingPolicy {
  /** Owning tenant; invoice rounding requires explicit tenant ownership. */
  tenantId: string;
  /** Application-owned approved policy identity. */
  id: string;
  /** Immutable application policy version. */
  version: string;
  /** Invoice currency selected by that policy. */
  currency: string;
  /** Explicit aggregate tax scope. */
  scope: 'invoice';
  /** Public exact allocation convention, including signed ties. */
  allocation: 'signed-largest-remainder';
  /** Version of the resolved-line calculation contract. */
  calculation: 'invoice-resolved-v1';
}

export const pendingInvoicePolicies = new WeakMap<Invoice, string>();
export const freezingInvoices = new WeakMap<Invoice, RecognizeRevenueOptions>();
export const allocatingInvoiceLines = new WeakSet<InvoiceLineItem>();

/** Validate and detach a caller-selected policy; unknown conventions fail closed. */
export function validateInvoiceRoundingPolicy(
  value: unknown,
): InvoiceRoundingPolicy {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid invoice rounding policy');
  const policy = value as InvoiceRoundingPolicy;
  for (const key of ['tenantId', 'id', 'version'] as const) {
    if (
      typeof policy[key] !== 'string' ||
      !policy[key].trim() ||
      policy[key].length > 128
    )
      throw new Error(`Invalid invoice rounding policy ${key}`);
  }
  if (
    typeof policy.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(policy.currency) ||
    policy.scope !== 'invoice' ||
    policy.allocation !== 'signed-largest-remainder' ||
    policy.calculation !== 'invoice-resolved-v1'
  )
    throw new Error('Unsupported invoice rounding policy');
  return {
    tenantId: policy.tenantId,
    id: policy.id,
    version: policy.version,
    currency: policy.currency,
    scope: policy.scope,
    allocation: policy.allocation,
    calculation: policy.calculation,
  };
}

/** Empty historical storage means per-line rounding; malformed nonempty storage is an error. */
export function parseInvoiceRoundingPolicy(
  value: string,
): InvoiceRoundingPolicy | null {
  if (!value) return null;
  return validateInvoiceRoundingPolicy(JSON.parse(value));
}

/** Exact resolved inputs retained with an allocated tax; metadata never supplies the basis. */
export function invoiceLineRoundingSource(line: InvoiceLineItem): string {
  return JSON.stringify([
    line.id,
    line.invoiceId,
    line.tenantId,
    line.quantity,
    line.unitPrice,
    line.discount,
    line.taxRate,
  ]);
}

/** Read allocated tax only when it belongs to this exact resolved line revision. */
export function allocatedLineTax(line: InvoiceLineItem): number | null {
  if (!line.invoiceTaxAllocationJson) return null;
  const value = JSON.parse(line.invoiceTaxAllocationJson) as {
    source?: string;
    taxMinor?: number;
  };
  if (
    value.source !== invoiceLineRoundingSource(line) ||
    !Number.isSafeInteger(value.taxMinor)
  )
    throw new Error(
      'Stale or malformed invoice tax allocation; save the draft line to recalculate',
    );
  return value.taxMinor!;
}

/** Save one derived allocation through normal model hooks using a package-owned capability. */
export async function persistInvoiceLineAllocation(
  line: InvoiceLineItem,
  amounts: InvoiceAllocatedLine,
): Promise<void> {
  const json = JSON.stringify({
    source: invoiceLineRoundingSource(line),
    taxMinor: amounts.taxMinor,
  });
  if (
    line.invoiceTaxAllocationJson === json &&
    line.amount === amounts.totalMinor
  )
    return;
  line.invoiceTaxAllocationJson = json;
  line.amount = amounts.totalMinor;
  allocatingInvoiceLines.add(line);
  try {
    await line.save();
  } finally {
    allocatingInvoiceLines.delete(line);
  }
}
