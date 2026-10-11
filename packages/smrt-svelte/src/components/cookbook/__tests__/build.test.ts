import type { Cookbook } from '@happyvertical/smrt-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyShellLayout } from '../../workspace/admin-shell/layout.js';
import { buildCookbookShell } from '../build.js';
import { narrowCatalog } from '../catalog.js';
import type { CookbookCatalog } from '../types.js';
import {
  FIXTURE_NAMES,
  readFixture,
  workspaceCatalog,
} from './workspace-catalog.js';

let catalog: CookbookCatalog;
beforeAll(async () => {
  catalog = await workspaceCatalog();
}, 120_000);

const fixture = (name: string) => readFixture(name) as Cookbook;

/** The headings and entry labels the shell shows once the layout applies. */
function visibleNav(shell: ReturnType<typeof buildCookbookShell>) {
  return applyShellLayout(
    [],
    shell.navGroups,
    undefined,
    shell.layout,
  ).groups.map((g) => ({
    id: g.id,
    heading: g.heading,
    labels: g.items.map((i) => i.label),
  }));
}

describe('workspace catalog', () => {
  it('carries the recipes and models of the real packages', () => {
    const ids = catalog.recipes.map((r) => r.id);
    for (const id of ['commerce.sales', 'inventory.stock', 'products.simple']) {
      expect(ids).toContain(id);
    }
    expect(
      catalog.models.find((m) => m.id === '@happyvertical/smrt-commerce:Order'),
    ).toMatchObject({ name: 'Order', packageId: 'commerce', exposed: true });
  });
});

describe.each(FIXTURE_NAMES)('buildCookbookShell: %s fixture', (name) => {
  it('resolves every recipe, model and layout id with no issues', () => {
    const cookbook = fixture(name);
    const shell = buildCookbookShell({ cookbook, catalog });
    expect(shell.issues).toEqual([]);

    // Every id the saved layout names exists in the nav the recipes produce.
    const layout = cookbook.layout ?? { version: 1 as const };
    const itemIds = new Set(shell.entries.keys());
    const sectionIds = new Set([
      ...shell.sections.map((s) => s.id),
      ...(layout.customSections ?? []).map((s) => s.id),
    ]);
    const referenced = [
      ...Object.values(layout.itemOrder ?? {}).flat(),
      ...Object.keys(layout.moved ?? {}),
      ...Object.keys(layout.items ?? {}),
      ...(layout.hidden ?? []).filter((id) => id.startsWith('item:')),
    ];
    expect(referenced.filter((id) => !itemIds.has(id))).toEqual([]);
    const referencedSections = [
      ...(layout.sectionOrder ?? []),
      ...Object.keys(layout.sections ?? {}),
      ...Object.values(layout.moved ?? {}),
      ...Object.keys(layout.itemOrder ?? {}),
    ];
    expect(referencedSections.filter((id) => !sectionIds.has(id))).toEqual([]);
  });

  it('uses navMode sections with an icon and href on every section', () => {
    const shell = buildCookbookShell({ cookbook: fixture(name), catalog });
    expect(shell.navMode).toBe('sections');
    for (const group of shell.navGroups) {
      expect(group.href).toMatch(/^\/s\/section-/);
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item.id).toMatch(/^item:[a-z0-9-]+:\w+(:\w+)?$/);
        expect(item.icon).toBeTruthy();
        expect(item.description).toBeTruthy();
      }
    }
  });

  it('gives every shown section a page with an overview', () => {
    const shell = buildCookbookShell({ cookbook: fixture(name), catalog });
    const ids = visibleNav(shell).map((g) => g.id);
    for (const id of ids) {
      expect(shell.overviews[id]?.definition.id).toBe(id);
    }
  });
});

