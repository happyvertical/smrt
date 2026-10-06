import { beforeEach, describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import { selection } from '../src/lib/planner/selection.svelte.ts';
import {
  normalize,
  parseSelection,
  requiredBy,
  selectionQuery,
  withDependencies,
} from '../src/lib/planner/selection.ts';

const packages = new Map(catalog.packages.map((p) => [p.id, p]));
const known = new Set(packages.keys());

describe('selection url', () => {
  it('round-trips and ignores unknown or duplicate ids', () => {
    expect(selectionQuery([])).toBe('');
    expect(selectionQuery(['sales', 'products'])).toBe('?p=products,sales');
    expect(parseSelection('?p=sales,nope,products,sales', known)).toEqual([
      'products',
      'sales',
    ]);
    expect(normalize(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('dependencies', () => {
  it('pulls in transitive dependencies', () => {
    const result = withDependencies(['manufacturing'], packages);
    expect(result).toEqual(expect.arrayContaining(['inventory', 'products']));
    expect(result).toContain('assets');
  });

  it('reports which selected packages need a package', () => {
    expect(
      requiredBy('products', ['manufacturing', 'products'], packages),
    ).toEqual(['manufacturing']);
  });
});

describe('selection store', () => {
  beforeEach(() => selection.clear());

  it('adds with dependencies and keeps required packages on remove', () => {
    selection.add('manufacturing');
    expect(selection.has('products')).toBe(true);
    selection.remove('products');
    expect(selection.has('products')).toBe(true);
    selection.remove('manufacturing');
    selection.remove('products');
    expect(selection.has('products')).toBe(false);
  });

  it('applies an { add, remove } change and ignores unknown ids', () => {
    selection.apply({ add: ['tags', 'bogus'] });
    expect(selection.ids).toEqual(['tags']);
    selection.apply({ remove: ['tags'] });
    expect(selection.ids).toEqual([]);
  });
});
