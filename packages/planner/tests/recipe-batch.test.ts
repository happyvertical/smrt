import { describe, expect, it } from 'vitest';
import {
  catalog,
  exposedModels,
  getModelByQualifiedName,
} from '../src/lib/catalog/index.ts';
import { buildCards } from '../src/lib/recipes/cards.ts';
import { featureEntries } from '../src/lib/recipes/features.ts';
import {
  buildNavSections,
  navSectionOf,
  recipeModels,
  recipes,
  recipesById,
} from '../src/lib/recipes/index.ts';
import { childModels } from '../src/lib/recipes/plumbing.ts';
import { withRequirements } from '../src/lib/recipes/resolve.ts';

const LINE = '@happyvertical/smrt-commerce:ContractLineItem';
const get = (id: string) => {
  const recipe = recipesById.get(id);
  if (!recipe) throw new Error(id);
  return recipe;
};

describe('every recipe', () => {
  it.each(
    recipes.map((r) => [r.id, r] as const),
  )('%s lists only real, exposed models and its nav is a subset', (_id, recipe) => {
    expect(new Set(recipe.models).size).toBe(recipe.models.length);
    for (const qualified of recipe.models) {
      const found = getModelByQualifiedName(qualified);
      expect(found, qualified).toBeDefined();
      // A model with a screen of its own is exposed; feature recipes may also
      // list internal models (sessions, policy rows) that have none.
      if (recipe.nav.some((entry) => entry.model === qualified)) {
        expect(found?.model.exposed, qualified).toBe(true);
      }
    }
    expect(recipeModels(recipe)).toHaveLength(recipe.models.length);
    for (const entry of recipe.nav) {
      expect(recipe.models).toContain(entry.model);
    }
    for (const id of recipe.requires) expect(recipesById.has(id)).toBe(true);
    expect(recipe.help, 'help page').toBeDefined();
  });

  it('uses the ledgers Account, never the messages one', () => {
    const ids = recipes.flatMap((r) => r.models);
    expect(ids).toContain('@happyvertical/smrt-ledgers:Account');
    expect(ids).not.toContain('@happyvertical/smrt-messages:Account');
  });
});

describe('child models', () => {
  it('are listed by their recipe but never in the nav', () => {
    const childIds = new Set<string>();
    for (const recipe of recipes) {
      for (const entry of recipe.nav) {
        for (const child of childModels(catalog, entry.model)) {
          if (recipe.models.includes(child.id)) childIds.add(child.id);
        }
      }
    }
    expect(childIds).toContain(LINE);
    expect(childIds).toContain('@happyvertical/smrt-commerce:InvoiceLineItem');
    for (const recipe of recipes) {
      for (const entry of recipe.nav) {
        expect(childIds.has(entry.model), entry.model).toBe(false);
      }
    }
  });

  it.each([
    ['commerce.sales', 'Order', [LINE]],
    ['commerce.purchases', 'PurchaseOrder', [LINE]],
    ['commerce.estimates', 'Estimate', [LINE]],
    ['commerce.wholesale', 'WholesaleOrder', [LINE]],
    [
      'commerce.invoicing',
      'Invoice',
      ['@happyvertical/smrt-commerce:InvoiceLineItem'],
    ],
    [
      'commerce.fulfillment',
      'Fulfillment',
      ['@happyvertical/smrt-commerce:FulfillmentLineItem'],
    ],
  ])('%s: %s renders its line rows', (id, name, expected) => {
    const recipe = get(id);
    const parent = `@happyvertical/smrt-commerce:${name}`;
    const children = childModels(catalog, parent).map((c) => c.id);
    for (const child of expected) {
      expect(children).toContain(child);
      expect(recipe.models).toContain(child);
      expect(recipe.nav.map((n) => n.model)).not.toContain(child);
    }
  });

  it('a recipe-covered model leaves the Features tab', () => {
    const entries = featureEntries(catalog, recipes).map((e) => e.id);
    expect(entries).not.toContain(LINE);
    expect(entries).not.toContain('@happyvertical/smrt-ledgers:Journal');
    for (const pkg of catalog.packages) {
      for (const model of exposedModels(pkg)) {
        if (recipes.some((r) => r.models.includes(model.id))) {
          expect(entries).not.toContain(model.id);
        }
      }
    }
  });
});

describe('stock', () => {
  it('adds stock movements', () => {
    expect(get('inventory.stock').models).toContain(
      '@happyvertical/smrt-inventory:StockMovement',
    );
  });
});

describe('agreements kinds', () => {
  it('is one card whose sub-switches choose the kind', () => {
    const card = buildCards(recipes).find((c) => c.id === 'agreements');
    expect(card?.recipes.map((r) => r.id)).toEqual([
      'commerce.agreements',
      'commerce.leases',
      'commerce.licenses',
    ]);
    expect(get('commerce.leases').nav.map((n) => n.model)).toEqual([
      '@happyvertical/smrt-commerce:Lease',
    ]);
  });
});

describe('suggested nav sections', () => {
  it.each([
    ['commerce.estimates', 'sales'],
    ['commerce.wholesale', 'sales'],
    ['sales.pipeline', 'sales'],
    ['commerce.invoicing', 'billing'],
    ['commerce.fulfillment', 'operations'],
    ['commerce.agreements', 'agreements'],
    ['commerce.leases', 'agreements'],
    ['ledgers.bookkeeping', 'accounting'],
    ['projects.tracker', 'projects'],
    ['events.calendar', 'calendar'],
  ])('%s suggests %s', (id, section) => {
    expect(navSectionOf(get(id)).id).toBe(section);
  });

  it('groups a sample cookbook into few sections with no child entries', () => {
    const ids = withRequirements(
      [
        'commerce.sales',
        'commerce.estimates',
        'commerce.invoicing',
        'commerce.fulfillment',
        'ledgers.bookkeeping',
        'projects.tracker',
        'events.calendar',
      ],
      recipesById,
    );
    const built = buildNavSections(ids.map(get));
    expect(built.map((s) => s.id).sort()).toEqual([
      'accounting',
      'billing',
      'calendar',
      'operations',
      'projects',
      'sales',
    ]);
    const salesNav = built
      .find((s) => s.id === 'sales')
      ?.recipes.flatMap((r) => r.nav.map((n) => n.label));
    expect(salesNav?.slice().sort()).toEqual([
      'Customers',
      'Estimates',
      'Sales orders',
    ]);
  });
});
