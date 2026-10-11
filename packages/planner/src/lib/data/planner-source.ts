import { catalog } from '../catalog/index.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { catalogModels } from '../forms/shared.ts';
import { PROFILE_TYPE, stockSamples, VARIANT } from '../forms/stock.ts';
import { recipes } from '../recipes/index.ts';
import { childLinks } from '../recipes/plumbing.ts';
import { recipeState } from '../recipes/state.svelte.ts';
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
    samples: stockSamples(catalogModels),
    // Every sample parent comes with line items: the same parent-to-children
    // lookup the record view uses, so what it shows is what was seeded.
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });
}
