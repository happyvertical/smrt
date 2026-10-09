import type { CatalogModel } from '../catalog/types.ts';
import { isLineModel, settleLine, withTotals } from './derived.ts';
import {
  createRandom,
  fakeId,
  fakeRecord,
  hashString,
  type ModelRecord,
  packLine,
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
 * the same children. A line item's `amount` is `quantity * unitPrice` so it
 * reads right next to the parent's totals.
 */
export function fakeChildrenOf(
  child: CatalogModel,
  fk: string,
  parent: ModelRecord,
  seed: number,
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
      ...fakeRecord(child, index, seed),
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
      const item = products[(index % 5) % products.length];
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
      if (hasField(child, 'discount')) record.discount = 0;
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
