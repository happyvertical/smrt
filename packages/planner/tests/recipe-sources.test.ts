import { describe, expect, it } from 'vitest';
import { extractPackage } from '../src/lib/catalog/generate/extract.ts';
import { catalog } from '../src/lib/catalog/index.ts';
import { libraryCookbooks } from '../src/lib/library/index.ts';
import { recipes, recipesById } from '../src/lib/recipes/index.ts';
import { mergeRecipes } from '../src/lib/recipes/merge.ts';
import overlay from '../src/lib/recipes/overlay.json';
import type { Recipe } from '../src/lib/recipes/types.ts';

const upstream = catalog.packages.flatMap((pkg) => pkg.recipes ?? []);

const stub = (id: string): Recipe => ({
  id,
  label: id,
  summary: '',
  synonyms: [],
  models: [],
  nav: [],
  requires: [],
});

describe('catalog recipes', () => {
  it('carries the recipes each package declares', () => {
    expect(upstream.length).toBeGreaterThan(0);
    for (const pkg of catalog.packages) {
      for (const recipe of pkg.recipes ?? []) {
        expect(recipe.id.split('.')[0]).toBe(pkg.id);
      }
    }
  });

  it('extracts recipes from the knowledge artifact, else the manifest', () => {
    const base = {
      packageName: '@happyvertical/smrt-demo',
      version: '1.0.0',
      description: '',
    };
    const manifest = { packageName: base.packageName, objects: {} };
    const recipe = { id: 'demo.one', className: 'OneRecipe', label: 'One' };
    const fromManifest = extractPackage({
      ...base,
      manifest: { ...manifest, recipes: [recipe, { nope: true }] },
      knowledge: null,
    });
    expect(fromManifest.recipes).toEqual([{ id: 'demo.one', label: 'One' }]);
    const fromKnowledge = extractPackage({
      ...base,
      manifest: { ...manifest, recipes: [stub('demo.manifest')] },
      knowledge: { recipes: [recipe] },
    });
    expect(fromKnowledge.recipes?.map((r) => r.id)).toEqual(['demo.one']);
    expect(extractPackage({ ...base, manifest, knowledge: null }).recipes).toBe(
      undefined,
    );
  });
});

describe('recipe overlay', () => {
  it('merges local forms over the upstream recipe and pins the order', () => {
    const merged = mergeRecipes([stub('a.x'), stub('a.y'), stub('a.z')], {
      order: ['a.y', 'a.x'],
      recipes: { 'a.x': { forms: [] } },
    });
    expect(merged.map((r) => r.id)).toEqual(['a.y', 'a.x', 'a.z']);
    expect(merged[1].forms).toEqual([]);
    expect(merged[0].forms).toBeUndefined();
  });

  it('fails when a recipe exists only locally', () => {
    expect(() =>
      mergeRecipes([stub('a.x')], {
        order: ['a.x'],
        recipes: { 'a.ghost': {} },
      }),
    ).toThrow(/a\.ghost/);
    expect(() =>
      mergeRecipes([stub('a.x')], { order: ['a.ghost'], recipes: {} }),
    ).toThrow(/a\.ghost/);
  });

  it('has no overlay entry without an upstream recipe, and holds only local parts', () => {
    const ids = new Set(upstream.map((r) => r.id));
    for (const [id, entry] of Object.entries(overlay.recipes)) {
      expect(ids.has(id)).toBe(true);
      expect(
        Object.keys(entry).every((k) => ['forms', 'extends'].includes(k)),
      ).toBe(true);
    }
    expect(overlay.order.every((id) => ids.has(id))).toBe(true);
    expect(recipes).toHaveLength(upstream.length);
  });
});

describe('cookbook recipes', () => {
  it('resolves every recipe the library cookbooks reference', () => {
    expect(libraryCookbooks.length).toBeGreaterThan(0);
    for (const cookbook of libraryCookbooks) {
      for (const id of cookbook.document.recipes ?? []) {
        expect(recipesById.has(id), `${cookbook.id}: ${id}`).toBe(true);
      }
    }
  });
});