describe('buildCookbookShell: bakery', () => {
  it('shows the sections and entry names the planner shows', () => {
    const shell = buildCookbookShell({ cookbook: fixture('bakery'), catalog });
    expect(visibleNav(shell)).toEqual([
      { id: 'custom:shop', heading: 'Shop', labels: ['Orders', 'Customers'] },
      {
        id: 'custom:wholesale',
        heading: 'Wholesale',
        labels: ['Cafe orders', 'Invoices', 'Payments'],
      },
      {
        id: 'custom:kitchen',
        heading: 'Kitchen',
        labels: ['Products', 'Ingredients', 'Stock', 'Batches'],
      },
      {
        id: 'custom:buying',
        heading: 'Buying',
        labels: ['Suppliers', 'Purchase orders'],
      },
      {
        id: 'section:accounting',
        heading: 'Accounting',
        labels: ['Accounts', 'Journals'],
      },
    ]);
  });

  it('keeps stable ids, keyed entries with their filter, and nouns', () => {
    const shell = buildCookbookShell({ cookbook: fixture('bakery'), catalog });
    expect(shell.entries.get('item:commerce:Order')).toMatchObject({
      path: '/m/commerce/Order/',
      recipeId: 'commerce.sales',
    });
    expect(
      shell.entries.get('item:products:Product:ingredients'),
    ).toMatchObject({
      path: '/m/products/Product/ingredients/',
      filter: { field: 'productType', value: 'material' },
    });
    expect(shell.entries.get('item:inventory:StockLevel')?.noun).toBe(
      'stock entry',
    );
    // A feature model no recipe covers is an entry with no recipe.
    expect(
      shell.entries.get('item:commerce:ProductionOrder')?.recipeId,
    ).toBeNull();
  });

  it('applies the cookbook theme', () => {
    const shell = buildCookbookShell({ cookbook: fixture('bakery'), catalog });
    expect(shell.theme).toEqual({
      preset: 'cookbook-brand-b45309-georgia',
      colorScheme: 'system',
      brand: { primary: '#b45309', fontFamily: 'Georgia' },
    });
  });

  it('passes the app-scope field policies through for the runtime', () => {
    const shell = buildCookbookShell({ cookbook: fixture('bakery'), catalog });
    expect(shell.policies.length).toBeGreaterThan(0);
    expect(shell.policies[0]).toMatchObject({ scopeType: 'app' });
  });

  it('honours href, entryPath and sectionPath', () => {
    const shell = buildCookbookShell({
      cookbook: fixture('bakery'),
      catalog,
      href: (path) => `/app${path}`,
      entryPath: ({ packageId, modelName, key }) =>
        `/data/${packageId}/${modelName}${key ? `/${key}` : ''}`,
      sectionPath: (id) => `/sections/${id.replace(':', '-')}`,
    });
    expect(shell.entries.get('item:commerce:Order')?.href).toBe(
      '/app/data/commerce/Order',
    );
    expect(
      shell.navGroups.every((g) =>
        g.href?.startsWith('/app/sections/section-'),
      ),
    ).toBe(true);
    expect(shell.sectionPath('custom:shop')).toBe('/app/sections/custom-shop');
  });
});

describe('buildCookbookShell: sections and features', () => {
  const base = (over: Partial<Cookbook>): Cookbook => ({
    $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
    version: 1,
    recipes: [],
    features: [],
    policies: [],
    ...over,
  });

  it("with no layout, groups entries under the recipes' suggested sections", () => {
    const shell = buildCookbookShell({
      cookbook: base({ recipes: ['commerce.sales', 'commerce.customers'] }),
      catalog,
    });
    expect(shell.layout).toBeNull();
    expect(shell.issues).toEqual([]);
    const ids = shell.navGroups.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(shell.sections.every((s) => s.id.startsWith('section:'))).toBe(true);
    // Each entry appears once, in the section of the first recipe that lists it.
    const all = shell.navGroups.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts features in a More section after the recipes'", () => {
    const shell = buildCookbookShell({
      cookbook: base({
        recipes: ['inventory.stock'],
        features: ['@happyvertical/smrt-commerce:ProductionOrder'],
      }),
      catalog,
    });
    const last = shell.navGroups.at(-1);
    expect(last).toMatchObject({ id: 'section:more', heading: 'More' });
    expect(last?.items.map((i) => i.id)).toEqual([
      'item:commerce:ProductionOrder',
    ]);
    expect(last?.items[0]?.label).toBe('Production Order');
  });

  it('reports unknown recipes, models and features without throwing', () => {
    const shell = buildCookbookShell({
      cookbook: base({
        recipes: ['nope.nothing'],
        features: ['@happyvertical/smrt-commerce:Nothing'],
      }),
      catalog,
    });
    expect(shell.navGroups).toEqual([]);
    expect(shell.issues).toEqual([
      'Unknown recipe "nope.nothing".',
      'Feature @happyvertical/smrt-commerce:Nothing is not an exposed model.',
    ]);
  });

  it('is deterministic and unchanged by narrowing the catalog to the cookbook', () => {
    const cookbook = fixture('bakery');
    const full = buildCookbookShell({ cookbook, catalog });
    const narrow = buildCookbookShell({
      cookbook,
      catalog: narrowCatalog(catalog, cookbook),
    });
    expect(narrow.navGroups).toEqual(full.navGroups);
    expect(narrow.sections).toEqual(full.sections);
    expect(
      JSON.parse(JSON.stringify(narrowCatalog(catalog, cookbook))),
    ).toEqual(narrowCatalog(catalog, cookbook));
    expect(narrowCatalog(catalog, cookbook).recipes.length).toBeLessThan(
      catalog.recipes.length,
    );
  });
});

