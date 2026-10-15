import type { CatalogModel } from '../catalog/types.ts';
import { isLineModel, lineAmount, settleWithLines } from './derived.ts';
import {
  createRandom,
  fakeId,
  fakeRecord,
  hashString,
  type ModelRecord,
  packLine,
  relatedIndex,
} from './fakes.ts';
import {
  examplePackCodeFor,
  type MoneyContext,
  SEEDED_TAX_CODES,
} from './money.ts';
import { getSamplePack, getSamplePricing } from './packs.ts';

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
 * the same children. A line's money (`amount`, `taxAmount`, its tax code's
 * snapshot) is settled with its document's other lines (`settleSample`).
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
      Object.assign(
        record,
        sampleLineMoney(
          child,
          parent,
          i,
          quantity,
          Number(record.unitPrice ?? 0),
        ),
      );
      record.amount = lineAmount(record);
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
 * Does a sample line carry its own tax code (`taxMode: 'override'`), about one
 * line in seven by its document and position, never a document's first line?
 */
export function overridesTax(parent: { id: string }, index: number): boolean {
  return (
    index > 0 && hashString(`tax-override:${parent.id}:${index}`) % 7 === 0
  );
}

/**
 * The code an overriding sample line chooses, by line: in an app whose
 * currency an example-pack code names, that code half the time (BC GST + PST
 * for CAD, so its components show apart); otherwise exempt or zero-rated.
 */
export function overrideTaxCode(
  parent: { id: string },
  index: number,
  currency = getSamplePricing().currency,
) {
  const draw = hashString(`tax-override-kind:${parent.id}:${index}`) % 4;
  const pack = examplePackCodeFor(currency);
  if (pack && draw < 2) return pack;
  const kind = draw % 2 === 0 ? 'exempt' : 'zero-rated';
  return SEEDED_TAX_CODES.find((c) => c.kind === kind);
}

/**
 * The money inputs of a sample line, for the fields the line has: a
 * discounted document's first line takes a tenth off, as a percentage
 * (`discountType: 'percent'`, `discountRate: '10'`) or a whole-unit amount
 * (`'amount'`, `discount` in minor units), alternating by document; a few
 * lines carry a tax code of their own (`overrideTaxCode`); every other line
 * inherits its code. What the line then comes to is the document's to settle.
 */
function sampleLineMoney(
  child: CatalogModel,
  parent: ModelRecord,
  index: number,
  quantity: number,
  unitPrice: number,
): Record<string, unknown> {
  const money: Record<string, unknown> = {};
  const discount = index === 0 && discounted(parent);
  const percent = hashString(`discount-kind:${parent.id}`) % 2 === 0;
  if (hasField(child, 'discountType')) {
    money.discountType = discount ? (percent ? 'percent' : 'amount') : 'none';
  }
  if (hasField(child, 'discountRate')) {
    money.discountRate = discount && percent ? '10' : null;
  }
  if (hasField(child, 'discount')) {
    money.discount =
      discount && !(percent && hasField(child, 'discountType'))
        ? lineDiscount(quantity, unitPrice)
        : 0;
  }
  // A line with a `discount` but no `discountType` field cannot say which
  // kind it is: an amount is the only one the model can read from it.
  if (!hasField(child, 'discountType') && money.discount) {
    money.discountType = 'amount';
  }
  const override = overridesTax(parent, index)
    ? overrideTaxCode(parent, index)
    : undefined;
  if (hasField(child, 'taxMode')) {
    money.taxMode = override ? 'override' : 'inherit';
  }
  if (hasField(child, 'taxCodeId')) money.taxCodeId = override?.id ?? null;
  return money;
}

/**
 * A sample line once the app's hidden fields' values are applied (`carried`):
 * where the app hides the line's `discount`, an amount discount could not be
 * seen or entered, so the line takes its tenth off as a percentage instead,
 * and where it hides `discountRate` too, the line has no discount.
 */
export function withCarried(
  item: ModelRecord,
  carried: Readonly<Record<string, unknown>>,
): ModelRecord {
  const next = { ...item, ...carried };
  if (
    'discount' in carried &&
    !('discountType' in carried) &&
    next.discountType === 'amount'
  ) {
    next.discountType = 'percent';
    next.discountRate = '10';
    next.discount = 0;
  }
  // Neither kind can be seen: no discount at all.
  if ('discountRate' in carried && next.discountType === 'percent') {
    next.discountType = 'none';
    next.discountRate = null;
    next.discount = 0;
  }
  return next;
}

/**
 * The sample documents whose stored totals deliberately disagree with their
 * lines, so the record page's mismatch flag has something to show: the third
 * Order and the third Invoice (row index 2), drafts whose subtotal and total
 * were left stale by an edit made elsewhere. Only a draft's totals are read
 * against its lines (an issued document shows its frozen figures as they
 * are), so these two are drafts. Their own fields stay authoritative; the
 * page only flags the difference. Editing a line recomputes the totals and
 * clears it.
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
  if (
    parentModel.fields.some(
      (f) => f.name === 'status' && f.enum?.includes('draft'),
    )
  ) {
    parent.status = 'draft';
  }
  // Stale but self-consistent: subtotal and total moved together.
  parent.subtotal += MISMATCH_AMOUNT;
  parent.totalAmount += MISMATCH_AMOUNT;
}

/**
 * Settle the line items just generated for a parent with it (see
 * `settleWithLines`): the parent's totals are set in place and the settled
 * lines returned.
 */
export function settleSample(
  parent: ModelRecord,
  parentModel: CatalogModel,
  items: readonly ModelRecord[],
  context: MoneyContext,
): ModelRecord[] {
  if (!items.length || !items.every((r) => 'unitPrice' in r)) {
    return [...items];
  }
  const settled = settleWithLines(parentModel, parent, items, context);
  Object.assign(parent, settled.row);
  return settled.lines as ModelRecord[];
}
