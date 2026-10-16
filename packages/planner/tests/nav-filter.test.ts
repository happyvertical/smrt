import { afterEach, describe, expect, it } from 'vitest';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { setSamplePack } from '../src/lib/data/packs.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { activeForms, isFieldMap } from '../src/lib/forms/active.ts';
import { blankFieldMap, planFieldMapSave } from '../src/lib/forms/fieldMap.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import { PRODUCT, stockSamples } from '../src/lib/forms/stock.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { cookbookNavGroups } from '../src/lib/library/menu.ts';
import {
  navPath,
  recipeNav,
  recipes,
  recipesById,
} from '../src/lib/recipes/index.ts';
import {
  inScope,
  pageScope,
  type RowScope,
  scopePreset,
} from '../src/lib/recipes/scope.ts';

const entriesOf = (ids: string[]) =>
  ids.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? recipeNav(recipe) : [];
  });
const PRODUCT_ID = PRODUCT;

afterEach(() => setSamplePack(null));

describe('filtered nav entries', () => {
  it('the Ingredients entry is keyed and filters Products by kind', () => {
    const [entry] = entriesOf(['products.ingredients']);
    expect(entry?.key).toBe('ingredients');
    expect(entry?.filter).toEqual({ field: 'productType', value: 'material' });
    expect(entry && navPath(entry)).toBe('/m/products/Product/ingredients/');
    const [plain] = entriesOf(['products.simple']);
    expect(plain && navPath(plain)).toBe('/m/products/Product/');
  });

  it('every filter names a field the model has and a key', () => {
    for (const recipe of recipes) {
      for (const e of recipeNav(recipe)) {
        if (!e.filter) continue;
        expect(e.key, `${recipe.id} filter needs a key`).toBeTruthy();
        expect(
          e.model.fields.some((f) => f.name === e.filter?.field),
          `${recipe.id} ${e.filter.field}`,
        ).toBe(true);
      }
    }
  });

  it('scopes the keyed page to its rows and the plain page to the rest', () => {
    const added = entriesOf(['products.simple', 'products.ingredients']);
    const only = pageScope(PRODUCT_ID, 'ingredients', added);
    const rest = pageScope(PRODUCT_ID, undefined, added);
    expect(only).toEqual({ field: 'productType', equals: 'material' });
    expect(rest).toEqual({ field: 'productType', notIn: ['material'] });
    const flour = { productType: 'material' };
    const bread = { productType: 'product' };
    expect(inScope(only, flour)).toBe(true);
    expect(inScope(only, bread)).toBe(false);
    expect(inScope(rest, flour)).toBe(false);
    expect(inScope(rest, bread)).toBe(true);
    expect(scopePreset(only)).toEqual({ productType: 'material' });
    expect(scopePreset(rest)).toEqual({});
    // Without the Ingredients recipe the plain page lists everything.
    expect(
      pageScope(PRODUCT_ID, undefined, entriesOf(['products.simple'])),
    ).toBe(undefined);
    expect(inScope(undefined, flour)).toBe(true);
  });

  it('a new row from the Ingredients page is stamped as material', async () => {
    const ids = ['products.simple', 'products.ingredients'];
    const active = activeForms(ids, recipes, PRODUCT_ID).find(isFieldMap);
    if (!active) throw new Error('no form');
    const scope: RowScope = { field: 'productType', equals: 'material' };
    const source = createMemoryDataSource({ empty: [PRODUCT_ID] });
    const writes = planFieldMapSave(
      active,
      catalogModels,
      { ...blankFieldMap(active, catalogModels), name: 'Rye flour' },
      undefined,
      {},
      scopePreset(scope),
    );
    const written = await source.apply(writes);
    expect(written.product?.productType).toBe('material');
    // Editing an existing row never re-stamps it.
    const edit = planFieldMapSave(
      active,
      catalogModels,
      { ...blankFieldMap(active, catalogModels), name: 'Rye flour 2' },
      String(written.product?.id),
      { product: written.product },
      { productType: 'product' },
    );
    const edited = await source.apply(edit);
    expect(edited.product?.productType).toBe('material');
  });
});

describe('bakery ingredients', () => {
  const bakery = getLibraryCookbook('bakery');
  if (!bakery) throw new Error('bakery');

  it('sits in the Kitchen next to Products and Stock', () => {
    const kitchen = cookbookNavGroups(bakery.document).find(
      (g) => g.id === 'section:catalog',
    );
    // Nav ids are unique: the keyed entry is its own item.
    const ids = cookbookNavGroups(bakery.document).flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('item:products:Product');
    expect(ids).toContain('item:products:Product:ingredients');
    expect(kitchen).toBeDefined();
  });

  it('splits the bakery’s products from its ingredients', async () => {
    applyLibraryCookbook(bakery, new CookbookStore());
    const source = createMemoryDataSource({
      samples: stockSamples(catalogModels),
      empty: [
        '@happyvertical/smrt-products:ProductVariant',
        '@happyvertical/smrt-profiles:ProfileType',
      ],
    });
    const rows = await source.list(catalogModels(PRODUCT_ID));
    const added = entriesOf(bakery.document.recipes);
    const ingredients = rows.filter((r) =>
      inScope(pageScope(PRODUCT_ID, 'ingredients', added), r),
    );
    const sellable = rows.filter((r) =>
      inScope(pageScope(PRODUCT_ID, undefined, added), r),
    );
    expect(ingredients.map((r) => r.name)).toContain('Bread flour, 25 kg');
    expect(sellable.map((r) => r.name)).toContain('Sourdough loaf');
    expect(ingredients.length + sellable.length).toBe(rows.length);
    expect(ingredients.every((r) => r.category === 'Ingredient')).toBe(true);
  });
});
