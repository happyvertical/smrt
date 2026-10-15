import { catalog } from '../catalog/index.ts';
import { browserStorage, STORAGE_KEY } from '../cookbook/storage.ts';
import { followSettings } from '../cookbook/store.svelte.ts';
import { parseCookbookText } from '../cookbook/validate.ts';
import { catalogModels } from '../forms/shared.ts';
import { PROFILE_TYPE, stockSamples, VARIANT } from '../forms/stock.ts';
import { ASSET, PRODUCT_ASSET } from '../products/media.ts';
import { recipes } from '../recipes/index.ts';
import { childLinks } from '../recipes/plumbing.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { DEFAULT_SAMPLE_TAX_RATE, fakeId } from './fakes.ts';
import {
  defaultTaxCode,
  sampleTaxCodes,
  sampleTaxComponents,
} from './money.ts';
import { getSamplePricing, getSampleTaxRate } from './packs.ts';
import { createMemoryDataSource, type DataSource } from './source.ts';

const C = '@happyvertical/smrt-commerce:';
const TAX_CODE = `${C}TaxCode`;
const TAX_COMPONENT = `${C}TaxComponent`;
const TAX_SETTINGS = `${C}TaxSettings`;
const DOCUMENT_TAX = `${C}DocumentTax`;
const MONEY_MIGRATION = `${C}MoneyMigrationDocument`;

/** The sample tenant's tax codes for the app's current settings. */
function currentTaxCodes() {
  const rate = getSampleTaxRate() ?? DEFAULT_SAMPLE_TAX_RATE;
  return { codes: sampleTaxCodes(rate), fallback: defaultTaxCode(rate) };
}

/**
 * A page opened straight at a record reads sample rows before the layout
 * hydrates the saved cookbook (its `afterNavigate`), so the rows would be
 * priced by defaults rather than the app's money settings. Read the saved
 * cookbook's settings first; only reads, the store's hydrate does the rest.
 */
function primeSampleSettings(storage: Storage | null): void {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = parseCookbookText(raw, { dropUnknownRecipes: true });
    if (parsed.ok) followSettings(parsed.cookbook);
  } catch {
    // Unreadable or unavailable: the store's hydrate reports it.
  }
}

/**
 * The planner's sample-data source: seeded in-memory fakes whose added, edited
 * and deleted rows survive a reload (Reset clears them). The seam for live
 * objects: swap this for a collection-backed `DataSource`.
 */
export function createPlannerDataSource(): DataSource {
  primeSampleSettings(browserStorage());
  return createMemoryDataSource({
    storage: browserStorage(),
    // Fields the views hide still carry their policy default, e.g. the
    // `contractType` that tells an Order from a PurchaseOrder.
    defaults: (model) => recipeState.apply(model).background,
    // Variants only make sense under a product a form creates, so they start
    // empty, as do Profile types: a form adds the one it needs. Locations, SKUs
    // and stock are sampled together (one SKU per product).
    // A document's tax snapshot is kept on its lines (`taxComponentsJson`),
    // so `DocumentTax` holds no rows of its own; the planner's tenant is on
    // the money model from the start and never migrates.
    empty: [VARIANT, PROFILE_TYPE, DOCUMENT_TAX, MONEY_MIGRATION],
    samples: {
      // The tax codes sample documents resolve against: the seeded ones,
      // the app default and smrt-commerce's example pack (`data/money.ts`).
      [TAX_CODE]: {
        from: [],
        make: () =>
          currentTaxCodes().codes.map((code) => ({
            id: code.id,
            code: code.code,
            name: code.name,
            kind: code.kind,
            appliesTo: code.appliesTo,
            active: code.active,
            componentsJson: JSON.stringify(
              code.components.map((part) => ({
                taxComponentId: part.id,
                compound: false,
              })),
            ),
          })),
      },
      [TAX_COMPONENT]: {
        from: [],
        make: () =>
          sampleTaxComponents(currentTaxCodes().codes).map((part) => ({
            id: part.id,
            name: part.name,
            percent: part.percent,
            liabilityAccountId: null,
            recoverable: part.recoverable,
            active: true,
          })),
      },
      [TAX_SETTINGS]: {
        from: [],
        make: () => {
          const { fallback } = currentTaxCodes();
          const pricing = getSamplePricing();
          return [
            {
              id: fakeId(`${TAX_SETTINGS}:sample`),
              defaultSalesTaxCodeId: fallback.id,
              defaultPurchaseTaxCodeId: fallback.id,
              defaultLineAmountType: pricing.pricesIncludeTax
                ? 'inclusive'
                : 'exclusive',
              taxRoundingScope: pricing.taxRounding,
              moneyModel: 'v2',
            },
          ];
        },
      },
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
