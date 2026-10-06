import type { ModelRecord, RecordWrite } from '../data/source.ts';
import type { ModelLookup } from './shared.ts';

export const PRODUCT = '@happyvertical/smrt-products:Product';
export const VARIANT = '@happyvertical/smrt-products:ProductVariant';
export const SKU = '@happyvertical/smrt-products:Sku';
export const STOCK_LEVEL = '@happyvertical/smrt-inventory:StockLevel';
export const LOCATION = '@happyvertical/smrt-inventory:InventoryLocation';

/**
 * Models the product forms write as children of a product. The demo data
 * source starts them empty, so no sample row points at a product that is not
 * there.
 */
export const SAVED_BY_FORMS = [VARIANT, SKU, STOCK_LEVEL, LOCATION];

/**
 * Units on hand per product: each product's Skus' stock levels summed. A
 * product with no stock row has no entry, so the list can show a dash.
 */
export function stockByProduct(
  skus: readonly ModelRecord[],
  levels: readonly ModelRecord[],
): Map<string, number> {
  const productOf = new Map(skus.map((sku) => [sku.id, sku.productId]));
  const totals = new Map<string, number>();
  for (const level of levels) {
    const productId = productOf.get(String(level.skuId));
    if (typeof productId !== 'string') continue;
    totals.set(
      productId,
      (totals.get(productId) ?? 0) + Number(level.qty ?? 0),
    );
  }
  return totals;
}

/** Deletes for a product and everything the forms saved under it. */
export function planProductDelete(
  productId: string,
  skus: readonly ModelRecord[],
  models: ModelLookup,
): RecordWrite[] {
  return [
    ...skus.flatMap((sku): RecordWrite[] => [
      { op: 'delete', model: models(STOCK_LEVEL), match: { skuId: sku.id } },
      { op: 'delete', model: models(SKU), id: sku.id },
    ]),
    { op: 'delete', model: models(VARIANT), match: { productId } },
    { op: 'delete', model: models(PRODUCT), id: productId },
  ];
}
