/**
 * The totals block of a document's line items (#3718 record page), pure and
 * Node-tested. The record's own subtotal / discount / tax / total are
 * authoritative and shown as they are; a missing one is computed from the
 * lines. When the record's figures disagree with the lines, the block flags
 * it ("Lines add up to $X") instead of silently overriding either side.
 *
 * One money semantic (#4010), smrt-commerce's document money: line amounts
 * are net of discount, or gross (tax included) when the record's
 * `lineAmountType` is `inclusive`, where net = gross - tax. A record without
 * a `lineAmountType` is `exclusive`. subtotal = sum of the net lines,
 * total = subtotal + tax, and the discount is already inside the lines: it
 * is shown as included and never subtracted. An unavailable tax (no field,
 * or one the policy hides) is unknown, never zero, so no figure that needs
 * it is computed or compared from the lines.
 *
 * Money is integer minor units throughout.
 */

/** How a document's line amounts treat tax (smrt-commerce `lineAmountType`). */
export type LineAmountType = 'exclusive' | 'inclusive' | 'none';

/** The record's own totals fields (`subtotal` / `discount` / `tax` / `total` roles). */
export interface LineItemsTotals {
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  total?: number | null;
  /** The record's `lineAmountType`; absent means `exclusive`. */
  lineAmountType?: LineAmountType | null;
}

/** Whether `value` is a `lineAmountType` the totals block understands. */
export function isLineAmountType(value: unknown): value is LineAmountType {
  return value === 'exclusive' || value === 'inclusive' || value === 'none';
}

/** A frozen per-component tax row supplied by a domain host. */
export interface StoredTaxComponent {
  taxComponentId: string;
  name: string;
  percent: string;
  taxable: number;
  tax: number;
}

/**
 * Authoritative document-money snapshot supplied by a domain host. The widget
 * displays these persisted values only: it never derives tax or totals from
 * the visible line page.
 */
export interface StoredLineItemsTotals extends LineItemsTotals {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  lineAmountType: LineAmountType;
  roundingScope: 'line' | 'document';
  /** Whether an inclusive taxed document should expose its net subtotal. */
  showNetSubtotal?: boolean;
  taxes: readonly StoredTaxComponent[];
}

/** A persisted component can occur through more than one tax code. */
export interface StoredTaxComponentGroup extends StoredTaxComponent {}

/** Whether untrusted widget data is a complete persisted money snapshot. */
export function isStoredLineItemsTotals(
  value: unknown,
): value is StoredLineItemsTotals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isLineAmountType(record.lineAmountType) &&
    (record.roundingScope === 'line' || record.roundingScope === 'document') &&
    Number.isSafeInteger(record.subtotal) &&
    Number.isSafeInteger(record.discount) &&
    Number.isSafeInteger(record.tax) &&
    Number.isSafeInteger(record.total) &&
    Array.isArray(record.taxes)
  );
}

/**
 * Group exact persisted rows only when they identify the same component,
 * display name, and percent. Components sharing a display label/rate remain
 * separate; this does not calculate or reallocate tax.
 */
export function groupStoredTaxComponents(
  taxes: readonly StoredTaxComponent[],
): StoredTaxComponentGroup[] {
  const groups = new Map<string, StoredTaxComponentGroup>();
  for (const tax of taxes) {
    if (
      !tax ||
      typeof tax.taxComponentId !== 'string' ||
      typeof tax.name !== 'string' ||
      typeof tax.percent !== 'string' ||
      !Number.isSafeInteger(tax.taxable) ||
      !Number.isSafeInteger(tax.tax)
    )
      continue;
    const key = `${tax.taxComponentId}\u0000${tax.name}\u0000${tax.percent}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...tax });
      continue;
    }
    const taxable = existing.taxable + tax.taxable;
    const amount = existing.tax + tax.tax;
    if (!Number.isSafeInteger(taxable) || !Number.isSafeInteger(amount))
      continue;
    existing.taxable = taxable;
    existing.tax = amount;
  }
  return [...groups.values()];
}

/**
 * A tax component's name with its rate, for a totals line: "GST 5%". A name
 * that already states the rate ("Canada GST 5%", as smrt-commerce's example
 * pack and cookbook activation name theirs) is used as it is, so the rate is
 * not repeated.
 */
export function taxComponentLabel(name: string, percent: string): string {
  const rate = percent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\d.])${rate}\\s?%`).test(name)
    ? name
    : `${name} ${percent}%`;
}

