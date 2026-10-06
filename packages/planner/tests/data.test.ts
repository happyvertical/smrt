import { describe, expect, it } from 'vitest';
import { getModel } from '../src/lib/catalog/index.ts';
import { fakeRecords, isMoneyField } from '../src/lib/data/fakes.ts';
import { formatMoney, parseMoney } from '../src/lib/data/format.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';

const product = getModel('products', 'Product');
if (!product) throw new Error('Product missing from catalog');
const price = product.fields.find((f) => f.name === 'price');
if (!price) throw new Error('price missing');

describe('seeded fakes', () => {
  it('are deterministic per seed', () => {
    expect(fakeRecords(product, 5, 7)).toEqual(fakeRecords(product, 5, 7));
    expect(fakeRecords(product, 5, 7)).not.toEqual(fakeRecords(product, 5, 8));
  });

  it('use integer minor units for money and match field types', () => {
    expect(isMoneyField(price)).toBe(true);
    for (const row of fakeRecords(product, 20)) {
      expect(Number.isInteger(row.price)).toBe(true);
      expect(typeof row.inStock).toBe('boolean');
      expect(typeof row.name).toBe('string');
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('formats and parses money', () => {
    expect(formatMoney(1999)).toBe('$19.99');
    expect(parseMoney('19.99')).toBe(1999);
    expect(parseMoney('abc')).toBe(0);
  });
});

describe('memory data source', () => {
  it('supports create, update and delete without sharing references', async () => {
    const source = createMemoryDataSource({ rowsPerModel: 3 });
    const rows = await source.list(product);
    expect(rows).toHaveLength(3);
    const created = await source.create(product, {
      name: 'Widget',
      price: 500,
    });
    expect(await source.get(product, created.id)).toMatchObject({ price: 500 });
    await source.update(product, created.id, { price: 750 });
    expect((await source.get(product, created.id))?.price).toBe(750);
    expect(await source.delete(product, created.id)).toBe(true);
    expect(await source.get(product, created.id)).toBeUndefined();
    expect(await source.delete(product, created.id)).toBe(false);
  });
});
