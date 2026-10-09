import { fakeId, hashString } from '../data/fakes.ts';
import { getSamplePack } from '../data/packs.ts';
import type {
  MemoryDataSourceOptions,
  ModelRecord,
  RecordWrite,
} from '../data/source.ts';
import type { ModelLookup } from './shared.ts';

export const PRODUCT = '@happyvertical/smrt-products:Product';
export const VARIANT = '@happyvertical/smrt-products:ProductVariant';
export const SKU = '@happyvertical/smrt-products:Sku';
export const STOCK_LEVEL = '@happyvertical/smrt-inventory:StockLevel';
export const PROFILE_TYPE = '@happyvertical/smrt-profiles:ProfileType';
export const LOCATION = '@happyvertical/smrt-inventory:InventoryLocation';

/**
 * Models the product forms write as children of a product. The demo data
 * source starts them empty, so no sample row points at a product that is not
 * there.
 */
export const SAVED_BY_FORMS = [VARIANT, SKU, STOCK_LEVEL, LOCATION];

/**
 * Sample locations (the active pack's), one SKU per sample product and a stock level for each SKU
 * at the main location and (for about two in three) at the second, with a
 * reorder point. The rows point at one another, so they are built together;
 * a form still adds its own on top. Variants stay empty.
 */
export function stockSamples(
  models: ModelLookup,
): NonNullable<MemoryDataSourceOptions['samples']> {
  return {
    [LOCATION]: {
      from: [],
      make: () =>
        (getSamplePack().locations ?? []).map((l, i) => ({
          id: fakeId(`${LOCATION}:sample:${i}`),
          ...l,
          placeId: '',
          active: true,
        })),
    },
    [SKU]: {
      from: [models(PRODUCT)],
      make: ([products]) =>
        (products ?? []).map((p, i) => ({
          id: fakeId(`${SKU}:sample:${p.id}`),
          productId: p.id,
          code: `SKU-${String(i + 1).padStart(3, '0')}`,
          barcode: '',
          name: String(p.name ?? ''),
          attributes: '',
          parentSkuId: '',
          active: true,
        })),
    },
    [STOCK_LEVEL]: {
      from: [models(SKU), models(LOCATION)],
      make: ([skus, locations]) => {
        const pack = getSamplePack();
        const placed = new Map(pack.products.map((p) => [p.name, p.at]));
        return (skus ?? []).flatMap((sku) =>
          (locations ?? []).flatMap((location, j) => {
            const h = hashString(`${sku.id}:${location.id}`);
            // A pack may say where a product is counted; otherwise it is
            // at the first location and, for two in three, the second.
            const home = placed.get(String(sku.name));
            if (home !== undefined) {
              if (home !== j) return [];
            } else if (j > 0 && h % 3 === 0) return [];
            const reorderPoint = 10 + (h % 4) * 5;
            return [
              {
                id: fakeId(`${STOCK_LEVEL}:sample:${sku.id}:${location.id}`),
                skuId: sku.id,
                locationId: location.id,
                state: 'available',
                // Some rows sit at or under the reorder point.
                qty: h % 5 === 0 ? reorderPoint - 3 : reorderPoint + (h % 40),
                reorderPoint,
                reorderQuantity: reorderPoint * 3,
              },
            ];
          }),
        );
      },
    },
  };
}

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
