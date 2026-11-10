import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '../src/lib/catalog/index.ts';
import { parseHostReply } from '../src/lib/core/reply.ts';
import { getSamplePack, setSamplePack } from '../src/lib/data/packs.ts';
import {
  applySampleContext,
  clearSampleContext,
  getSampleContext,
  parseSampleContext,
  SAMPLE_CONTEXT_KEY,
} from '../src/lib/data/sample-context.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';

vi.mock('../src/lib/planner/workspace-storage.ts', () => ({
  workspaceStorage: () => globalThis.sessionStorage,
}));

const context = (name = 'Complete skateboard') => ({
  provenance: 'fictional',
  products: [
    {
      name,
      description: `Fictional sample ${name}`,
      price: 12500,
      category: 'Equipment',
    },
  ],
  customers: ['Sample skater Avery'],
  vendors: ['Fictional Deck Workshop'],
});
describe('business sample context', () => {
  const saved = new Map<string, string>();
  beforeEach(() => {
    saved.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
      clear: () => saved.clear(),
    });
    clearSampleContext();
    setSamplePack(null);
  });
  afterEach(() => {
    clearSampleContext();
    vi.unstubAllGlobals();
  });
  it('uses inferred vocabulary for any domain without a keyword pack', () => {
    expect(applySampleContext(context('Cryogenic sample rack'))).toBe(true);
    expect(getSamplePack().products[0]?.name).toBe('Cryogenic sample rack');
    expect(getSamplePack().vendors).toEqual(context().vendors);
    expect(JSON.parse(saved.get(SAMPLE_CONTEXT_KEY) ?? 'null')).toEqual(
      context('Cryogenic sample rack'),
    );
  });
  it('preserves the initial vocabulary on retries and feature followups', () => {
    expect(applySampleContext(context())).toBe(true);
    expect(applySampleContext(context())).toBe(false);
    expect(applySampleContext(context('Unrelated mug'))).toBe(false);
    expect(getSamplePack().products[0]?.name).toBe('Complete skateboard');
  });
  it('hydrates stored context before sample generation', () => {
    saved.set(
      SAMPLE_CONTEXT_KEY,
      JSON.stringify(context('Skateboard bearing set')),
    );
    expect(getSampleContext()?.products[0]?.name).toBe(
      'Skateboard bearing set',
    );
    expect(getSamplePack().products[0]?.price).toBe(12500);
  });
  it.each([
    { ...context(), provenance: 'real' },
    { ...context(), surprise: true },
    { ...context(), products: [] },
    { ...context(), customers: Array(9).fill('Name') },
    { ...context(), products: Array(17).fill(context().products[0]) },
    { ...context(), vendors: ['x'.repeat(161)] },
    { ...context(), products: [{ ...context().products[0], price: 1.5 }] },
    {
      ...context(),
      products: [{ ...context().products[0], description: 'x'.repeat(401) }],
    },
  ])('rejects malformed or oversized context atomically', (value) => {
    expect(parseSampleContext(value)).toBeUndefined();
    expect(applySampleContext(value)).toBe(false);
    expect(saved.size).toBe(0);
  });
  it('preserves known library samples and clears context on explicit reset', () => {
    applySampleContext(context());
    setSamplePack('bakery');
    expect(getSamplePack().id).toBe('bakery');
    clearSampleContext();
    setSamplePack(null);
    expect(getSamplePack().id).toBe('generic');
  });
  it('keeps existing and manually edited rows on followups and resets explicitly', async () => {
    const product = getModel('products', 'Product');
    if (!product) throw new Error('Product missing');
    applySampleContext(context());
    const source = createMemoryDataSource({ rowsPerModel: 2 });
    const initial = await source.list(product);
    expect(initial[0]?.name).toBe('Complete skateboard');
    await source.update(product, initial[0].id, { name: 'My custom deck' });
    const before = await source.list(product);
    applySampleContext(context('Unrelated mug'));
    expect(await source.list(product)).toEqual(before);
    source.reset?.();
    expect(getSampleContext()).toBeUndefined();
    expect((await source.list(product))[0]?.name).toBe('Canvas tote');
  });
  it('generates each contextual descriptor once and preserves persisted manual rows', async () => {
    const product = getModel('products', 'Product');
    if (!product) throw new Error('Product missing');
    const vocabulary = {
      ...context(),
      products: Array.from({ length: 5 }, (_, i) => ({
        ...context().products[0],
        name: `Fictional item ${i}`,
        category: `Category ${i}`,
      })),
    };
    applySampleContext(vocabulary);
    const storage = {
      get length() {
        return saved.size;
      },
      key: (i: number) => [...saved.keys()][i] ?? null,
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
      clear: () => saved.clear(),
    } as Storage;
    const source = createMemoryDataSource({ storage });
    const rows = await source.list(product);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.name)).size).toBe(5);
    expect(rows.map((row) => row.category)).toEqual(
      vocabulary.products.map((p) => p.category),
    );
    await source.update(product, rows[0].id, { name: 'Edited by the visitor' });
    const before = await source.list(product);
    applySampleContext(context('Replacement ignored'));
    expect(await createMemoryDataSource({ storage }).list(product)).toEqual(
      before,
    );
    source.reset?.();
    expect(await source.list(product)).toHaveLength(8);
  });

  it('roundtrips context through the typed host reply parser', () => {
    expect(
      parseHostReply(
        JSON.stringify({ reply: 'Ready', sampleContext: context() }),
      ).reply.sampleContext,
    ).toEqual(context());
    expect(
      parseHostReply(
        JSON.stringify({
          reply: 'Ready',
          sampleContext: { ...context(), provenance: 'real' },
        }),
      ).reply.sampleContext,
    ).toBeUndefined();
  });
});
