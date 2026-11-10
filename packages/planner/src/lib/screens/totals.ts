/**
 * A document's totals for the record page's `line-items` widget, on
 * smrt-commerce's money model.
 *
 * - An issued document (it has left `draft`) is frozen: `storedDocumentTotals`
 *   hands the widget its stored figures as smrt-svelte's
 *   `StoredLineItemsTotals` (subtotal, the informational discount, tax,
 *   total, pricing mode, rounding scope and one row per tax component, e.g.
 *   GST and PST apart), which it shows without recalculating.
 * - A draft computes live: `documentTotals` is the record's own subtotal /
 *   tax / total by the framework's field roles, which the widget compares with
 *   its lines and flags when they disagree.
 */
import type { LineItemsTotals } from '@happyvertical/smrt-svelte/overview';
import {
  deriveFieldRoles,
  type RecordScreenProps,
  recordTotals,
} from '@happyvertical/smrt-svelte/screens';
import type { CatalogModel } from '../catalog/types.ts';
import {
  documentLineAmountType,
  documentRoundingScope,
} from '../data/derived.ts';
import { storedTaxRows } from '../data/money.ts';
import { screenDefinition } from './definition.ts';

type Row = Readonly<Record<string, unknown>>;

/**
 * smrt-svelte's `StoredLineItemsTotals`, which its entry points do not export
 * by name (smrt#4023); it is what `RecordScreen.lineItemStoredTotals` returns.
 */
export type StoredLineItemsTotals = NonNullable<
  ReturnType<NonNullable<RecordScreenProps['lineItemStoredTotals']>>
>;

const minor = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

const hasField = (model: CatalogModel, name: string) =>
  model.fields.some((f) => f.name === name);

/**
 * The live totals of a draft by role (plus its `lineAmountType`); `undefined`
 * when it has none of them. The informational `discountTotal` is passed like
 * the rest: the widget shows it as included and never subtracts it (smrt#4014).
 */
export function documentTotals(
  model: CatalogModel,
  record: Row,
): LineItemsTotals | undefined {
  const roles = deriveFieldRoles(screenDefinition(model));
  const totals = recordTotals(record, roles);
  return Object.values(totals).some((v) => minor(v) !== null)
    ? totals
    : undefined;
}

/** Has the document left `draft`, freezing its money? */
export function isIssued(model: CatalogModel, record: Row): boolean {
  const status = model.fields.find((f) => f.name === 'status');
  return (
    Boolean(status?.enum?.includes('draft')) &&
    typeof record.status === 'string' &&
    record.status !== '' &&
    record.status !== 'draft'
  );
}

/**
 * An issued document's frozen money as the widget's stored totals: its own
 * header figures and its lines' stored tax snapshots summed per component.
 * `undefined` for a draft or a model without the money model's header.
 */
export function storedDocumentTotals(
  model: CatalogModel,
  record: Row,
  lines: readonly Row[],
): StoredLineItemsTotals | undefined {
  if (!isIssued(model, record)) return undefined;
  if (
    !['subtotal', 'taxAmount', 'totalAmount', 'discountTotal'].every((n) =>
      hasField(model, n),
    )
  ) {
    return undefined;
  }
  const subtotal = minor(record.subtotal);
  const tax = minor(record.taxAmount);
  const total = minor(record.totalAmount);
  const discount = minor(record.discountTotal) ?? 0;
  if (subtotal === null || tax === null || total === null) return undefined;
  const lineAmountType = documentLineAmountType(record, 'exclusive');
  return {
    subtotal,
    discount,
    tax,
    total,
    lineAmountType,
    roundingScope: documentRoundingScope(record, 'line'),
    showNetSubtotal: lineAmountType === 'inclusive',
    taxes: storedTaxRows(lines, lineAmountType).flatMap((row) =>
      row.taxComponentId
        ? [
            {
              taxComponentId: row.taxComponentId,
              name: row.name,
              percent: row.percent,
              taxable: row.taxable,
              tax: row.tax,
            },
          ]
        : [],
    ),
  };
}
