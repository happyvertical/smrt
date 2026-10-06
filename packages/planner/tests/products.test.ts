import { beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryDataSource,
  type DataSource,
} from '../src/lib/data/source.ts';
import {
  activeForms,
  isFieldMap,
  isVariantGrid,
} from '../src/lib/forms/active.ts';
import {
  blankFieldMap,
  loadFieldMap,
  planFieldMapSave,
} from '../src/lib/forms/fieldMap.ts';
import { catalogModels, fillTemplate, slug } from '../src/lib/forms/shared.ts';
import {
  PRODUCT,
  planProductDelete,
  SAVED_BY_FORMS,
  SKU,
  STOCK_LEVEL,
  stockByProduct,
  VARIANT,
} from '../src/lib/forms/stock.ts';
import {
  blankGrid,
  combinations,
  gridCombos,
  loadGrid,
  planGridSave,
  skuCode,
} from '../src/lib/forms/variantGrid.ts';
import {
  buildCards,
  cardIsOn,
  mainSwitchChange,
  subSwitchChange,
} from '../src/lib/recipes/cards.ts';
import { recipes, recipesById } from '../src/lib/recipes/index.ts';
import {
  recipesRequiring,
  removalBlockers,
  withRequirements,
} from '../src/lib/recipes/resolve.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import type {
  FieldMapForm,
  VariantGridForm,
} from '../src/lib/recipes/types.ts';

const product = catalogModels(PRODUCT);
const sku = catalogModels(SKU);
const variant = catalogModels(VARIANT);
const level = catalogModels(STOCK_LEVEL);

const source = (): DataSource =>
  createMemoryDataSource({ empty: SAVED_BY_FORMS });

function simple(ids: string[]) {
  const found = activeForms(ids, recipes, PRODUCT).find(isFieldMap);
  if (!found) throw new Error('no simple form');
  return found as ReturnType<typeof activeForms>[number] & {
    form: FieldMapForm;
  };
}
function grid(ids: string[]) {
  const found = activeForms(ids, recipes, PRODUCT).find(isVariantGrid);
  if (!found) throw new Error('no grid form');
  return found as ReturnType<typeof activeForms>[number] & {
    form: VariantGridForm;
  };
}

