import { describe, expect, it } from 'vitest';
import {
  catalogFromManifests,
  narrowCatalog,
  packageIdOf,
} from '../catalog.js';
import { resolveCookbookTheme } from '../theme.js';

const recipe = (id: string, model: string) => ({
  id,
  label: id,
  summary: 'bulk',
  synonyms: ['x'],
  help: { markdown: 'bulk', fieldRefs: [] },
  models: [model],
  nav: [{ label: id, model }],
  requires: [],
});

describe('packageIdOf', () => {
  it('strips the smrt scope and prefix', () => {
    expect(packageIdOf('@happyvertical/smrt-commerce')).toBe('commerce');
    expect(packageIdOf('@acme/smrt-shop')).toBe('shop');
    expect(packageIdOf('@acme/shop')).toBe('shop');
    expect(packageIdOf('plain')).toBe('plain');
  });
});

describe('catalogFromManifests', () => {
  const manifests = [
    {
      packageName: '@acme/smrt-shop',
      objects: {
        a: {
          className: 'Item',
          qualifiedName: '@acme/smrt-shop:Item',
          description: ' A thing. ',
          fields: { name: { type: 'text' } },
          decoratorConfig: {},
        },
        b: {
          className: 'ItemCollection',
          qualifiedName: '@acme/smrt-shop:ItemCollection',
          fields: {},
        },
        c: {
          className: 'Hidden',
          qualifiedName: '@acme/smrt-shop:Hidden',
          fields: { name: { type: 'text' }, rows: { type: 'oneToMany' } },
          decoratorConfig: { api: false, mcp: false, cli: false },
        },
      },
      recipes: [
        recipe('shop.items', '@acme/smrt-shop:Item'),
        { id: 'broken' },
        recipe('shop.items', '@acme/smrt-shop:Hidden'),
      ],
    },
    { packageName: '@acme/smrt-empty' },
  ];

  it('keeps models (not collections), exposure and trimmed recipes', () => {
    const catalog = catalogFromManifests(manifests);
    expect(catalog.models).toEqual([
      {
        id: '@acme/smrt-shop:Item',
        name: 'Item',
        packageId: 'shop',
        exposed: true,
        description: 'A thing.',
      },
      {
        id: '@acme/smrt-shop:Hidden',
        name: 'Hidden',
        packageId: 'shop',
        exposed: false,
      },
    ]);
    // Invalid recipes and repeated ids are dropped; bulk fields are not carried.
    expect(catalog.recipes).toEqual([
      {
        id: 'shop.items',
        label: 'shop.items',
        models: ['@acme/smrt-shop:Item'],
        nav: [{ label: 'shop.items', model: '@acme/smrt-shop:Item' }],
        requires: [],
      },
    ]);
  });

  it("narrows to the cookbook's recipes, their models and its features", () => {
    const catalog = catalogFromManifests(manifests);
    expect(
      narrowCatalog(catalog, { recipes: ['shop.items'], features: [] }).models,
    ).toHaveLength(1);
    expect(
      narrowCatalog(catalog, {
        recipes: [],
        features: ['@acme/smrt-shop:Hidden'],
      }),
    ).toMatchObject({
      recipes: [],
      models: [{ id: '@acme/smrt-shop:Hidden' }],
    });
  });
});

describe('resolveCookbookTheme', () => {
  it('defaults to the smrt preset following the system scheme', () => {
    expect(resolveCookbookTheme(undefined)).toEqual({
      preset: 'smrt',
      colorScheme: 'system',
    });
  });

  it('keeps a preset and a scheme', () => {
    expect(
      resolveCookbookTheme({ preset: 'glass', colorScheme: 'dark' }),
    ).toEqual({
      preset: 'glass',
      colorScheme: 'dark',
    });
  });

  it('turns a brand colour into a stable brand theme id and ignores bad input', () => {
    expect(
      resolveCookbookTheme({
        custom: { primary: '#ABC', fontFamily: 'Inter' },
      }),
    ).toEqual({
      preset: 'cookbook-brand-aabbcc-inter',
      colorScheme: 'system',
      brand: { primary: '#aabbcc', fontFamily: 'Inter' },
    });
    expect(
      resolveCookbookTheme({
        preset: 'glass',
        custom: { primary: 'nope' },
      }),
    ).toEqual({ preset: 'glass', colorScheme: 'system' });
    expect(
      resolveCookbookTheme({
        custom: { primary: '#112233', fontFamily: 'Comic Sans' },
      }).brand,
    ).toEqual({ primary: '#112233' });
  });
});
