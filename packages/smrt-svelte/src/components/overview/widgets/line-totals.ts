/**
 * The totals block of a document's line items (#3718 record page), pure and
 * Node-tested. The record's own subtotal / discount / tax / total are
 * authoritative and shown as they are; a missing one is computed from the
 * lines (subtotal = sum of line amounts, total = subtotal - discount + tax).
 * When the record's figures disagree with the lines, the block flags it
 * ("Lines add up to $X") instead of silently overriding either side.
 *
 * Money is integer minor units throughout.
 */

/** The record's own totals fields (`subtotal` / `discount` / `tax` / `total` roles). */
export interface LineItemsTotals {
  subtotal?: number | null;
  discount?: number | null;
  tax?: number | null;
  total?: number | null;
}

export type LineTotalKey = 'subtotal' | 'discount' | 'tax' | 'total';

export interface LineTotalLine {
  key: LineTotalKey;
  value: number;
  /** Computed here (the record has no such field or value), not read from the record. */
  computed: boolean;
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
  const subtotalRecorded = money(record?.subtotal);
  const discount = money(record?.discount);
  const tax = money(record?.tax);
  const totalRecorded = money(record?.total);
  const lines: LineTotalLine[] = [];

  const subtotal = subtotalRecorded ?? lineSum;
  if (subtotal !== null) {
    lines.push({
      key: 'subtotal',
      value: subtotal,
      computed: subtotalRecorded === null,
    });
  }
  if (discount !== null && discount !== 0) {
    lines.push({ key: 'discount', value: discount, computed: false });
  }
  if (tax !== null && tax !== 0) {
    lines.push({ key: 'tax', value: tax, computed: false });
  }
  const computedTotal =
    subtotal === null ? null : subtotal - (discount ?? 0) + (tax ?? 0);
  const total = totalRecorded ?? computedTotal;
  if (total !== null) {
    lines.push({
      key: 'total',
      value: total,
      computed: totalRecorded === null,
    });
  }

  let mismatch: LineTotalsMismatch | null = null;
  if (lineSum !== null) {
    if (subtotalRecorded !== null && subtotalRecorded !== lineSum) {
      mismatch = {
        field: 'subtotal',
        recorded: subtotalRecorded,
        lines: lineSum,
      };
    } else if (subtotalRecorded === null && totalRecorded !== null) {
      const fromLines = lineSum - (discount ?? 0) + (tax ?? 0);
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
