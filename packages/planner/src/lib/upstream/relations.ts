/**
 * Relations the manifest does not declare yet. Some models name a related row
 * in a plain `text` field (inventory's `StockLevel.skuId`, products' `Sku`
 * `productId`) with no `@foreignKey`, so the catalog types them `text` and a
 * form would show an id box. That is a gap in those packages, not a planner
 * concern: the fix is `@foreignKey(Target)` on the field upstream. Until then
 * `overlay.ts` types these as `foreignKey` so they get a selector.
 */
const INVENTORY = '@happyvertical/smrt-inventory';
const PRODUCTS = '@happyvertical/smrt-products';

/** Target model by qualified model name, then field name. */
export const UNDECLARED_RELATIONS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [`${INVENTORY}:StockLevel`]: {
    skuId: `${PRODUCTS}:Sku`,
    locationId: `${INVENTORY}:InventoryLocation`,
  },
  [`${PRODUCTS}:Sku`]: {
    productId: `${PRODUCTS}:Product`,
    parentSkuId: `${PRODUCTS}:Sku`,
  },
  [`${PRODUCTS}:ProductVariant`]: {
    productId: `${PRODUCTS}:Product`,
  },
};
