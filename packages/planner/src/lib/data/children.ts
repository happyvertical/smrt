import type { CatalogModel } from '../catalog/types.ts';
import { isLineModel, settleLine, withTotals } from './derived.ts';
import {
  createRandom,
  fakeId,
  fakeRecord,
  hashString,
  type ModelRecord,
  packLine,
  relatedIndex,
} from './fakes.ts';
import { getSamplePack } from './packs.ts';

/** A child model and the field holding its parent's id (see `childLinks`). */
export interface ChildOf {
  model: CatalogModel;
  fk: string;
}

const MAX_CHILDREN = 4;

const hasField = (model: CatalogModel, name: string) =>
  model.fields.some((f) => f.name === name);

/**
 * Sample child rows for one parent record: one to four (journals, an even
 * number of balanced entries), each pointing at the parent through `fk`. Ids
 * and values are seeded from the parent's id, so the same parent always gets
 * the same children. A line item's `amount` is tax-inclusive, `quantity *
 * unitPrice - discount + tax` (`lineAmounts`), so the lines add up to the
 * parent's total.
 */
export function fakeChildrenOf(
  child: CatalogModel,
  fk: string,
  parent: ModelRecord,
  seed: number,
  rows?: number,
): ModelRecord[] {
  const random = createRandom(hashString(`${seed}:${child.id}:${parent.id}`));
  const ledger = hasField(child, 'debit') && hasField(child, 'credit');
  const count = ledger
    ? 2 * (1 + Math.floor(random() * 2))
    : 1 + Math.floor(random() * MAX_CHILDREN);
  const lines = isLineModel(child);
  const balance = 1000 * (1 + Math.floor(random() * 90));
  return Array.from({ length: count }, (_, i) => {
    const index = hashString(`${parent.id}:${i}`) % 997;
    const record: ModelRecord = {
      ...fakeRecord(child, index, seed, rows),
      id: fakeId(`${child.id}:${parent.id}:${i}`),
      [fk]: parent.id,
    };
    if (hasField(child, 'sortOrder')) record.sortOrder = i;
    if (lines) {
      // A line pointing at a product reads as that product, at its price.
      const productField = child.fields.find(
        (f) => f.related?.endsWith(':Product') && f.name in record,
      );
      const pack = getSamplePack();
      const { products } = pack;
      // The same row the line's `productId` was pointed at (`relatedIndex`).
      const item = productField
        ? products[
            relatedIndex(productField, { modelId: child.id, index, rows }) %
              products.length
          ]
        : products[index % products.length];
      const described = packLine(index);
      if (described) {
        // Labour and fabrication are not products: no product to point at.
        if (hasField(child, 'description')) {
          record.description = described.description;
        }
        record.unitPrice = described.price;
        if (productField) record[productField.name] = '';
      } else if (productField && item) {
        if (hasField(child, 'description')) record.description = item.name;
        record.unitPrice = item.price;
      }
      // How many a line sells is the pack's call: one membership, a few hours
      // of labour, a handful of parts. The draw is always taken so a pack
      // without ranges leaves the rest of the stream as it was.
      const [low, high] = described?.quantity ??
        item?.quantity ??
        pack.lineQuantity ?? [1, 5];
      const quantity = low + Math.floor(random() * (high - low + 1));
      if (hasField(child, 'quantity')) record.quantity = quantity;
      if (hasField(child, 'discount')) {
        record.discount =
          i === 0 && discounted(parent)
            ? lineDiscount(quantity, Number(record.unitPrice ?? 0))
            : 0;
      }
      record.amount = settleLine(record).amount;
    }
    if (ledger) {
      const debit = i % 2 === 0;
      record.debit = debit ? balance / 100 : 0;
      record.credit = debit ? 0 : balance / 100;
    }
    return record;
  });
}

/** Does a sample document give a discount (about one in three, by its id)? */
export function discounted(parent: { id: string }): boolean {
  return hashString(`discount:${parent.id}`) % 3 === 0;
}

/** A tenth off the line's price, in whole currency units. */
function lineDiscount(quantity: number, unitPrice: number): number {
  return Math.round((quantity * unitPrice) / 1000) * 100;
}

/**
 * The sample documents whose stored totals deliberately disagree with their
 * lines, so the record page's mismatch flag has something to show: the third
 * Order and the third Invoice (row index 2), whose subtotal and total were
 * left stale by an edit made elsewhere. Their own fields stay authoritative; the page only
 * flags the difference. Editing a line recomputes the totals and clears it.
 */
export const MISMATCH_MODELS: readonly string[] = [
  '@happyvertical/smrt-commerce:Order',
  '@happyvertical/smrt-commerce:Invoice',
];
export const MISMATCH_ROW = 2;
/** What the stale total is off by, in minor units. */
export const MISMATCH_AMOUNT = 2500;

/** Leave one document's total stale (see {@link MISMATCH_MODELS}). */
export function seedMismatch(
  parent: ModelRecord,
  parentModel: CatalogModel,
  index: number,
): void {
  if (
    index !== MISMATCH_ROW ||
    !MISMATCH_MODELS.includes(parentModel.id) ||
    typeof parent.subtotal !== 'number' ||
    typeof parent.totalAmount !== 'number'
  ) {
    return;
  }
  // Stale but self-consistent: subtotal and total moved together.
  parent.subtotal += MISMATCH_AMOUNT;
  parent.totalAmount += MISMATCH_AMOUNT;
}

/**
 * Bring a parent's totals in line with the line items just generated for it
 * (see `withTotals`).
 */
export function syncTotals(
  parent: ModelRecord,
  parentModel: CatalogModel,
  items: readonly ModelRecord[],
): void {
  if (!items.length || !items.every((r) => 'unitPrice' in r)) return;
  Object.assign(parent, withTotals(parentModel, parent, items));
}