describe('Planner cards and sub-switches', () => {
  const cards = buildCards(recipes);
  const products = cards.find((c) => c.id === 'products');
  const inventory = cards.find((c) => c.id === 'inventory.stock');

  beforeEach(() => recipeState.clear());

  it('groups Simple and Clothing on one Products card, Inventory on its own', () => {
    expect(products?.label).toBe('Products');
    expect(products?.recipes.map((r) => r.id)).toEqual([
      'products.simple',
      'products.clothing',
    ]);
    expect(products?.hasSubSwitches).toBe(true);
    expect(inventory?.hasSubSwitches).toBe(false);
    expect(cards.map((c) => c.label)).toEqual(
      [...cards.map((c) => c.label)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('turning the main switch on enables the first sub-recipe only', () => {
    if (!products) throw new Error('no products card');
    expect(mainSwitchChange(products, [], true)).toEqual({
      add: ['products.simple'],
      remove: [],
    });
    // Already on: nothing more to add.
    expect(mainSwitchChange(products, ['products.clothing'], true).add).toEqual(
      [],
    );
  });

  it('turning it off disables every sub-recipe', () => {
    if (!products) throw new Error('no products card');
    recipeState.add('products.simple', 'products.clothing');
    const change = mainSwitchChange(products, recipeState.ids, false);
    recipeState.remove(...change.remove);
    expect(recipeState.ids).toEqual([]);
  });

  it('turning off the last sub-switch turns the main switch off', () => {
    if (!products) throw new Error('no products card');
    recipeState.add('products.simple', 'products.clothing');
    recipeState.remove(...subSwitchChange('products.simple', false).remove);
    expect(cardIsOn(products, recipeState.ids)).toBe(true);
    recipeState.remove(...subSwitchChange('products.clothing', false).remove);
    expect(cardIsOn(products, recipeState.ids)).toBe(false);
  });

  it('turning a sub-switch on turns the main switch on', () => {
    if (!products) throw new Error('no products card');
    recipeState.add(...subSwitchChange('products.clothing', true).add);
    expect(cardIsOn(products, recipeState.ids)).toBe(true);
  });

  it('Inventory pulls in a product recipe and pins the last one', () => {
    recipeState.add('inventory.stock');
    expect(recipeState.ids).toEqual(['inventory.stock', 'products.simple']);
    // The only product recipe cannot go while Inventory is on.
    recipeState.remove('products.simple');
    expect(recipeState.ids).toContain('products.simple');
    expect(recipeState.requiredBy('products.simple')).toEqual([
      'inventory.stock',
    ]);
    // With a second one on, either can be removed.
    recipeState.add('products.clothing');
    expect(recipeState.requiredBy('products.simple')).toEqual([]);
    recipeState.remove('products.simple');
    expect(recipeState.ids).toEqual(['inventory.stock', 'products.clothing']);
    // The whole card cannot be switched off while Inventory needs it.
    if (!products) throw new Error('no products card');
    expect(
      removalBlockers(
        products.recipes.map((r) => r.id),
        recipeState.ids,
        recipesById,
      ),
    ).toEqual(['inventory.stock']);
  });

  it('requiresAny keeps an existing alternative instead of adding the first', () => {
    expect(
      withRequirements(['inventory.stock', 'products.clothing'], recipesById),
    ).toEqual(['inventory.stock', 'products.clothing']);
    expect(
      recipesRequiring(
        'products.clothing',
        ['inventory.stock', 'products.clothing'],
        recipesById,
      ),
    ).toEqual(['inventory.stock']);
  });

  it('Inventory comes off freely and drops the quantity extension', () => {
    recipeState.add('inventory.stock');
    recipeState.remove('inventory.stock');
    expect(recipeState.ids).toEqual(['products.simple']);
  });
});

describe('the in-memory DataSource: related multi-model saves', () => {
  it('creates, finds-or-creates and updates in one apply, resolving refs', async () => {
    const s = source();
    const first = await s.apply([
      {
        op: 'save',
        as: 'p',
        model: product,
        values: { name: 'Mug', price: 1200 },
      },
      {
        op: 'save',
        as: 'sku',
        model: sku,
        match: { productId: { ref: 'p' } },
        onCreate: { code: 'MUG' },
        values: { name: 'Mug' },
      },
    ]);
    expect(first.sku?.productId).toBe(first.p?.id);
    expect(first.sku?.code).toBe('MUG');

    const again = await s.apply([
      {
        op: 'save',
        as: 'p',
        model: product,
        id: first.p?.id,
        values: { price: 1500 },
      },
      {
        op: 'save',
        as: 'sku',
        model: sku,
        match: { productId: { ref: 'p' } },
        onCreate: { code: 'OTHER' },
        values: { name: 'Mug v2' },
      },
    ]);
    expect(again.p?.price).toBe(1500);
    expect(again.sku?.id).toBe(first.sku?.id);
    expect(again.sku?.code).toBe('MUG');
    expect(await s.list(sku)).toHaveLength(1);
  });

  it('keeps nothing when a later step fails', async () => {
    const s = source();
    const before = (await s.list(product)).length;
    await expect(
      s.apply([
        { op: 'save', as: 'p', model: product, values: { name: 'Doomed' } },
        { op: 'save', model: sku, values: { productId: { ref: 'missing' } } },
      ]),
    ).rejects.toThrow('Unknown record reference missing');
    expect(await s.list(product)).toHaveLength(before);
    await expect(
      s.apply([
        { op: 'save', model: product, values: { name: 'Doomed' } },
        { op: 'save', model: product, id: 'nope', values: {} },
      ]),
    ).rejects.toThrow('No Product with id nope');
    expect(await s.list(product)).toHaveLength(before);
  });

  it('deletes by id or by match, and refuses an open delete', async () => {
    const s = source();
    const { p } = await s.apply([
      { op: 'save', as: 'p', model: product, values: { name: 'A' } },
      {
        op: 'save',
        model: variant,
        match: { productId: { ref: 'p' }, axisName: 'size' },
        values: {},
      },
      {
        op: 'save',
        model: variant,
        match: { productId: { ref: 'p' }, axisName: 'color' },
        values: {},
      },
    ]);
    await s.apply([
      { op: 'delete', model: variant, match: { productId: p?.id ?? '' } },
    ]);
    expect(await s.list(variant)).toHaveLength(0);
    await expect(s.apply([{ op: 'delete', model: variant }])).rejects.toThrow(
      'needs an id or a match',
    );
  });
});

describe('template helpers', () => {
  it('slugs and fills placeholders', () => {
    expect(slug('Blue  Tee!')).toBe('BLUE-TEE');
    expect(
      fillTemplate('{product.name|slug}-{product.name}', {
        'product.name': 'a b',
      }),
    ).toBe('A-B-a b');
  });
});

describe('simple product form (field-map)', () => {
  it('saves a Product with name, price in cents and description', async () => {
    const s = source();
    const active = simple(['products.simple']);
    const writes = planFieldMapSave(active, catalogModels, {
      name: 'Ceramic mug',
      price: 1850,
      description: 'Holds coffee',
    });
    expect(writes).toHaveLength(1);
    const saved = await s.apply(writes);
    expect(saved.product).toMatchObject({
      name: 'Ceramic mug',
      price: 1850,
      description: 'Holds coffee',
    });
    // No Sku or stock without Inventory.
    expect(await s.list(sku)).toHaveLength(0);
    expect(await s.list(level)).toHaveLength(0);
    const loaded = await loadFieldMap(
      s,
      active,
      catalogModels,
      saved.product?.id ?? '',
    );
    expect(loaded).toEqual({
      name: 'Ceramic mug',
      price: 1850,
      description: 'Holds coffee',
    });
  });

  it('with Inventory adds a Quantity field: one Sku plus a StockLevel at the default location', async () => {
    const s = source();
    const ids = ['products.simple', 'inventory.stock'];
    const active = simple(ids);
    expect(Object.keys(blankFieldMap(active, catalogModels))).toEqual([
      'name',
      'price',
      'description',
      'quantity',
    ]);
    const values = {
      name: 'Blue Tee',
      price: 900,
      description: '',
      quantity: 7,
    };
    const saved = await s.apply(
      planFieldMapSave(active, catalogModels, values),
    );
    const skus = await s.list(sku);
    expect(skus).toHaveLength(1);
    expect(skus[0]).toMatchObject({
      productId: saved.product?.id,
      code: 'BLUE-TEE',
    });
    const levels = await s.list(level);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({
      skuId: skus[0]?.id,
      qty: 7,
      state: 'available',
    });

    // Editing updates in place: still one Sku, one level, one location.
    const edited = await loadFieldMap(
      s,
      active,
      catalogModels,
      saved.product?.id ?? '',
    );
    expect(edited.quantity).toBe(7);
    await s.apply(
      planFieldMapSave(
        active,
        catalogModels,
        { ...edited, quantity: 12 },
        saved.product?.id,
      ),
    );
    expect(await s.list(sku)).toHaveLength(1);
    expect((await s.list(level)).map((l) => l.qty)).toEqual([12]);
    expect(
      await s.list(
        catalogModels('@happyvertical/smrt-inventory:InventoryLocation'),
      ),
    ).toHaveLength(1);
  });

  it('shows no quantity without Inventory', () => {
    expect(
      Object.keys(blankFieldMap(simple(['products.simple']), catalogModels)),
    ).not.toContain('quantity');
  });
});

describe('variant grid form (clothing)', () => {
  it('builds the cartesian grid, skipping empty axes and blanks', () => {
    expect(
      combinations([
        { name: 'size', values: ['S', 'M', ' ', 's'] },
        { name: 'color', values: ['navy'] },
      ]).map((c) => c.attributes),
    ).toEqual([
      { size: 'S', color: 'navy' },
      { size: 'M', color: 'navy' },
    ]);
    expect(
      combinations([
        { name: 'size', values: ['S'] },
        { name: 'color', values: [] },
      ]).map((c) => c.attributes),
    ).toEqual([{ size: 'S' }]);
    expect(combinations([{ name: 'size', values: [] }])).toEqual([]);
    // A pasted list splits on commas.
    expect(
      combinations([{ name: 'color', values: ['navy, red,Navy'] }]).map(
        (c) => c.values,
      ),
    ).toEqual([['navy'], ['red']]);
  });

  const six = (active: ReturnType<typeof grid>) => {
    const state = blankGrid(active, catalogModels);
    state.values = { name: 'Rain Jacket', price: 8900 };
    state.axes = { size: ['S', 'M', 'L'], color: ['navy', 'red'] };
    return state;
  };

  it('defaults sizes to XS-XL and colors to none', () => {
    expect(blankGrid(grid(['products.clothing']), catalogModels).axes).toEqual({
      size: ['XS', 'S', 'M', 'L', 'XL'],
      color: [],
    });
  });

  it('3 sizes x 2 colors saves a Product, 2 axes and 6 Skus with attributes pinned', async () => {
    const s = source();
    const active = grid(['products.clothing']);
    const { product: saved } = await s.apply(
      planGridSave(active, catalogModels, six(active)),
    );
    const skus = await s.list(sku);
    expect(skus).toHaveLength(6);
    const pinned = skus.map((r) => JSON.parse(String(r.attributes)));
    expect(pinned).toContainEqual({ size: 'M', color: 'navy' });
    expect(new Set(skus.map((r) => r.code)).size).toBe(6);
    expect(skus.every((r) => r.productId === saved?.id)).toBe(true);
    const axes = await s.list(variant);
    expect(
      axes.map((a) => [
        a.axisName,
        JSON.parse(String(a.allowedValues)),
        a.sortOrder,
      ]),
    ).toEqual([
      ['size', ['S', 'M', 'L'], 0],
      ['color', ['navy', 'red'], 1],
    ]);
    expect(await s.list(level)).toHaveLength(0);
  });

  it('reloads an edit into the same axes and grid', async () => {
    const s = source();
    const active = grid(['products.clothing']);
    const { product: saved } = await s.apply(
      planGridSave(active, catalogModels, six(active)),
    );
    const loaded = await loadGrid(s, active, catalogModels, saved?.id ?? '');
    expect(loaded?.state.values).toEqual({ name: 'Rain Jacket', price: 8900 });
    expect(loaded?.state.axes).toEqual({
      size: ['S', 'M', 'L'],
      color: ['navy', 'red'],
    });
    expect(gridCombos(active.form, loaded?.state ?? six(active))).toHaveLength(
      6,
    );
    expect(loaded?.existing.skus).toHaveLength(6);
  });

  it('editing adds new combinations, prunes removed ones and keeps the rest', async () => {
    const s = source();
    const active = grid(['products.clothing']);
    const { product: saved } = await s.apply(
      planGridSave(active, catalogModels, six(active)),
    );
    const before = await s.list(sku);
    const loaded = await loadGrid(s, active, catalogModels, saved?.id ?? '');
    if (!loaded) throw new Error('not loaded');
    loaded.state.axes.size = ['M', 'L', 'XL'];
    loaded.state.axes.color = ['navy'];
    await s.apply(
      planGridSave(active, catalogModels, loaded.state, loaded.existing),
    );
    const after = await s.list(sku);
    expect(after.map((r) => JSON.parse(String(r.attributes)))).toEqual(
      expect.arrayContaining([
        { size: 'M', color: 'navy' },
        { size: 'L', color: 'navy' },
        { size: 'XL', color: 'navy' },
      ]),
    );
    expect(after).toHaveLength(3);
    // Kept combinations keep their rows.
    const mNavy = before.find((r) => {
      const pin = JSON.parse(String(r.attributes));
      return pin.size === 'M' && pin.color === 'navy';
    });
    expect(mNavy).toBeDefined();
    expect(after.some((r) => r.id === mNavy?.id)).toBe(true);
    // A removed axis goes too.
    loaded.state.axes.color = [];
    const again = await loadGrid(s, active, catalogModels, saved?.id ?? '');
    if (!again) throw new Error('not loaded');
    again.state.axes.color = [];
    await s.apply(
      planGridSave(active, catalogModels, again.state, again.existing),
    );
    expect((await s.list(variant)).map((a) => a.axisName)).toEqual(['size']);
    expect(
      (await s.list(sku)).map((r) => JSON.parse(String(r.attributes))),
    ).toEqual([{ size: 'M' }, { size: 'L' }, { size: 'XL' }]);
  });

  it('keeps Sku codes unique when values slug alike, and defaults untouched cells', async () => {
    const s = source();
    const active = grid(['products.clothing', 'inventory.stock']);
    const state = blankGrid(active, catalogModels);
    state.values = { name: 'Tee', price: 1 };
    state.axes = { size: ['S'], color: ['Navy Blue', 'Navy-Blue'] };
    await s.apply(planGridSave(active, catalogModels, state));
    const skus = await s.list(sku);
    expect(skus).toHaveLength(2);
    expect(new Set(skus.map((r) => r.code)).size).toBe(2);
    expect(
      skus.map((r) => JSON.parse(String(r.attributes)).color).sort(),
    ).toEqual(['Navy Blue', 'Navy-Blue']);
    // Untouched cells carry the declared default quantity, not null.
    expect((await s.list(level)).map((l) => l.qty)).toEqual([0, 0]);
  });

  it('names Skus from the product and the values', () => {
    expect(
      skuCode('Rain Jacket', {
        key: '',
        attributes: {},
        values: ['S', 'navy'],
      }),
    ).toBe('RAIN-JACKET-S-NAVY');
    expect(skuCode('', { key: '', attributes: {}, values: ['S'] })).toBe(
      'SKU-S',
    );
  });
});

describe('Inventory extends the clothing grid', () => {
  const ids = ['products.clothing', 'inventory.stock'];

  it('adds a quantity per cell and a StockLevel per Sku at one default location', async () => {
    const s = source();
    const active = grid(ids);
    const state = blankGrid(active, catalogModels);
    state.values = { name: 'Tee', price: 2500 };
    state.axes = { size: ['S', 'M', 'L'], color: ['navy', 'red'] };
    state.cells[JSON.stringify(['M', 'navy'])] = { quantity: 4 };
    state.cells[JSON.stringify(['L', 'red'])] = { quantity: 9 };
    const { product: saved } = await s.apply(
      planGridSave(active, catalogModels, state),
    );

    const skus = await s.list(sku);
    const levels = await s.list(level);
    expect(skus).toHaveLength(6);
    expect(levels).toHaveLength(6);
    expect(
      await s.list(
        catalogModels('@happyvertical/smrt-inventory:InventoryLocation'),
      ),
    ).toHaveLength(1);
    const qtyOf = (size: string, color: string) => {
      const row = skus.find(
        (r) => String(r.attributes) === JSON.stringify({ size, color }),
      );
      return levels.find((l) => l.skuId === row?.id)?.qty;
    };
    expect(qtyOf('M', 'navy')).toBe(4);
    expect(qtyOf('L', 'red')).toBe(9);
    expect(qtyOf('S', 'navy')).toBe(0);
    expect(stockByProduct(skus, levels).get(saved?.id ?? '')).toBe(13);

    // Reload shows the quantities back in the cells.
    const loaded = await loadGrid(s, active, catalogModels, saved?.id ?? '');
    expect(loaded?.state.cells[JSON.stringify(['M', 'navy'])]).toEqual({
      quantity: 4,
    });

    // Pruning a size deletes its stock with its Skus.
    if (!loaded) throw new Error('not loaded');
    loaded.state.axes.size = ['M', 'L'];
    await s.apply(
      planGridSave(active, catalogModels, loaded.state, loaded.existing),
    );
    expect(await s.list(sku)).toHaveLength(4);
    expect(await s.list(level)).toHaveLength(4);

    // Deleting the product removes everything under it.
    const rest = await s.list(sku);
    await s.apply(planProductDelete(saved?.id ?? '', rest, catalogModels));
    expect(await s.list(sku)).toHaveLength(0);
    expect(await s.list(level)).toHaveLength(0);
    expect(await s.list(variant)).toHaveLength(0);
  });

  it('without Inventory there is no cell input and no stock is written', () => {
    const active = grid(['products.clothing']);
    const state = blankGrid(active, catalogModels);
    state.values = { name: 'Tee', price: 1 };
    state.axes = { size: ['S'], color: ['red'] };
    const writes = planGridSave(active, catalogModels, state);
    expect(
      writes.some((w) => w.op === 'save' && w.model.id === STOCK_LEVEL),
    ).toBe(false);
  });
});

describe('forms offered for the Product model', () => {
  it('lists the forms of the added recipes only, in order, with extensions', () => {
    expect(activeForms([], recipes, PRODUCT)).toEqual([]);
    const both = activeForms(
      ['products.clothing', 'products.simple', 'inventory.stock'],
      recipes,
      PRODUCT,
    );
    expect(both.map((a) => a.form.id)).toEqual([
      'product.simple',
      'product.clothing',
    ]);
    expect(both.every((a) => a.extensions.length === 1)).toBe(true);
    expect(
      activeForms(['products.simple'], recipes, PRODUCT)[0]?.extensions,
    ).toEqual([]);
  });
});
