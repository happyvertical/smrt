import { describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import { migrateNavItemIds } from '../src/lib/cookbook/migrate.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { libraryCookbooks } from '../src/lib/library/index.ts';
import { cookbookNavGroups } from '../src/lib/library/menu.ts';
import {
  featureEntries,
  featureNavItems,
} from '../src/lib/recipes/features.ts';
import {
  navItemId,
  navSectionOf,
  recipeNav,
  recipes,
} from '../src/lib/recipes/index.ts';
import { UPSTREAM_GAPS } from './upstream-gaps.ts';

describe('navigation item ids', () => {
  it('are item:<pkg>:<Model>, with an explicit key for a repeat', () => {
    expect(navItemId('commerce', 'Order')).toBe('item:commerce:Order');
    expect(navItemId('commerce', 'Order', 'rush')).toBe(
      'item:commerce:Order:rush',
    );
  });

  it('never collide across recipes: a shared id means the same entry', () => {
    const seen = new Map<string, string>();
    for (const recipe of recipes) {
      for (const e of recipeNav(recipe)) {
        const id = navItemId(e.packageId, e.model.name, e.key);
        const shape = `${navSectionOf(recipe).id}|${e.label}`;
        if (UPSTREAM_GAPS.sharedNavId.has(id)) continue;
        expect(seen.get(id) ?? shape, `${id} in ${recipe.id}`).toBe(shape);
        seen.set(id, shape);
      }
    }
  });

  it('do not collide between recipes and features', () => {
    const recipeIds = new Set(
      recipes.flatMap((r) =>
        recipeNav(r).map((e) => navItemId(e.packageId, e.model.name, e.key)),
      ),
    );
    const features = featureEntries(catalog, recipes).map((f) => f.id);
    const ids = featureNavItems(features).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(recipeIds.has(id), id).toBe(false);
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s menu has no duplicate ids', (_id, cookbook) => {
    const ids = cookbookNavGroups(cookbook.document).flatMap((g) =>
      g.items.map((i) => i.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('migrateNavItemIds', () => {
  const old = {
    version: 1 as const,
    sectionOrder: ['section:sales', 'section:more'],
    itemOrder: {
      'section:sales': [
        'section:sales:commerce:Customer:Customers',
        'section:sales:commerce:Order:Sales orders',
      ],
      'section:more': ['section:more:commerce:ProductionOrder'],
    },
    hidden: ['section:billing:commerce:Invoice:Invoices', 'section:more'],
    moved: {
      'section:sales:commerce:Order:Sales orders': 'custom:shop',
      'section:more:commerce:ProductionOrder': 'section:sales',
    },
    items: {
      'section:sales:commerce:Order:Sales orders': { label: 'Work orders' },
    },
    customSections: [{ id: 'custom:shop', label: 'Shop' }],
  };

  it('rewrites a real old layout and leaves section ids alone', () => {
    const out = migrateNavItemIds(old);
    expect(out).toEqual({
      version: 1,
      sectionOrder: ['section:sales', 'section:more'],
      itemOrder: {
        'section:sales': ['item:commerce:Customer', 'item:commerce:Order'],
        'section:more': ['item:commerce:ProductionOrder'],
      },
      hidden: ['item:commerce:Invoice', 'section:more'],
      moved: {
        'item:commerce:Order': 'custom:shop',
        'item:commerce:ProductionOrder': 'section:sales',
      },
      items: { 'item:commerce:Order': { label: 'Work orders' } },
      customSections: [{ id: 'custom:shop', label: 'Shop' }],
    });
  });

  it('is idempotent and keeps unknown ids', () => {
    const once = migrateNavItemIds(old);
    expect(migrateNavItemIds(once)).toEqual(once);
    const odd = { version: 1 as const, hidden: ['plain', 'dock:tool'] };
    expect(migrateNavItemIds(odd)).toEqual(odd);
  });

  it('runs when a cookbook is loaded', () => {
    const result = parseCookbook({
      version: 1,
      recipes: [],
      policies: [],
      layout: old,
    });
    expect(result.ok && result.cookbook.layout?.hidden).toEqual([
      'item:commerce:Invoice',
      'section:more',
    ]);
  });
});
