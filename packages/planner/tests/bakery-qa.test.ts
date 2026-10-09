import { afterEach, describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { listColumns } from '../src/lib/data/columns.ts';
import { fakeRecords } from '../src/lib/data/fakes.ts';
import { COOKBOOK_PACKS, setSamplePack } from '../src/lib/data/packs.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import { stockSamples } from '../src/lib/forms/stock.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import {
  getLibraryCookbook,
  libraryCookbooks,
} from '../src/lib/library/index.ts';
import { recipeNav, recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';
import { inScope, pageScope } from '../src/lib/recipes/scope.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const C = '@happyvertical/smrt-commerce:';
const P = '@happyvertical/smrt-products:';
const model = (id: string) => {
  const found = getModelByQualifiedName(id);
  if (!found) throw new Error(id);
  return found.model;
};
const source = () =>
  createMemoryDataSource({
    samples: stockSamples(catalogModels),
    empty: [`${P}ProductVariant`, '@happyvertical/smrt-profiles:ProfileType'],
    defaults: (m) => recipeState.apply(m).background,
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });
const apply = (id: string) => {
  const cookbook = getLibraryCookbook(id);
  if (!cookbook) throw new Error(id);
  expect(applyLibraryCookbook(cookbook, new CookbookStore()).ok).toBe(true);
};

afterEach(() => {
  setSamplePack(null);
  recipeState.clear();
});

describe('bakery ingredients', () => {
  it('are generated as material products and fill the filtered page', async () => {
    apply('bakery');
    const ds = source();
    const product = model(`${P}Product`);
    const added = recipeState.ids.flatMap((id) => {
      const recipe = recipes.find((r) => r.id === id);
      return recipe ? recipeNav(recipe) : [];
    });
    const rows = await ds.list(product);
    const ingredients = rows.filter((r) =>
      inScope(pageScope(product.id, 'ingredients', added), r),
    );
    const sellable = rows.filter((r) =>
      inScope(pageScope(product.id, undefined, added), r),
    );
    expect(ingredients.map((r) => r.name)).toContain('Bread flour, 25 kg');
    expect(ingredients.length).toBe(6);
    expect(sellable.length).toBe(8);
    expect(sellable.some((r) => r.productType === 'material')).toBe(false);
  });
});

describe('policies on feature models', () => {
  it('hide fields in the form and the list columns', () => {
    apply('bakery');
    const po = model(`${C}ProductionOrder`);
    const fields = recipeState.apply(po).fields;
    const names = fields.map((f) => f.name);
    for (const hidden of [
      'customerId',
      'vendorId',
      'expiryDate',
      'channelId',
    ]) {
      expect(names).not.toContain(hidden);
    }
    expect(listColumns(fields).map((c) => c.name)).not.toContain('vendorId');
  });
});

describe('vendor on sales documents', () => {
  it.each(libraryCookbooks.map((c) => c.id))('is hidden under %s', (id) => {
    apply(id);
    for (const name of ['Order', 'Estimate', 'WholesaleOrder']) {
      const m = model(`${C}${name}`);
      if (
        !recipeState.ids.some((r) =>
          recipes.find((x) => x.id === r)?.models.includes(m.id),
        )
      )
        continue;
      const names = recipeState.apply(m).fields.map((f) => f.name);
      expect(names, `${id} ${name}`).not.toContain('vendorId');
    }
  });
});

describe('sample packs per cookbook', () => {
  it('carry the cookbook default tax rate', () => {
    for (const cookbook of libraryCookbooks) {
      const policy = cookbook.document.policies.find(
        (p) => p.fieldName === 'taxRate' && p.defaultValue !== undefined,
      );
      const expected = policy
        ? Number(policy.defaultValue)
        : (cookbook.settings?.taxRate ?? 0);
      expect(COOKBOOK_PACKS[cookbook.id]?.taxRate, cookbook.id).toBe(expected);
    }
  });

  it('generate untaxed lines for a zero-tax cookbook', () => {
    setSamplePack('bakery');
    const lines = fakeRecords(model(`${C}ContractLineItem`), 20);
    expect(lines.every((l) => l.taxRate === 0)).toBe(true);
    setSamplePack('mechanic');
    expect(
      fakeRecords(model(`${C}ContractLineItem`), 5).every(
        (l) => l.taxRate === 0.0825,
      ),
    ).toBe(true);
  });

  it('describe products in their own words, never the generic template', () => {
    for (const [id, pack] of Object.entries(COOKBOOK_PACKS)) {
      setSamplePack(id);
      const rows = fakeRecords(model(`${P}Product`), pack.products.length);
      for (const row of rows) {
        expect(String(row.description), id).not.toMatch(/small batches/);
      }
      for (const product of pack.products) {
        expect(product.description, `${id} ${product.name}`).toBeTruthy();
      }
    }
  });

  it('name event series and places from the pack', () => {
    for (const id of ['mechanic', 'welder', 'yoga-studio']) {
      setSamplePack(id);
      const pack = COOKBOOK_PACKS[id];
      const series = fakeRecords(
        model('@happyvertical/smrt-events:EventSeries'),
        3,
      );
      const places = fakeRecords(model('@happyvertical/smrt-places:Place'), 3);
      expect(pack?.seriesNames).toContain(String(series[0]?.name));
      expect(pack?.placeNames).toContain(String(places[0]?.name));
    }
  });
});
