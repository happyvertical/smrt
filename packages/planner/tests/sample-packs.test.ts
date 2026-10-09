import { afterEach, describe, expect, it } from 'vitest';
import { catalog, getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { fakeRecords } from '../src/lib/data/fakes.ts';
import {
  COOKBOOK_PACKS,
  GENERIC_PACK,
  getSamplePack,
  setSamplePack,
} from '../src/lib/data/packs.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { catalogModels } from '../src/lib/forms/shared.ts';
import { stockSamples } from '../src/lib/forms/stock.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import {
  getLibraryCookbook,
  libraryCookbooks,
} from '../src/lib/library/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { childLinks } from '../src/lib/recipes/plumbing.ts';

const model = (name: string) => {
  const found = getModelByQualifiedName(name);
  if (!found) throw new Error(`${name} missing`);
  return found.model;
};
const C = '@happyvertical/smrt-commerce:';
const P = '@happyvertical/smrt-products:';

function source() {
  return createMemoryDataSource({
    samples: stockSamples(catalogModels),
    empty: [
      '@happyvertical/smrt-products:ProductVariant',
      '@happyvertical/smrt-profiles:ProfileType',
    ],
    children: {
      models: catalog.packages.flatMap((p) => p.models),
      links: (id) => childLinks(catalog, recipes, id),
    },
  });
}

const names = async (ds: ReturnType<typeof source>, id: string) =>
  (await ds.list(model(id))).map((r) => String(r.name));

afterEach(() => setSamplePack(null));

describe('sample packs', () => {
  it('ship one per cookbook, each with the vocabulary it needs', () => {
    expect(Object.keys(COOKBOOK_PACKS).sort()).toEqual(
      libraryCookbooks.map((c) => c.id).sort(),
    );
    for (const pack of Object.values(COOKBOOK_PACKS)) {
      expect(pack.products.length, pack.id).toBeGreaterThanOrEqual(8);
      expect(pack.customers, pack.id).toHaveLength(8);
      expect(pack.vendors, pack.id).toHaveLength(5);
      expect(pack.notes?.length, pack.id).toBeGreaterThan(0);
      expect(pack.locations?.length, pack.id).toBeGreaterThanOrEqual(2);
      for (const p of pack.products) {
        expect(Number.isInteger(p.price), `${pack.id} ${p.name}`).toBe(true);
      }
    }
  });

  it('start generic, and an unknown cookbook falls back to it', () => {
    expect(getSamplePack()).toBe(GENERIC_PACK);
    expect(setSamplePack('nope')).toBe(GENERIC_PACK);
  });

  it('are deterministic', async () => {
    setSamplePack('bakery');
    expect(await names(source(), `${P}Product`)).toEqual(
      await names(source(), `${P}Product`),
    );
  });

  it('bakery names breads, cafes, mills and its three places', async () => {
    setSamplePack('bakery');
    const ds = source();
    const products = await names(ds, `${P}Product`);
    expect(products).toContain('Sourdough loaf');
    expect(products).toContain('Bread flour, 25 kg');
    const profiles = await names(ds, '@happyvertical/smrt-profiles:Profile');
    expect(profiles).toContain('Corner Café');
    expect(profiles).toContain('Stonemill Flour Co.');
    expect(
      await names(ds, '@happyvertical/smrt-inventory:InventoryLocation'),
    ).toEqual(['Front counter', 'Walk-in cooler', 'Dry store']);
    // Ingredients are materials, counted in the dry store or cooler.
    const rows = await ds.list(model(`${P}Product`));
    const flour = rows.find((r) => r.name === 'Bread flour, 25 kg');
    expect(flour?.productType).toBe('material');
    expect(flour?.category).toBe('Ingredient');
  });

  it.each([
    ['mechanic', 'Brake pads, front set', 'Dana Whitfield', 'Oil change'],
    [
      'welder',
      'Flat bar 50 x 6 mm, 6 m',
      'Ridgeline Construction',
      'Site measure',
    ],
    ['yoga-studio', 'Cork yoga mat', 'Emma Larsen', 'Vinyasa'],
  ])('%s generates its own products, people and event types', async (id, product, customer, eventType) => {
    setSamplePack(id);
    const ds = source();
    expect(await names(ds, `${P}Product`)).toContain(product);
    expect(await names(ds, '@happyvertical/smrt-profiles:Profile')).toContain(
      customer,
    );
    expect(await names(ds, '@happyvertical/smrt-events:EventType')).toContain(
      eventType,
    );
  });

  it('give line items the pack’s own lines', () => {
    setSamplePack('welder');
    const lines = fakeRecords(model(`${C}InvoiceLineItem`), 20);
    const known = new Set(
      COOKBOOK_PACKS.welder?.lines?.map((l) => l.description),
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(known.has(String(l.description))).toBe(true);
  });

  it('use the pack’s notes and terms', () => {
    setSamplePack('welder');
    const orders = fakeRecords(model(`${C}Order`), 12);
    const terms = new Set(COOKBOOK_PACKS.welder?.terms);
    for (const o of orders) expect(terms.has(String(o.terms))).toBe(true);
  });

  it('weight statuses where the pack says so', () => {
    setSamplePack('mechanic');
    const events = fakeRecords(model('@happyvertical/smrt-events:Event'), 60);
    const count = (s: string) => events.filter((e) => e.status === s).length;
    expect(count('scheduled')).toBeGreaterThan(count('cancelled'));
    expect(
      events.every((e) =>
        ['scheduled', 'completed', 'cancelled'].includes(String(e.status)),
      ),
    ).toBe(true);
  });

  it('applying a cookbook switches the pack; the generic pack comes back', () => {
    const store = new CookbookStore();
    for (const cookbook of libraryCookbooks) {
      expect(applyLibraryCookbook(cookbook, store).ok).toBe(true);
      expect(getSamplePack().id).toBe(cookbook.id);
    }
    const welder = getLibraryCookbook('welder');
    if (!welder) throw new Error('no welder');
    applyLibraryCookbook(welder, store);
    expect(fakeRecords(model(`${P}Product`), 1)[0]?.name).toBe(
      COOKBOOK_PACKS.welder?.products[0]?.name,
    );
    setSamplePack(null);
    expect(fakeRecords(model(`${P}Product`), 1)[0]?.name).toBe('Canvas tote');
  });

  it('reset regenerates rows from the active pack', async () => {
    const ds = source();
    expect(await names(ds, `${P}Product`)).toContain('Canvas tote');
    setSamplePack('yoga-studio');
    ds.reset?.();
    const after = await names(ds, `${P}Product`);
    expect(after).toContain('Cork yoga mat');
    expect(after).not.toContain('Canvas tote');
  });
});
