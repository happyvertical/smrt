/**
 * Amounts a document's lines derive rather than take as input, in integer
 * minor units, mirrored from smrt-commerce's `ContractLineItem.calculateAmount`
 * (a line's `amount` is tax-inclusive) and read the way smrt-svelte 0.55.24's
 * `line-items` widget reads them (lines that add up to the recorded total
 * agree with the record):
 *
 *   line price    = round(quantity * unitPrice)                (before discount and tax)
 *   line tax      = round((line price - discount) * taxRate)   (taxRate is a fraction)
 *   line amount   = line price - discount + line tax           (tax-inclusive)
 *
 *   subtotal      = sum of line prices
 *   discount      = sum of line discounts (no document field: the totals block)
 *   taxAmount     = sum of line taxes
 *   totalAmount   = subtotal - discount + taxAmount = sum of line amounts
 *
 * A parent with line items takes `subtotal`, `taxAmount` and `totalAmount`
 * from its lines, ignoring what a form sent.
 *
 * INTERIM rule, until the money-model release: line amount = qty * unitPrice
 * - discount + tax, subtotal = the sum of pre-discount prices. It matches the
 * smrt <=0.56.0 line-items widget. smrt main's money model (smrt#3988, merged
 * but unreleased) makes `amount` the net after discount, stores tax apart
 * (`taxAmount`), and adds `lineAmountType` (exclusive / inclusive / none), tax
 * codes and components, `discountType` / `discountRate` and
 * `taxRoundingScope`. The planner moves to it when the release lands. Upstream
 * gap: fresh tenants default to the legacy model (being filed upstream).
 * See AGENTS.md.
 */
import type { CatalogModel } from '../catalog/types.ts';

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

export interface LineAmounts {
  /** Quantity times unit price, before discount and tax. */
  price: number;
  discount: number;
  tax: number;
  /** What the line comes to: price - discount + tax (tax-inclusive). */
  amount: number;
}

export function lineAmounts(line: Row): LineAmounts {
  const price = Math.round(num(line.quantity) * num(line.unitPrice));
  const discount = num(line.discount);
  const tax = Math.round((price - discount) * num(line.taxRate));
  return { price, discount, tax, amount: price - discount + tax };
}

/** The line with its `amount` brought in line with its other fields. */
export function settleLine<T extends Row>(line: T): T & { amount: number } {
  return { ...line, amount: lineAmounts(line).amount };
}

export interface ParentTotals {
  subtotal: number;
  /** The lines' discounts; documents carry no field for it. */
  discount: number;
  taxAmount: number;
  totalAmount: number;
}

export function totalsOf(lines: readonly Row[]): ParentTotals {
  let subtotal = 0;
  let discount = 0;
  let taxAmount = 0;
  for (const line of lines) {
    const parts = lineAmounts(line);
    subtotal += parts.price;
    discount += parts.discount;
    taxAmount += parts.tax;
  }
  return {
    subtotal,
    discount,
    taxAmount,
    totalAmount: subtotal - discount + taxAmount,
  };
}

export const TOTAL_FIELDS = ['subtotal', 'taxAmount', 'totalAmount'] as const;

/** `row` with the model's total fields set from `lines`. */
export function withTotals<T extends Record<string, unknown>>(
  model: CatalogModel,
  row: T,
  lines: readonly Row[],
): T {
  const totals = totalsOf(lines);
  const next: Record<string, unknown> = { ...row };
  for (const name of TOTAL_FIELDS) {
    if (has(model, name)) next[name] = totals[name];
  }
  return next as T;
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
 * The fields a form shows but does not let anyone type: a line's `amount`, a
 * parent's totals when it has line items, and what an invoice has paid (and
 * when) when it has payment allocations.
 */
export function derivedFieldNames(
  model: CatalogModel,
  hasLineChildren: boolean,
  hasPaymentChildren = false,
): ReadonlySet<string> {
  const names = new Set<string>();
  if (isLineModel(model)) names.add('amount');
  if (hasLineChildren) {
    for (const name of TOTAL_FIELDS) if (has(model, name)) names.add(name);
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
