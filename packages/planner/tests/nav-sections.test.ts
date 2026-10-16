import { describe, expect, it } from 'vitest';
import { migrateLegacySections } from '../src/lib/cookbook/migrate.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import {
  buildNavSections,
  legacyNavSectionKeys,
  navSectionOf,
  recipes,
  recipesById,
} from '../src/lib/recipes/index.ts';

const get = (id: string) => {
  const recipe = recipesById.get(id);
  if (!recipe) throw new Error(id);
  return recipe;
};

describe('suggested nav sections', () => {
  it.each([
    ['commerce.customers', 'sales'],
    ['commerce.sales', 'sales'],
    ['commerce.vendors', 'purchasing'],
    ['commerce.purchases', 'purchasing'],
    ['products.simple', 'catalog'],
    ['products.clothing', 'catalog'],
    ['inventory.stock', 'catalog'],
  ])('%s suggests %s', (id, section) => {
    expect(navSectionOf(get(id)).id).toBe(section);
  });

  it('falls back to the group, then the recipe', () => {
    const base = get('commerce.customers');
    const { section: _s, ...bare } = base;
    expect(navSectionOf(bare)).toEqual({ id: base.id, label: base.label });
    const grouped = { ...bare, group: { id: 'g', label: 'G' } };
    expect(navSectionOf(grouped)).toEqual({ id: 'g', label: 'G' });
  });

  it('merges recipes suggesting one section, in declaration order', () => {
    const built = buildNavSections([
      get('commerce.customers'),
      get('products.simple'),
      get('commerce.sales'),
    ]);
    expect(built.map((s) => [s.id, s.recipes.map((r) => r.id)])).toEqual([
      ['sales', ['commerce.customers', 'commerce.sales']],
      ['catalog', ['products.simple']],
    ]);
  });

  it('keeps group (Options/Help) separate from the nav section', () => {
    expect(get('products.simple').group?.id).toBe('products');
    expect(navSectionOf(get('products.simple')).id).toBe('catalog');
  });
});

describe('migrateLegacySections', () => {
  const keys = legacyNavSectionKeys(recipes);

  it('does not treat a current section id as a legacy key', () => {
    // `billing` is both the invoicing group id and its section; shipping's old
    // `billing` key must not rewrite it to `operations`.
    expect(keys.billing).toBeUndefined();
    const layout = {
      version: 1,
      moved: { 'section:billing:commerce:Invoice:Invoices': 'section:sales' },
    } as const;
    expect(migrateLegacySections({ ...layout })).toEqual(layout);
  });

  it('maps old ids to the suggested sections', () => {
    expect(keys['commerce.customers']).toBe('sales');
    expect(keys.products).toBe('catalog');
  });

  it('rewrites section and item ids, merging and de-duplicating', () => {
    const out = migrateLegacySections(
      {
        version: 1,
        sectionOrder: [
          'section:products',
          'section:commerce.sales',
          'section:commerce.customers',
        ],
        itemOrder: {
          'section:commerce.customers': ['section:commerce.customers:p:MA:A'],
          'section:commerce.sales': ['section:commerce.sales:p:MB:B'],
        },
        hidden: [
          'section:commerce.vendors',
          'section:products:p:MH:Hid',
          'plain',
        ],
        moved: { 'section:products:p:MX:X': 'section:commerce.sales' },
        panels: { left: { visible: false } },
      },
      keys,
    );
    expect(out).toEqual({
      version: 1,
      sectionOrder: ['section:catalog', 'section:sales'],
      itemOrder: {
        'section:sales': ['section:sales:p:MA:A', 'section:sales:p:MB:B'],
      },
      hidden: ['section:catalog:p:MH:Hid', 'plain'],
      moved: { 'section:catalog:p:MX:X': 'section:sales' },
      panels: { left: { visible: false } },
    });
  });

  it('is idempotent and leaves unrelated ids alone', () => {
    const layout = {
      version: 1 as const,
      sectionOrder: ['section:sales', 'package:x'],
    };
    expect(migrateLegacySections(layout, keys)).toEqual(layout);
  });

  it('runs when a cookbook is loaded', () => {
    const result = parseCookbook({
      version: 1,
      recipes: [],
      policies: [],
      layout: { version: 1, sectionOrder: ['section:commerce.vendors'] },
    });
    expect(result.ok && result.cookbook.layout?.sectionOrder).toEqual([
      'section:purchasing',
    ]);
  });
});
