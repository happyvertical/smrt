import { afterEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { navNoun } from '../src/lib/data/format.ts';
import {
  applyLibraryCookbook,
  holdsCookbook,
  isCookbookEmpty,
  needsConfirm,
} from '../src/lib/library/apply.ts';
import {
  COOKBOOK_ICONS,
  libraryCookbooks,
  libraryRecipeLabels,
} from '../src/lib/library/index.ts';
import { cookbookNavGroups, previewMenu } from '../src/lib/library/menu.ts';
import type { CookbookLayout } from '../src/lib/library/types.ts';
import { recipesById } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const C = '@happyvertical/smrt-commerce:';

afterEach(() => recipeState.clear());

describe('cookbook data', () => {
  it('ships the four cookbooks with unique ids and known icons', () => {
    expect(libraryCookbooks.map((c) => c.id)).toEqual([
      'bakery',
      'mechanic',
      'welder',
      'yoga-studio',
    ]);
    expect(new Set(libraryCookbooks.map((c) => c.id)).size).toBe(
      libraryCookbooks.length,
    );
    for (const c of libraryCookbooks) {
      expect(COOKBOOK_ICONS[c.icon]?.length, c.id).toBeGreaterThan(0);
      expect(c.name && c.summary).toBeTruthy();
    }
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s is a valid cookbook that round-trips unchanged', (_id, cookbook) => {
    const parsed = parseCookbook(cookbook.document);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Requirements are already included and nothing was dropped.
    expect(parsed.cookbook.recipes).toEqual(cookbook.document.recipes);
    expect(parsed.cookbook.features).toEqual(cookbook.document.features);
    expect(parsed.cookbook.policies).toEqual(cookbook.document.policies);
    for (const id of cookbook.document.recipes) {
      expect(recipesById.has(id), id).toBe(true);
    }
    for (const ref of cookbook.document.features) {
      expect(getModelByQualifiedName(ref)?.model.exposed, ref).toBe(true);
    }
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s layout names only items the app generates, and places every one', (_id, cookbook) => {
    const layout = cookbook.document.layout as CookbookLayout;
    const groups = cookbookNavGroups(cookbook.document);
    const itemIds = new Set(
      groups.flatMap((g) => g.items.map((i) => i.id ?? i.href)),
    );
    const sectionIds = new Set([
      ...groups.map((g) => g.id ?? ''),
      ...(layout.customSections ?? []).map((s) => s.id),
    ]);
    const named = [
      ...Object.keys(layout.moved ?? {}),
      ...(layout.hidden ?? []),
      ...Object.keys(layout.items ?? {}),
      ...Object.values(layout.itemOrder ?? {}).flat(),
    ];
    for (const id of named) expect(itemIds.has(id), id).toBe(true);
    for (const id of layout.sectionOrder ?? []) {
      expect(sectionIds.has(id), id).toBe(true);
    }
    for (const to of Object.values(layout.moved ?? {})) {
      expect(sectionIds.has(to), to).toBe(true);
    }
    // Every item is moved into a cookbook section, hidden, or left in the
    // host's Accounting section on purpose.
    const placed = new Set([
      ...Object.keys(layout.moved ?? {}),
      ...(layout.hidden ?? []),
    ]);
    const left = [...itemIds].filter((id) => !placed.has(id));
    const accounting = new Set(
      groups
        .filter((g) => g.id === 'section:accounting')
        .flatMap((g) => g.items.map((i) => i.id ?? i.href)),
    );
    expect(left.every((id) => accounting.has(id))).toBe(true);
  });

  it.each(
    libraryCookbooks.map((c) => [c.id, c] as const),
  )('%s settings are the defaults new records start with', (_id, cookbook) => {
    recipeState.load(cookbook.document);
    const { currency, paymentTerms, taxRate } = cookbook.settings;
    const value = (model: string, field: string) => {
      const found = getModelByQualifiedName(`${C}${model}`);
      const entry = found
        ? recipeState
            .apply(found.model)
            .resolved.find((r) => r.field.name === field)
        : undefined;
      return entry?.hasDefault ? entry.default : undefined;
    };
    const covered = new Set(
      cookbook.document.recipes.flatMap(
        (id) => recipesById.get(id)?.models ?? [],
      ),
    );
    const has = (model: string) => covered.has(`${C}${model}`);
    for (const model of [
      'Order',
      'PurchaseOrder',
      'WholesaleOrder',
      'Estimate',
      'Invoice',
      'Agreement',
    ]) {
      if (has(model) && currency)
        expect(value(model, 'currency'), model).toBe(currency);
    }
    for (const model of [
      'Order',
      'WholesaleOrder',
      'Estimate',
      'Invoice',
      'Agreement',
    ]) {
      if (has(model) && paymentTerms)
        expect(value(model, 'terms'), model).toBe(paymentTerms);
    }
    if (paymentTerms)
      expect(value('Customer', 'paymentTerms')).toBe(paymentTerms);
    for (const model of ['ContractLineItem', 'InvoiceLineItem']) {
      if (has(model) && taxRate !== undefined)
        expect(value(model, 'taxRate'), model).toBe(taxRate);
    }
  });

  it('writes only the defaults each cookbook was asked for', () => {
    const settings = Object.fromEntries(
      libraryCookbooks.map((c) => [c.id, c.settings]),
    );
    expect(settings.bakery).toEqual({
      currency: 'USD',
      paymentTerms: 'Net 15',
      taxRate: 0,
    });
    expect(settings.mechanic).toMatchObject({
      paymentTerms: 'Due on receipt',
      taxRate: 0.0825,
    });
    expect(settings.welder.paymentTerms).toBe(
      '50% deposit, balance on completion',
    );
    expect(settings['yoga-studio'].paymentTerms).toBe('Due on receipt');
  });
});

describe('cookbook preview', () => {
  const menu = (id: string) => {
    const c = libraryCookbooks.find((x) => x.id === id);
    if (!c) throw new Error(id);
    return previewMenu(c.document).map((s) => [
      s.label,
      s.entries.map((e) => e.label),
    ]);
  };

  it('shows the bakery menu in its own words', () => {
    expect(menu('bakery')).toEqual([
      ['Shop', ['Orders', 'Customers']],
      ['Wholesale', ['Cafe orders', 'Invoices', 'Payments']],
      ['Kitchen', ['Products', 'Ingredients', 'Stock', 'Batches']],
      ['Buying', ['Suppliers', 'Purchase orders']],
      ['Accounting', ['Accounts', 'Journals']],
    ]);
  });

  it('shows the sections each trade asked for', () => {
    const names = (id: string) => menu(id).map(([label]) => label);
    expect(names('mechanic')).toEqual([
      'Jobs',
      'Parts',
      'Billing',
      'Schedule',
      'Accounting',
    ]);
    expect(names('welder')).toEqual([
      'Jobs',
      'Material',
      'Billing',
      'Schedule',
      'Accounting',
    ]);
    expect(names('yoga-studio')).toEqual([
      'Classes',
      'Members',
      'Shop',
      'Billing',
      'Accounting',
    ]);
    expect(menu('yoga-studio')[0]).toEqual([
      'Classes',
      ['Classes', 'Class series', 'Class types'],
    ]);
    expect(menu('mechanic')[0]).toEqual([
      'Jobs',
      ['Quotes', 'Work orders', 'Customers'],
    ]);
  });

  it('gives the welder work orders as Jobs, not a project tracker', () => {
    const welder = libraryCookbooks.find((c) => c.id === 'welder');
    if (!welder) throw new Error('welder');
    expect(welder.document.recipes).toContain('commerce.sales');
    expect(welder.document.recipes).not.toContain('projects.tracker');
    const jobs = menu('welder')[0];
    expect(jobs?.[0]).toBe('Jobs');
    expect(jobs?.[1]).toEqual(['Jobs', 'Customers', 'Quotes', 'Agreements']);
    expect(navNoun('Jobs')).toBe('job');
    expect(JSON.stringify(welder.document.layout)).not.toContain('projects:');
  });

  it('lists recipe chips by label', () => {
    const bakery = libraryCookbooks[0];
    expect(libraryRecipeLabels(bakery)).toContain('Wholesale orders');
    expect(libraryRecipeLabels(bakery)).toHaveLength(
      bakery.document.recipes.length,
    );
  });
});

describe('applying a cookbook', () => {
  const store = () => new CookbookStore();

  it('replaces recipes, features, options and layout', () => {
    const s = store();
    recipeState.add('sales.pipeline');
    recipeState.addFeature(`${C}Cart`);
    s.setLayout({ version: 1, hidden: ['section:sales'] });
    const bakery = libraryCookbooks[0];
    expect(applyLibraryCookbook(bakery, s).ok).toBe(true);
    const snap = s.snapshot();
    expect(snap.recipes).toEqual(bakery.document.recipes);
    expect(snap.features).toEqual(bakery.document.features);
    expect(snap.policies).toEqual(bakery.document.policies);
    expect(snap.layout).toEqual(bakery.document.layout);
    expect(recipeState.has('sales.pipeline')).toBe(false);
    expect(holdsCookbook(bakery, snap)).toBe(true);
  });

  it('asks first only when something is built', () => {
    const s = store();
    expect(isCookbookEmpty(s.snapshot())).toBe(true);
    expect(needsConfirm(s)).toBe(false);
    recipeState.add('commerce.customers');
    expect(needsConfirm(s)).toBe(true);
    recipeState.clear();
    s.setLayout({ version: 1, hidden: ['x'] });
    expect(needsConfirm(s)).toBe(true);
  });

  it('applies one cookbook over another', () => {
    const s = store();
    applyLibraryCookbook(libraryCookbooks[0], s);
    applyLibraryCookbook(libraryCookbooks[3], s);
    expect(s.snapshot().recipes).toEqual(libraryCookbooks[3].document.recipes);
    expect(s.snapshot().features).toEqual([]);
    expect(holdsCookbook(libraryCookbooks[0], s.snapshot())).toBe(false);
  });
});
