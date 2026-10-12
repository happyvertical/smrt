import { catalog } from '../catalog/index.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { catalogModels } from '../forms/shared.ts';
import { PROFILE_TYPE, stockSamples, VARIANT } from '../forms/stock.ts';
import { ASSET, PRODUCT_ASSET } from '../products/media.ts';
import { recipes } from '../recipes/index.ts';
import { childLinks } from '../recipes/plumbing.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { fakeId } from './fakes.ts';
import { createMemoryDataSource, type DataSource } from './source.ts';

/**
 * The planner's sample-data source: seeded in-memory fakes whose added, edited
 * and deleted rows survive a reload (Reset clears them). The seam for live
 * objects: swap this for a collection-backed `DataSource`.
 */
export function createPlannerDataSource(): DataSource {
  return createMemoryDataSource({
    storage: browserStorage(),
    // Fields the views hide still carry their policy default, e.g. the
    // `contractType` that tells an Order from a PurchaseOrder.
    defaults: (model) => recipeState.apply(model).background,
    // Variants only make sense under a product a form creates, so they start
    // empty, as do Profile types: a form adds the one it needs. Locations, SKUs
    // and stock are sampled together (one SKU per product).
    empty: [VARIANT, PROFILE_TYPE],
    samples: {
      ...stockSamples(catalogModels),
      [ASSET]: {
        from: [catalogModels('@happyvertical/smrt-products:Product')],
        make: ([products]) =>
          (products ?? []).map((product, i) => ({
            id: fakeId(`${ASSET}:sample:${product.id}`),
            name: `${String(product.name ?? 'Product')} image`,
            sourceUri: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="hsl(${(i * 47) % 360} 40% 82%)"/><circle cx="120" cy="94" r="46" fill="hsl(${(i * 47 + 30) % 360} 35% 58%)"/><path d="M44 214c20-55 132-55 152 0" fill="hsl(${(i * 47 + 10) % 360} 30% 46%)"/><text x="120" y="224" text-anchor="middle" font-family="sans-serif" font-size="14" fill="white">${String(product.name ?? '').replace(/[<&>]/g, '')}</text></svg>`)}`,
            mimeType: 'image/svg+xml',
            description: `Sample image for ${String(product.name ?? 'this product')}.`,
            sourceType: 'browser-demo',
          })),
      },
      [PRODUCT_ASSET]: {
        from: [
          catalogModels('@happyvertical/smrt-products:Product'),
          catalogModels(ASSET),
        ],
        make: ([products, assets]) =>
          (products ?? []).flatMap((product, i) => {
            const asset = assets?.[i];
            return asset
              ? [
                  {
                    id: fakeId(`${PRODUCT_ASSET}:sample:${product.id}`),
                    productId: product.id,
                    assetId: asset.id,
                    relationship: 'gallery',
                    sortOrder: 0,
                  },
                ]
              : [];
          }),
      },
    },
    // Every sample parent comes with line items: the same parent-to-children
    // lookup the record view uses, so what it shows is what was seeded.
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });
}
