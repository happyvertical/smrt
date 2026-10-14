/**
 * A document's totals as the record page's `line-items` widget reads them
 * (smrt-svelte `LineItemsTotals`): the record's own subtotal / discount /
 * tax / total fields, found by the framework's field roles. The record's
 * figures are authoritative; the widget computes a missing one from the
 * lines and flags a disagreement. A document with no discount field (an
 * Order, an Invoice) shows its lines' discounts, so a discounted line still
 * reads in the totals block.
 */
import type { LineItemsTotals } from '@happyvertical/smrt-svelte/overview';
import {
  deriveFieldRoles,
  fieldWithRole,
  recordTotals,
} from '@happyvertical/smrt-svelte/screens';
import type { CatalogModel } from '../catalog/types.ts';
import { lineAmounts } from '../data/derived.ts';
import { screenDefinition } from './definition.ts';

type Row = Readonly<Record<string, unknown>>;

const minor = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** The record's totals by role; `undefined` when it has none of them. */
export function documentTotals(
  model: CatalogModel,
  record: Row,
  lines: readonly Row[],
): LineItemsTotals | undefined {
  const roles = deriveFieldRoles(screenDefinition(model));
  const totals: LineItemsTotals = { ...recordTotals(record, roles) };
  if (!fieldWithRole(roles, 'discount')) {
    const lineDiscount = lines.reduce(
      (total, line) => total + lineAmounts(line).discount,
      0,
    );
    if (lineDiscount > 0) totals.discount = lineDiscount;
  }
  return Object.values(totals).some((v) => minor(v) !== null)
    ? totals
    : undefined;
}
