import { currencyMinorUnitExponent } from './invoices/currency.js';

/** Exact retained amount in integer minor units. */
export interface InvoiceMinorAmount {
  /** Safe integer amount in the currency's minor units. */
  amountMinor: number;
  /** ISO 4217 currency code. */
  currency: string;
}

/** Caller-authoritative retained invoice metadata. */
export interface RetainedInvoiceHeaderView {
  /** Invoice number or reference. */
  invoiceNumber: string;
  /** Caller-owned state identifier, including application-specific states. */
  status: string;
  /** Exact caller-owned state label. */
  statusLabel: string;
  /** Retained issue date. */
  issueDate: Date | string;
  /** Retained due date, when present. */
  dueDate?: Date | string | null;
  /** Retained paid date, when present. */
  paidDate?: Date | string | null;
  /** Authorized customer display name. */
  customerName?: string;
  /** Authorized project display name. */
  projectName?: string;
}

/** Compact retained invoice view for a list or grid. */
export interface RetainedInvoiceCardView extends RetainedInvoiceHeaderView {
  /** Exact retained total in integer minor units. */
  totalMinor: number;
  /** Currency of the retained total. */
  currency: string;
}

/** Caller-authoritative retained invoice line. */
export interface RetainedInvoiceLineView {
  /** Stable retained line identity. */
  id: string;
  /** Retained description. */
  description: string;
  /** Exact retained quantity text. */
  quantity: string;
  /** Retained unit price in minor units, or null when unavailable. */
  unitPriceMinor?: number | null;
  /** Exact retained line amount in minor units. */
  amountMinor: number;
  /** Retained category label. */
  category?: string;
  /** Retained source label. */
  sourceLabel?: string;
  /** Retained discount mode/value label. */
  discountLabel?: string;
  /** Retained tax labels, including explicit zero or multiple taxes. */
  taxLabels?: readonly string[];
  /** Retained correction or supersession label. */
  correctionLabel?: string;
}

/** Exact retained invoice lines and their authoritative subtotal. */
export interface RetainedInvoiceLineItemsView {
  /** Currency shared by every retained line amount. */
  currency: string;
  /** Caller-authoritative retained lines. */
  lines: readonly RetainedInvoiceLineView[];
  /** Caller-authoritative subtotal; never derived from lines by the component. */
  subtotalMinor: number;
}

/** One retained tax fact. */
export interface RetainedInvoiceTaxView {
  /** Stable tax identity. */
  id: string;
  /** Caller-owned tax label. */
  label: string;
  /** Exact retained tax amount in minor units. */
  amountMinor: number;
}

/** Caller-authoritative retained totals; values are never recalculated. */
export interface RetainedInvoiceTotalsView {
  /** Currency shared by every retained amount. */
  currency: string;
  /** Exact retained subtotal. */
  subtotalMinor: number;
  /** Exact retained discount, including zero. */
  discountMinor?: number;
  /** Retained tax facts, including multiple or zero taxes. */
  taxes?: readonly RetainedInvoiceTaxView[];
  /** Exact retained holdback, including zero. */
  holdbackMinor?: number;
  /** Caller-owned holdback label. */
  holdbackLabel?: string;
  /** Exact retained total. */
  totalMinor: number;
  /** Exact retained paid amount, including zero. */
  paidMinor?: number;
  /** Exact retained currently payable amount, including zero. */
  payableMinor?: number;
}

/** Format safe integer minor units without a floating-point unit conversion. */
export function formatInvoiceMinorUnits(
  amountMinor: number,
  currency: string,
  locale = 'en-CA',
): string {
  if (!Number.isSafeInteger(amountMinor))
    throw new RangeError('Invoice amountMinor must be a safe integer');
  const digits = currencyMinorUnitExponent(currency);
  const negative = amountMinor < 0;
  const raw = BigInt(Math.abs(amountMinor))
    .toString()
    .padStart(digits + 1, '0');
  const major = digits
    ? `${negative ? '-' : ''}${raw.slice(0, -digits)}.${raw.slice(-digits)}`
    : `${negative ? '-' : ''}${raw}`;
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return (formatter.format as unknown as (value: string) => string)(major);
}
