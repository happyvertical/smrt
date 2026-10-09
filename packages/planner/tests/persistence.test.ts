import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  clearStoredData,
  createMemoryDataSource,
} from '../src/lib/data/source.ts';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const found = getModelByQualifiedName('@happyvertical/smrt-products:Product');
if (!found) throw new Error('Product');
const product = found.model;

describe('persisted rows', () => {
  it('keep added, edited and deleted rows across a reload', async () => {
    const storage = new MemoryStorage();
    const first = createMemoryDataSource({ storage });
    const rows = await first.list(product);
    const added = await first.create(product, { name: 'Added' });
    await first.update(product, rows[0]?.id as string, { name: 'Edited' });
    await first.delete(product, rows[1]?.id as string);

    const second = createMemoryDataSource({ storage });
    const again = await second.list(product);
    expect(again).toHaveLength(rows.length);
    expect(again.some((r) => r.id === added.id)).toBe(true);
    expect(again.find((r) => r.id === rows[0]?.id)?.name).toBe('Edited');
    expect(again.some((r) => r.id === rows[1]?.id)).toBe(false);
    // A new row after reload does not reuse an earlier new id.
    const next = await second.create(product, { name: 'Next' });
    expect(next.id).not.toBe(added.id);
  });

  it('start from the samples again after a reset', async () => {
    const storage = new MemoryStorage();
    const data = createMemoryDataSource({ storage });
    const before = (await data.list(product)).length;
    await data.create(product, { name: 'Gone' });
    data.reset?.();
    expect(storage.length).toBe(0);
    expect(await data.list(product)).toHaveLength(before);
  });

  it('survive unreadable or refused storage', async () => {
    const storage = new MemoryStorage();
    storage.setItem(`smrt-planner:data:v1:${product.id}`, '{nope');
    const data = createMemoryDataSource({ storage });
    expect((await data.list(product)).length).toBeGreaterThan(0);
    const refusing = {
      ...storage,
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    } as unknown as Storage;
    const quiet = createMemoryDataSource({ storage: refusing });
    await expect(quiet.create(product, { name: 'x' })).resolves.toBeDefined();
    expect(() => clearStoredData(refusing)).not.toThrow();
  });
});
