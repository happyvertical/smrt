/** Commerce composition data for the generic record screen. */

import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { InvoiceCollection } from './collections/InvoiceCollection.js';
import {
  getInvoiceMoneyFacts,
  type InvoiceMoneyFacts,
} from './document-money.js';
import { MoneyValidationError } from './money.js';
import { withTenantMoneyRuntime } from './tenant-money-barrier.js';

/** A frozen component row shaped for `RecordScreen.lineItemStoredTotals`. */
export interface InvoiceRecordTaxComponent {
  taxComponentId: string;
  name: string;
  percent: string;
  taxable: number;
  tax: number;
}

/** The immutable totals projection that the generic record widget displays. */
export interface InvoiceRecordStoredTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  lineAmountType: 'exclusive' | 'inclusive' | 'none';
  roundingScope: 'line' | 'document';
  showNetSubtotal: boolean;
  taxes: readonly InvoiceRecordTaxComponent[];
}

/** A credit-note summary safe to show beside its source invoice. */
export interface InvoiceRecordCreditNote {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  totalMinor: number;
}

/** Tenant-scoped, stored-only data for an invoice record screen. */
export interface InvoiceRecordScreenData {
  invoiceId: string;
  kind: InvoiceMoneyFacts['kind'];
  status: InvoiceMoneyFacts['status'];
  currency: string;
  storedTotals: InvoiceRecordStoredTotals;
  creditNotes: readonly InvoiceRecordCreditNote[];
}

export interface LoadInvoiceRecordScreenDataInput {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  /** Hosts choose whether inclusive taxed records disclose their net subtotal. */
  showNetSubtotal?: boolean;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Invoice record ${label} must be a nonempty string`,
    );
  return value;
}

function storedMinor(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value))
    throw new MoneyValidationError(
      'UNSAFE_MONEY',
      `Invoice record ${label} must be a safe integer minor-unit value`,
    );
  return value as number;
}

function isoDate(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      `Invoice record ${label} must be a valid date`,
    );
  return date.toISOString();
}

/**
 * Maps only persisted invoice and `DocumentTax` fields to the generic widget
 * contract. No tax, discount, or total is calculated here.
 */
export function invoiceRecordStoredTotals(
  facts: InvoiceMoneyFacts,
  options: { showNetSubtotal?: boolean } = {},
): InvoiceRecordStoredTotals {
  return {
    subtotal: storedMinor(facts.header.subtotalMinor, 'subtotal'),
    discount: storedMinor(facts.header.discountTotalMinor, 'discount'),
    tax: storedMinor(facts.header.taxAmountMinor, 'tax'),
    total: storedMinor(facts.header.totalAmountMinor, 'total'),
    lineAmountType: facts.header.lineAmountType,
    roundingScope: facts.header.taxRoundingScope,
    showNetSubtotal: options.showNetSubtotal ?? true,
    taxes: facts.taxes.flatMap((tax) => {
      if (!tax.taxComponentId || !tax.taxComponentName || tax.percent === null)
        return [];
      return [
        {
          taxComponentId: tax.taxComponentId,
          name: tax.taxComponentName,
          percent: String(tax.percent),
          taxable: storedMinor(tax.taxableMinor, 'component taxable'),
          tax: storedMinor(tax.taxMinor, 'component tax'),
        },
      ];
    }),
  };
}

/**
 * Loads a v2 invoice's frozen record-screen data in one tenant money read
 * scope. Callers must already be executing for the same tenant; this helper
 * never switches a principal from its supplied id.
 */
export async function loadInvoiceRecordScreenData(
  input: LoadInvoiceRecordScreenDataInput,
): Promise<InvoiceRecordScreenData> {
  const activeTenantId = getTenantId();
  if (!activeTenantId || activeTenantId !== input.tenantId)
    throw new MoneyValidationError(
      'INVALID_MONEY_INPUT',
      'Invoice record data requires its active principal tenant',
    );
  return withTenantMoneyRuntime(
    input.db,
    input.tenantId,
    'v2',
    async (scope) => {
      const facts = await getInvoiceMoneyFacts({
        db: scope.db,
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
      });
      const credits = await (
        await InvoiceCollection.create({ db: scope.db })
      ).list({
        where: {
          tenantId: input.tenantId,
          kind: 'credit_note',
          creditedInvoiceId: input.invoiceId,
        },
        orderBy: 'issueDate DESC',
      });
      return {
        invoiceId: facts.invoiceId,
        kind: facts.kind,
        status: facts.status,
        currency: facts.header.currency,
        storedTotals: invoiceRecordStoredTotals(facts, input),
        creditNotes: credits.map((credit) => ({
          id: requiredText(credit.id, 'credit id'),
          invoiceNumber: requiredText(credit.invoiceNumber, 'credit number'),
          status: requiredText(credit.status, 'credit status'),
          issueDate: isoDate(credit.issueDate, 'credit issue date'),
          totalMinor: storedMinor(credit.totalAmount, 'credit total'),
        })),
      };
    },
  );
}
