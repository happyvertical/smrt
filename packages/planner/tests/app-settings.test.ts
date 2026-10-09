import { afterEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import type { Cookbook } from '../src/lib/cookbook/types.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import {
  getLibraryCookbook,
  libraryCookbooks,
} from '../src/lib/library/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import {
  DEFAULT_SETTINGS,
  readSettings,
  SETTING_TARGETS,
  settingsOfCookbook,
  writeSettings,
} from '../src/lib/settings/app-settings.ts';

const C = '@happyvertical/smrt-commerce:';
afterEach(() => recipeState.clear());

const bakery = () => {
  const cookbook = getLibraryCookbook('bakery');
  if (!cookbook) throw new Error('bakery cookbook missing');
  return cookbook;
};

const defaultOf = (model: string, field: string) => {
  const found = getModelByQualifiedName(`${C}${model}`);
  if (!found) throw new Error(model);
  const entry = recipeState
    .apply(found.model)
    .resolved.find((r) => r.field.name === field);
  return entry?.hasDefault ? entry.default : undefined;
};

describe('app settings', () => {
  it('covers every field a cookbook sets as a setting default', () => {
    const covered = new Set(
      Object.values(SETTING_TARGETS)
        .flat()
        .map((t) => `${t.model}.${t.field}`),
    );
    const settingFields = new Set([
      'currency',
      'terms',
      'paymentTerms',
      'taxRate',
    ]);
    for (const cookbook of libraryCookbooks) {
      for (const row of cookbook.document.policies) {
        if (row.defaultValue === undefined) continue;
        if (!settingFields.has(row.fieldName)) continue;
        expect(
          covered.has(`${row.objectRef}.${row.fieldName}`),
          `${cookbook.id} ${row.objectRef}.${row.fieldName}`,
        ).toBe(true);
      }
    }
  });

  it('reads each cookbook back as the settings it declares', () => {
    for (const cookbook of libraryCookbooks) {
      expect(readSettings(cookbook.document), cookbook.id).toEqual(
        settingsOfCookbook(cookbook.settings),
      );
    }
  });

  it('defaults to USD, no tax and no terms, with no rows', () => {
    const empty = new CookbookStore().snapshot();
    expect(readSettings(empty)).toEqual(DEFAULT_SETTINGS);
    // Only Invoice's own CAD default needs an explicit USD row.
    expect(
      writeSettings(empty, DEFAULT_SETTINGS).policies.map(
        (r) => `${r.objectRef}.${r.fieldName}`,
      ),
    ).toEqual([`${C}Invoice.currency`]);
  });

  it('round-trips written settings and rewrites cleanly', () => {
    const base = bakery().document;
    const settings = { currency: 'EUR', taxRate: 0.2, paymentTerms: 'Net 30' };
    const written = writeSettings(base, settings);
    expect(readSettings(written)).toEqual(settings);
    expect(writeSettings(written, settings)).toEqual(written);
    // Unrelated rows survive.
    const hidden = (b: Cookbook) =>
      b.policies.filter((r) => r.visibility === 'hidden');
    expect(hidden(written)).toEqual(hidden(base));
  });

  it('removes rows when a value is cleared or back to the default', () => {
    const base = bakery().document;
    const cleared = writeSettings(base, {
      currency: 'USD',
      taxRate: 0,
      paymentTerms: '',
    });
    expect(
      cleared.policies.some(
        (r) => r.fieldName === 'terms' || r.fieldName === 'paymentTerms',
      ),
    ).toBe(false);
    expect(readSettings(cleared)).toEqual(DEFAULT_SETTINGS);
  });

  it('leaves the cookbook data untouched when applied with overrides', () => {
    const cookbook = bakery();
    const before = JSON.stringify(cookbook);
    const store = new CookbookStore();
    const result = applyLibraryCookbook(cookbook, store, {
      currency: 'GBP',
      taxRate: 0.2,
      paymentTerms: 'Net 30',
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(cookbook)).toBe(before);
    expect(store.settings()).toEqual({
      currency: 'GBP',
      taxRate: 0.2,
      paymentTerms: 'Net 30',
    });
    expect(defaultOf('Invoice', 'currency')).toBe('GBP');
    expect(defaultOf('Order', 'terms')).toBe('Net 30');
    expect(defaultOf('InvoiceLineItem', 'taxRate')).toBe(0.2);
    // Re-applying without edits resets to the cookbook's own values.
    applyLibraryCookbook(cookbook, store);
    expect(store.settings()).toEqual(settingsOfCookbook(cookbook.settings));
  });

  it('the store writes rows new records default to, and removing them reverts', () => {
    const store = new CookbookStore();
    applyLibraryCookbook(bakery(), store);
    store.setSettings({
      currency: 'CAD',
      taxRate: 0.05,
      paymentTerms: 'Net 60',
    });
    expect(defaultOf('Invoice', 'currency')).toBe('CAD');
    expect(defaultOf('Order', 'currency')).toBe('CAD');
    expect(defaultOf('WholesaleOrder', 'terms')).toBe('Net 60');
    expect(defaultOf('Customer', 'paymentTerms')).toBe('Net 60');
    expect(defaultOf('InvoiceLineItem', 'taxRate')).toBe(0.05);

    store.setSettings(DEFAULT_SETTINGS);
    expect(defaultOf('Invoice', 'currency')).toBe('USD');
    expect(defaultOf('Order', 'terms') ?? '').toBe('');
    expect(defaultOf('InvoiceLineItem', 'taxRate')).toBe(0);
    expect(
      store.snapshot().policies.some((r) => r.defaultValue !== undefined),
    ).toBe(
      true, // only the Invoice USD-over-CAD override remains
    );
    expect(store.settings()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('settings follow recipe changes', () => {
  it('a recipe added later starts with the app currency; removing all keeps it', () => {
    const store = new CookbookStore();
    recipeState.add('commerce.sales');
    store.setSettings({
      currency: 'CAD',
      taxRate: 0.05,
      paymentTerms: 'Net 30',
    });
    expect(defaultOf('Order', 'currency')).toBe('CAD');
    recipeState.add('commerce.invoicing');
    expect(defaultOf('Invoice', 'currency')).toBe('CAD');
    expect(defaultOf('InvoiceLineItem', 'taxRate')).toBe(0.05);

    recipeState.remove('commerce.invoicing', 'commerce.sales');
    recipeState.ids = [];
    recipeState.remove();
    expect(store.settings()).toEqual({
      currency: 'CAD',
      taxRate: 0.05,
      paymentTerms: 'Net 30',
    });
    recipeState.add('commerce.invoicing');
    expect(defaultOf('Invoice', 'currency')).toBe('CAD');
    expect(defaultOf('Invoice', 'terms')).toBe('Net 30');
  });

  it('survives an export and import', () => {
    const store = new CookbookStore();
    store.setSettings({ currency: 'EUR', taxRate: 0, paymentTerms: '' });
    const again = new CookbookStore();
    expect(again.importText(JSON.stringify(store.snapshot())).ok).toBe(true);
    expect(again.settings().currency).toBe('EUR');
  });
});