export type LineTotalKey = 'subtotal' | 'discount' | 'tax' | 'total';

export interface LineTotalLine {
  key: LineTotalKey;
  value: number;
  /** Computed here (the record has no such field or value), not read from the record. */
  computed: boolean;
  /** Already inside the subtotal (the discount): shown, not subtracted. */
  included?: boolean;
}

export interface LineTotalsMismatch {
  /** The record figure the lines disagree with. */
  field: 'subtotal' | 'total';
  /** The record's value. */
  recorded: number;
  /** What the lines add up to for that figure. */
  lines: number;
}

export interface LineTotalsResult {
  /** Subtotal, then discount and tax when present and non-zero, then total. */
  lines: LineTotalLine[];
  /** Sum of the line amounts, `null` when not every line is known. */
  lineSum: number | null;
  mismatch: LineTotalsMismatch | null;
}

function money(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

/** Sum of integer minor-unit amounts; `null` on a non-integer or past the safe range. */
export function sumLineAmounts(amounts: readonly unknown[]): number | null {
  let total = 0;
  for (const amount of amounts) {
    if (amount === null || amount === undefined || amount === '') continue;
    const value = money(amount);
    if (value === null) return null;
    total += value;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * The totals block for `record` totals over lines summing to `lineSum`
 * (`null` when the lines are a partial page and the host sent no sum).
 */
export function lineItemTotals(
  record: LineItemsTotals | undefined,
  lineSum: number | null,
): LineTotalsResult {
  const inclusive = record?.lineAmountType === 'inclusive';
  const subtotalRecorded = money(record?.subtotal);
  const discount = money(record?.discount);
  const tax = money(record?.tax);
  const totalRecorded = money(record?.total);
  const lines: LineTotalLine[] = [];
  // Inclusive lines are gross: net = gross - tax. Without the tax there is
  // no net to derive from them.
  const netFromLines =
    lineSum === null
      ? null
      : inclusive
        ? tax === null
          ? null
          : lineSum - tax
        : lineSum;

  const subtotal = subtotalRecorded ?? netFromLines;
  if (subtotal !== null) {
    lines.push({
      key: 'subtotal',
      value: subtotal,
      computed: subtotalRecorded === null,
    });
  }
  if (discount !== null && discount !== 0) {
    lines.push({
      key: 'discount',
      value: discount,
      computed: false,
      included: true,
    });
  }
  if (tax !== null && tax !== 0) {
    lines.push({ key: 'tax', value: tax, computed: false });
  }
  const total =
    totalRecorded ??
    (subtotal === null || tax === null ? null : subtotal + tax);
  if (total !== null) {
    lines.push({
      key: 'total',
      value: total,
      computed: totalRecorded === null,
    });
  }

  let mismatch: LineTotalsMismatch | null = null;
  if (netFromLines !== null) {
    if (subtotalRecorded !== null && subtotalRecorded !== netFromLines) {
      mismatch = {
        field: 'subtotal',
        recorded: subtotalRecorded,
        lines: netFromLines,
      };
    } else if (
      subtotalRecorded === null &&
      totalRecorded !== null &&
      tax !== null
    ) {
      const fromLines = netFromLines + tax;
      if (fromLines !== totalRecorded) {
        mismatch = {
          field: 'total',
          recorded: totalRecorded,
          lines: fromLines,
        };
      }
    }
  }
  return { lines, lineSum, mismatch };
}