describe('buildCookbookShell: overviews', () => {
  const cookbook = (over: Partial<Cookbook> = {}): Cookbook => ({
    ...fixture('bakery'),
    ...over,
  });

  it('defines shortcuts by default and adds the lead model with dataWidgets', () => {
    const plain = buildCookbookShell({ cookbook: cookbook(), catalog });
    expect(
      plain.overviews['custom:kitchen']?.definition.defaults.map((w) => w.type),
    ).toEqual(['shortcuts']);

    const rich = buildCookbookShell({
      cookbook: cookbook(),
      catalog,
      dataWidgets: true,
    });
    const defaults = rich.overviews['section:accounting']?.definition.defaults;
    expect(defaults?.map((w) => w.id)).toEqual([
      'shortcuts',
      'count',
      'latest',
    ]);
    expect(defaults?.[1]?.options.model).toMatch(
      /^@happyvertical\/smrt-ledgers:/,
    );
    // Models confine the widgets to the app's catalog.
    expect(rich.overviews['section:accounting']?.definition.models).toContain(
      '@happyvertical/smrt-commerce:Order',
    );
  });

  it("carries the cookbook's stored override, drops an empty one, and reports unknown pages", () => {
    const override = {
      version: 1 as const,
      added: [{ id: 'w1', type: 'note', span: 2, options: { body: 'Hi' } }],
    };
    const shell = buildCookbookShell({
      cookbook: cookbook({
        overviews: {
          'custom:shop': override,
          'custom:kitchen': { version: 1 },
          'section:ghost': override,
        },
      }),
      catalog,
    });
    expect(shell.overviews['custom:shop']?.override).toEqual(override);
    expect(shell.overviews['custom:kitchen']?.override).toBeNull();
    expect(shell.overviews['custom:wholesale']?.override).toBeNull();
    expect(shell.overviews['section:ghost']).toBeUndefined();
    expect(shell.issues).toEqual([
      'Overview "section:ghost" names no section; its override is ignored.',
    ]);
  });

  it('reports a malformed override and keeps it for the page to sanitize', () => {
    const shell = buildCookbookShell({
      cookbook: cookbook({
        overviews: { 'custom:shop': { version: 2 } as never },
      }),
      catalog,
    });
    expect(shell.issues[0]).toMatch(/^Overview custom:shop:/);
  });
});

describe('buildCookbookShell: recipe surfaces', () => {
  it('places shell-widget, route, settings-panel and widget surfaces', () => {
    const surfaced = catalog.recipes.filter((r) => (r.surfaces ?? []).length);
    const synthetic = {
      id: 'demo.surfaces',
      label: 'Demo',
      models: ['@happyvertical/smrt-commerce:Order'],
      nav: [
        {
          label: 'Orders',
          model: '@happyvertical/smrt-commerce:Order',
          icon: 'shoppingBag',
        },
      ],
      surfaces: [
        {
          kind: 'shell-widget' as const,
          slot: 'header.end' as const,
          export: '@acme/demo#Bell' as const,
          label: 'Bell',
          icon: 'bell',
        },
        {
          kind: 'route' as const,
          path: '/demo',
          export: '@acme/demo#Page' as const,
          label: 'Demo page',
        },
        {
          kind: 'settings-panel' as const,
          export: '@acme/demo#Settings' as const,
          label: 'Demo settings',
        },
        {
          kind: 'widget' as const,
          type: 'sales-total',
          export: '@acme/demo#SalesTotal' as const,
          label: 'Sales total',
        },
      ],
    };
    const shell = buildCookbookShell({
      cookbook: {
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: ['demo.surfaces'],
        features: [],
        policies: [],
      },
      catalog: { recipes: [...surfaced, synthetic], models: catalog.models },
    });
    expect(shell.shellWidgets).toContainEqual({
      recipeId: 'demo.surfaces',
      slot: 'header.end',
      export: '@acme/demo#Bell',
      label: 'Bell',
      icon: 'bell',
    });
    expect(shell.routes).toEqual([
      {
        recipeId: 'demo.surfaces',
        path: '/demo',
        export: '@acme/demo#Page',
        label: 'Demo page',
      },
    ]);
    expect(shell.settingsPanels).toHaveLength(1);
    expect(shell.widgets).toEqual([
      { id: 'demo.surfaces', surfaces: [synthetic.surfaces[3]] },
    ]);
  });

  it("surfaces the real recipes' shell widgets when their cookbook includes them", () => {
    const withSurfaces = catalog.recipes.filter((r) =>
      (r.surfaces ?? []).some((s) => s.kind !== 'widget'),
    );
    expect(withSurfaces.length).toBeGreaterThan(0);
    const shell = buildCookbookShell({
      cookbook: {
        $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
        version: 1,
        recipes: withSurfaces.map((r) => r.id),
        features: [],
        policies: [],
      },
      catalog,
    });
    expect(
      shell.shellWidgets.length +
        shell.routes.length +
        shell.settingsPanels.length,
    ).toBeGreaterThan(0);
  });
});
