import { describe, expect, it } from 'vitest';
import { EXCLUDED_PACKAGES } from '../src/lib/catalog/generate/exclusions.ts';
import {
  catalog,
  exposedModels,
  getModel,
  getPackage,
  searchPackages,
} from '../src/lib/catalog/index.ts';

describe('committed catalog', () => {
  it('is sorted, unique and free of documented exclusions', () => {
    const ids = catalog.packages.map((p) => p.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const excluded of Object.keys(EXCLUDED_PACKAGES)) {
      expect(ids).not.toContain(excluded);
    }
  });

  it('includes the headline packages with real models', () => {
    for (const id of ['products', 'inventory', 'sales', 'tags']) {
      const pkg = getPackage(id);
      expect(pkg, id).toBeDefined();
      expect(
        exposedModels(pkg as NonNullable<typeof pkg>).length,
      ).toBeGreaterThan(0);
    }
  });

  it('only depends on packages that are in the catalog', () => {
    const ids = new Set(catalog.packages.map((p) => p.id));
    for (const pkg of catalog.packages) {
      for (const dependency of pkg.dependencies) {
        expect(ids.has(dependency), `${pkg.id} -> ${dependency}`).toBe(true);
      }
      expect(pkg.dependencies).not.toContain(pkg.id);
    }
  });

  it('carries generated surfaces and an integer money field', () => {
    const product = getModel('products', 'Product');
    expect(product?.rest.some((r) => r.method === 'GET')).toBe(true);
    expect(product?.mcp.length).toBeGreaterThan(0);
    expect(product?.fields.find((f) => f.name === 'price')?.type).toBe(
      'integer',
    );
  });

  it('searches names, models and fields', () => {
    expect(searchPackages(catalog.packages, 'sku').map((p) => p.id)).toContain(
      'products',
    );
    expect(searchPackages(catalog.packages, 'zzzzzz')).toEqual([]);
    expect(searchPackages(catalog.packages, '')).toHaveLength(
      catalog.packages.length,
    );
  });
});
