import { describe, expect, it } from 'vitest';
import { assembleCatalog } from '../src/lib/catalog/generate/build.ts';
import type { RawPackage } from '../src/lib/catalog/generate/extract.ts';
import { catalog } from '../src/lib/catalog/index.ts';
import type { CatalogField } from '../src/lib/catalog/types.ts';
import {
  type FeatureEntry,
  featureEntries,
  featureSummary,
  filterFeatures,
  visibleFeatures,
} from '../src/lib/recipes/features.ts';
import { childModels, plumbingReason } from '../src/lib/recipes/plumbing.ts';

const text = (name: string): CatalogField => ({
  name,
  type: 'text',
  required: false,
});
const ref = (name: string): CatalogField => ({
  name,
  type: 'foreignKey',
  required: false,
  related: 'X',
});
const model = (name: string, fields: CatalogField[], extendsId?: string) => ({
  name,
  fields,
  ...(extendsId ? { extends: extendsId } : {}),
});

describe('plumbingReason', () => {
  it('flags junction bases', () => {
    expect(
      plumbingReason(model('X', [text('a')], '@p/smrt-a:SmrtJunction')),
    ).toBe('junction');
  });

  it('flags link tables but not models with two refs and real content', () => {
    expect(plumbingReason(model('GroupMember', [ref('a'), ref('b')]))).toBe(
      'link',
    );
    expect(
      plumbingReason(model('Membership', [ref('a'), ref('b'), text('s')])),
    ).toBe('link');
    expect(
      plumbingReason(
        model('Folder', [ref('a'), ref('b'), text('n'), text('d')]),
      ),
    ).toBeNull();
  });

  it('flags child records by suffix', () => {
    for (const name of [
      'AssetMetafield',
      'AssetAssociation',
      'InvoiceLineItem',
      'PaymentAllocation',
    ]) {
      expect(
        plumbingReason(
          model(name, [text('a'), text('b'), text('c'), text('d')]),
        ),
      ).toBe('child');
    }
  });

  it('flags tiny lookups only', () => {
    expect(plumbingReason(model('PlaceType', [text('name')]))).toBe('lookup');
    expect(
      plumbingReason(
        model('EventType', [text('a'), text('b'), text('c'), text('d')]),
      ),
    ).toBeNull();
    expect(plumbingReason(model('Invoice', [text('a')]))).toBeNull();
  });

  it('ignores system fields when counting', () => {
    const sys = { ...text('id'), system: true };
    expect(
      plumbingReason(
        model('AssetStatus', [sys, text('a'), text('b'), text('c')]),
      ),
    ).toBe('lookup');
  });
});

describe('catalog classification', () => {
  const entries = featureEntries(catalog, []);

  it('hides some but not most models, and keeps known features', () => {
    const plumbing = entries.filter((e) => e.plumbing);
    expect(plumbing.length).toBeGreaterThan(10);
    expect(plumbing.length).toBeLessThan(entries.length / 2);
    const byName = (n: string) => entries.find((e) => e.name === n);
    expect(byName('RolePermission')?.plumbing).toBe(true);
    expect(byName('InvoiceLineItem')?.plumbing).toBe(true);
    expect(byName('Invoice')?.plumbing).toBe(false);
    expect(byName('Folder')?.plumbing).toBe(false);
  });
});

describe('visibleFeatures and search', () => {
  const entry = (name: string, plumbing: boolean): FeatureEntry => ({
    id: `@p/smrt-a:${name}`,
    name,
    label: name,
    packageId: 'a',
    description: '2 fields',
    described: false,
    plumbing,
    fieldNames: [],
    includes: [],
  });
  const all = [entry('Invoice', false), entry('InvoiceLineItem', true)];

  it('shows features only by default and everything with Show all', () => {
    expect(visibleFeatures(all, false).map((e) => e.name)).toEqual(['Invoice']);
    expect(visibleFeatures(all, true)).toHaveLength(2);
  });

  it('searches the visible pool, so Show all widens the search', () => {
    expect(filterFeatures(visibleFeatures(all, false), 'lineitem')).toEqual([]);
    expect(filterFeatures(visibleFeatures(all, true), 'lineitem')).toHaveLength(
      1,
    );
  });
});

describe('descriptions', () => {
  it('renders the description alone, else Package · N fields', () => {
    const base = {
      id: 'x',
      name: 'Invoice',
      label: 'Invoice',
      packageId: 'commerce',
      plumbing: false,
      fieldNames: [],
      includes: [],
    };
    expect(
      featureSummary({
        ...base,
        description: 'Bills a customer.',
        described: true,
      }),
    ).toBe('Bills a customer.');
    expect(
      featureSummary({ ...base, description: '3 fields', described: false }),
    ).toBe('Commerce · 3 fields');
  });

  it('takes the first sentence of a catalog description', () => {
    const cat = structuredClone(catalog);
    const target = cat.packages[0].models.find((m) => m.exposed);
    if (!target) throw new Error('no exposed model');
    target.description = 'Bills a customer. Has many lines.';
    const hit = featureEntries(cat, []).find((e) => e.described);
    expect(hit?.description).toBe('Bills a customer.');
  });
});

describe('generator passthrough', () => {
  const raw = (description?: string): RawPackage => ({
    packageName: '@happyvertical/smrt-shop',
    version: '1.0.0',
    description: 'A shop',
    knowledge: null,
    manifest: {
      packageName: '@happyvertical/smrt-shop',
      objects: {
        '@happyvertical/smrt-shop:Item': {
          className: 'Item',
          qualifiedName: '@happyvertical/smrt-shop:Item',
          collection: 'items',
          ...(description === undefined ? {} : { description }),
          fields: { name: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        },
      },
    },
  });

  it('carries a trimmed model description into the catalog', () => {
    const built = assembleCatalog([raw('  A thing for sale.  ')], 'file:///x');
    expect(built.packages[0].models[0].description).toBe('A thing for sale.');
  });

  it('omits the key when there is no description', () => {
    for (const d of [undefined, '   ']) {
      const model = assembleCatalog([raw(d)], 'r').packages[0].models[0];
      expect('description' in model).toBe(false);
    }
  });

  it('drops excluded packages without network access', () => {
    const core = { ...raw(), packageName: '@happyvertical/smrt-core' };
    expect(assembleCatalog([core], 'r').packages).toEqual([]);
  });
});

describe('childModels', () => {
  const names = (id: string) =>
    childModels(catalog, id)
      .map((m) => m.name)
      .sort();
  const COMMERCE = '@happyvertical/smrt-commerce:';

  it('finds line items through the STI parent', () => {
    expect(names(`${COMMERCE}Contract`)).toContain('ContractLineItem');
    for (const order of ['ProductionOrder', 'WholesaleOrder', 'Order']) {
      expect(names(`${COMMERCE}${order}`)).toContain('ContractLineItem');
    }
  });

  it('finds direct children and excludes lookups and the model itself', () => {
    expect(names(`${COMMERCE}Invoice`)).toEqual(
      expect.arrayContaining(['InvoiceLineItem', 'PaymentAllocation']),
    );
    expect(names(`${COMMERCE}Invoice`)).not.toContain('Invoice');
    expect(names(`${COMMERCE}Vendor`)).not.toContain('Contract');
  });

  it('is empty for unknown models', () => {
    expect(childModels(catalog, 'nope:Nope')).toEqual([]);
  });
});
