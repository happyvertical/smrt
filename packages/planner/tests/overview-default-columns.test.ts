import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { recordLabel } from '../src/lib/data/labels.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { plannerLoaders } from '../src/lib/overviews/registry.ts';
import { isDiscriminatorField } from '../src/lib/recipes/policy.ts';

const context = () => ({
  source: createMemoryDataSource(),
  sections: [],
  entryIndex: new Map(),
  href: (path: string) => path,
  overviewId: 'test.defaults',
  locale: 'en-US',
});

const stock = '@happyvertical/smrt-inventory:StockLevel';

describe('default overview record columns (#4184)', () => {
  it('shows stock identity, quantities and reorder context rather than only state', async () => {
    const data = await plannerLoaders.records({ model: stock }, context());
    expect(data.columns?.map((column) => column.key)).toEqual([
      'skuId',
      'locationId',
      'state',
      'qty',
      'reorderPoint',
      'reorderQuantity',
    ]);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows[0]?.cells?.qty).toEqual(expect.any(Number));
    expect(data.columns?.some((column) => column.key === 'tenantId')).toBe(
      false,
    );
  });

  it('resolves SKU and location labels and omits the current parent reference', async () => {
    const ctx = context();
    const model = getModelByQualifiedName(stock)?.model;
    if (!model) throw new Error('StockLevel missing');
    const raw = (await ctx.source.list(model))[0];
    if (!raw) throw new Error('StockLevel sample missing');
    const data = await plannerLoaders.records({ model: stock }, ctx);
    for (const key of ['skuId', 'locationId']) {
      const field = model.fields.find((field) => field.name === key);
      const related =
        field?.related && getModelByQualifiedName(field.related)?.model;
      if (!related) throw new Error(`missing relation ${key}`);
      const target = await ctx.source.get(related, String(raw[key]));
      if (!target) throw new Error(`missing sample ${key}`);
      const label = await recordLabel(ctx.source, related, target);
      expect(data.rows[0]?.cells?.[key]).toBe(label);
      expect(data.rows[0]?.cells?.[key]).not.toBe(raw[key]);
    }
    const parent = await plannerLoaders.records(
      { model: stock, filter: 'parent', field: 'locationId' },
      { ...ctx, record: { model: stock, id: String(raw.locationId) } },
    );
    expect(parent.columns?.map((column) => column.key)).not.toContain(
      'locationId',
    );
    expect(parent.columns?.map((column) => column.key)).toContain('qty');
  });

  it('keeps explicit custom fields authoritative, including their order', async () => {
    const data = await plannerLoaders.records(
      { model: stock, columns: 'qty,state' },
      context(),
    );
    expect(data.columns?.map((column) => column.key)).toEqual(['qty', 'state']);
  });

  it.each([
    '@happyvertical/smrt-commerce:Invoice',
    '@happyvertical/smrt-commerce:Payment',
    '@happyvertical/smrt-products:Product',
    '@happyvertical/smrt-commerce:ProductionOrder',
  ])('uses only supported business fields for %s', async (id) => {
    const found = getModelByQualifiedName(id);
    expect(found).toBeDefined();
    if (!found) throw new Error(id);
    const data = await plannerLoaders.records({ model: id }, context());
    expect(data.columns?.length).toBeGreaterThan(1);
    for (const column of data.columns ?? []) {
      const field = found.model.fields.find(
        (field) => field.name === column.key,
      );
      expect(field).toBeDefined();
      expect(field?.system).not.toBe(true);
      if (field) expect(isDiscriminatorField(found.model, field)).toBe(false);
      expect(field?.type).not.toBe('json');
    }
  });
});
