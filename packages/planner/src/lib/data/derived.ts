/**
 * Amounts a document's lines derive rather than take as input, on
 * smrt-commerce's money model (released in 0.56.1; `money.ts` holds the
 * mapping to the package's own calculator):
 *
 *   line amount   = quantity x unitPrice - discount
 *                   (prices without tax: the line's net; with tax: its gross)
 *   line tax      = from the line's resolved tax code, per component
 *   subtotal      = sum of the lines' net
 *   taxAmount     = sum of the lines' tax
 *   totalAmount   = subtotal + taxAmount
 *   discountTotal = sum of the lines' discounts, informational: already
 *                   inside the line amounts, never subtracted again
 *
 * A parent with line items takes these from its lines, ignoring what a form
 * sent. See AGENTS.md.
 */
import type { CatalogModel } from '../catalog/types.ts';
import {
  type LineAmountType,
  type MoneyContext,
  type SettledDocument,
  settleDocument,
  type TaxRoundingScope,
} from './money.ts';

export { lineAmount } from './money.ts';

type Row = Readonly<Record<string, unknown>>;

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const has = (model: CatalogModel, name: string) =>
  model.fields.some((f) => f.name === name);

/** A line item: it prices a quantity of something. */
export function isLineModel(model: CatalogModel): boolean {
  return ['quantity', 'unitPrice', 'amount'].every((n) => has(model, n));
}

/** The totals a document's summary shows: subtotal, tax, total. */
export const TOTAL_FIELDS = ['subtotal', 'taxAmount', 'totalAmount'] as const;

/** Every header field its lines decide, `discountTotal` included. */
export const DOCUMENT_MONEY_FIELDS = [
  ...TOTAL_FIELDS,
  'discountTotal',
] as const;

/** The fields of a line its document's calculation writes. */
export const LINE_MONEY_FIELDS = [
  'amount',
  'taxAmount',
  'taxRate',
  'taxCodeCode',
  'taxCodeName',
] as const;

const LINE_AMOUNT_TYPES: readonly string[] = ['exclusive', 'inclusive', 'none'];

/** The document's own pricing mode, else `fallback` (the app's). */
export function documentLineAmountType(
  row: Row,
  fallback: LineAmountType,
): LineAmountType {
  const value = row.lineAmountType;
  return typeof value === 'string' && LINE_AMOUNT_TYPES.includes(value)
    ? (value as LineAmountType)
    : fallback;
}

/** The document's own rounding scope, else `fallback` (the app's). */
export function documentRoundingScope(
  row: Row,
  fallback: TaxRoundingScope,
): TaxRoundingScope {
  const value = row.taxRoundingScope;
  return value === 'line' || value === 'document' ? value : fallback;
}

/**
 * `row` and its `lines` settled together: the lines' derived fields, and the
 * model's header money fields (`subtotal`, `discountTotal`, `taxAmount`,
 * `totalAmount`, where the model has them).
 */
export function settleWithLines<
  T extends Record<string, unknown>,
  L extends Row,
>(
  model: CatalogModel,
  row: T,
  lines: readonly L[],
  context: MoneyContext,
): { row: T; lines: SettledDocument<L>['lines'] } {
  const settled = settleDocument(lines, context);
  const next: Record<string, unknown> = { ...row };
  for (const name of DOCUMENT_MONEY_FIELDS) {
    if (has(model, name)) next[name] = settled[name];
  }
  return { row: next as T, lines: settled.lines };
}

/** A record that tracks what has been paid against it (an Invoice). */
export function tracksPayments(model: CatalogModel): boolean {
  return ['totalAmount', 'amountPaid', 'status'].every((n) => has(model, n));
}

const isRef = (f: { type: string }) =>
  f.type === 'foreignKey' || f.type === 'crossPackageRef';

/** The field of a payment allocation that points at its payment. */
export function allocationPaymentField(model: CatalogModel) {
  return model.fields.find((f) => isRef(f) && /^payment/i.test(f.name));
}

/** The field of a payment allocation that points at the invoice it pays. */
export function allocationInvoiceField(model: CatalogModel) {
  return model.fields.find((f) => isRef(f) && /^invoice/i.test(f.name));
}

/** A payment applied to an invoice: one payment, one invoice, an amount. */
export function isAllocationModel(model: CatalogModel): boolean {
  return (
    has(model, 'amount') &&
    Boolean(allocationPaymentField(model)) &&
    Boolean(allocationInvoiceField(model))
  );
}

/** What counts as money in: only a completed payment pays an invoice. */
export const PAID_PAYMENT_STATUS = 'completed';

export interface Settlement {
  amountPaid: number;
  status: string;
  paidDate: string | null;
}

/**
 * An invoice's payment state from the allocations of completed payments
 * (`counted`): `amountPaid` is their sum, the status is paid once the total is
 * covered, otherwise overdue after the due date and sent before it. A draft or
 * cancelled invoice keeps its status; `paidDate` is set only when fully paid,
 * to the last allocation.
 */
export function settleInvoice(
  invoice: Row,
  counted: readonly { amount: number; at: string }[],
  now: number,
): Settlement {
  const amountPaid = counted.reduce((sum, a) => sum + num(a.amount), 0);
  const total = num(invoice.totalAmount);
  const current = String(invoice.status ?? 'draft');
  const fullyPaid = total > 0 && amountPaid >= total;
  let status = current;
  if (fullyPaid) status = 'paid';
  else if (current !== 'draft' && current !== 'cancelled') {
    const due = Date.parse(String(invoice.dueDate ?? ''));
    if (Number.isFinite(due) && due < now) status = 'overdue';
    else status = current === 'viewed' ? 'viewed' : 'sent';
  }
  const last = counted
    .map((a) => a.at)
    .sort()
    .at(-1);
  return {
    amountPaid,
    status,
    paidDate: fullyPaid ? (last ?? String(invoice.issueDate ?? '')) : null,
  };
}

/**
 * The fields a form shows but does not let anyone type: a line's money (its
 * amount, tax and the tax code's snapshot), a parent's totals when it has line
 * items, and what an invoice has paid (and when) when it has payment
 * allocations.
 */
export function derivedFieldNames(
  model: CatalogModel,
  hasLineChildren: boolean,
  hasPaymentChildren = false,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (isLineModel(model)) {
    for (const name of LINE_MONEY_FIELDS) if (has(model, name)) names.add(name);
  }
  if (hasLineChildren) {
    for (const name of DOCUMENT_MONEY_FIELDS) {
      if (has(model, name)) names.add(name);
    }
  }
  if (hasPaymentChildren && tracksPayments(model)) {
    for (const name of ['amountPaid', 'paidDate']) {
      if (has(model, name)) names.add(name);
    }
  }
  return names;
}

/** Does the field of a line item point at a product? */
export function isProductField(field: {
  name: string;
  type: string;
  related?: string;
}): boolean {
  return (
    isRef(field) &&
    (field.related?.endsWith(':Product') === true ||
      /^product(Id)?$/i.test(field.name))
  );
}

/**
 * What picking a product fills in on a line item: its name as the description
 * and its price as the unit price, for the fields the line has. Both stay
 * editable. A product with no name or price fills nothing.
 */
export function productPrefill(
  line: CatalogModel,
  product: Row | undefined,
): Record<string, unknown> {
  const fill: Record<string, unknown> = {};
  if (!product) return fill;
  if (
    has(line, 'description') &&
    typeof product.name === 'string' &&
    product.name
  ) {
    fill.description = product.name;
  }
  if (has(line, 'unitPrice') && typeof product.price === 'number') {
    fill.unitPrice = product.price;
  }
  return fill;
}
