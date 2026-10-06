import { describe, expect, it } from 'vitest';
import {
  extractPackage,
  packageId,
  type RawPackage,
  resolveDependencies,
} from '../src/lib/catalog/generate/extract.ts';

const raw: RawPackage = {
  packageName: '@happyvertical/smrt-shop',
  version: '1.0.0',
  description: 'A shop',
  knowledge: null,
  manifest: {
    packageName: '@happyvertical/smrt-shop',
    smrtDependencies: ['@happyvertical/smrt-core', '@happyvertical/smrt-tags'],
    objects: {
      '@happyvertical/smrt-shop:Item': {
        className: 'Item',
        qualifiedName: '@happyvertical/smrt-shop:Item',
        collection: 'items',
        fields: {
          tenantId: { type: 'text' },
          name: { type: 'text', required: true },
          price: { type: 'integer', default: 0 },
          label: {
            type: 'crossPackageRef',
            related: '@happyvertical/smrt-tags:Tag',
          },
          lines: { type: 'oneToMany' },
        },
        methods: {
          restock: {
            name: 'restock',
            async: true,
            parameters: [{ name: 'n', type: 'number', optional: true }],
            returnType: 'Promise<void>',
          },
        },
        decoratorConfig: { api: { include: ['list', 'get'] }, mcp: false },
      },
      '@happyvertical/smrt-shop:ItemCollection': {
        className: 'ItemCollection',
        qualifiedName: '@happyvertical/smrt-shop:ItemCollection',
        collection: 'items',
        extendsTypeArg: 'Item',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
    },
  },
};

describe('extractPackage', () => {
  const pkg = extractPackage(raw);
  const item = pkg.models[0];

  it('keeps models, drops collections and relation-only fields', () => {
    expect(pkg.id).toBe('shop');
    expect(pkg.models).toHaveLength(1);
    expect(item.fields.map((f) => f.name)).toEqual([
      'tenantId',
      'name',
      'price',
      'label',
    ]);
    expect(item.fields[0].system).toBe(true);
    expect(item.fields[1].required).toBe(true);
  });

  it('derives surfaces from decoratorConfig when there is no knowledge', () => {
    expect(pkg.surfaceSource).toBe('manifest');
    expect(item.rest).toEqual([
      { method: 'GET', path: '/items' },
      { method: 'GET', path: '/items/[id]' },
    ]);
    expect(item.mcp).toEqual([]);
    expect(item.cli.map((c) => c.name)).toContain('item_create');
    expect(item.exposed).toBe(true);
  });

  it('records references and resolves catalog-only dependencies', () => {
    expect(item.references).toEqual(['@happyvertical/smrt-tags:Tag']);
    const tags = { ...pkg, id: 'tags', dependencies: [] };
    const resolved = resolveDependencies([pkg, tags]);
    expect(resolved[0].dependencies).toEqual(['tags']);
  });

  it('prefers knowledge surfaces when present', () => {
    const withKnowledge = extractPackage({
      ...raw,
      knowledge: {
        surfaces: [
          {
            kind: 'mcp',
            name: 'item_restock',
            operation: 'restock',
            objectName: '@happyvertical/smrt-shop:Item',
          },
        ],
      },
    });
    expect(withKnowledge.models[0].rest).toEqual([]);
    expect(withKnowledge.models[0].mcp[0].name).toBe('item_restock');
    expect(withKnowledge.models[0].methods[0].aiCallable).toBe(true);
  });

  it('strips the scope and prefix from package names', () => {
    expect(packageId('@happyvertical/smrt-products')).toBe('products');
  });
});

describe('extractPackage field hints', () => {
  it('carries ui hints and enum values through, dropping junk', () => {
    const pkg = extractPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        objects: {
          '@happyvertical/smrt-shop:Item': {
            ...raw.manifest.objects['@happyvertical/smrt-shop:Item'],
            fields: {
              name: {
                type: 'text',
                required: true,
                _meta: {
                  ui: { basic: true, group: 'Main', order: 2, junk: 1 },
                },
              },
              kind: { type: 'text', enum: ['a', 'b'] },
              bad: { type: 'text', enum: [1, 2], _meta: { ui: 'x' } },
            },
          },
        },
      },
    });
    const fields = Object.fromEntries(
      pkg.models[0].fields.map((f) => [f.name, f]),
    );
    expect(fields.name.ui).toEqual({ basic: true, group: 'Main', order: 2 });
    expect(fields.kind.enum).toEqual(['a', 'b']);
    expect(fields.bad.enum).toBeUndefined();
    expect(fields.bad.ui).toBeUndefined();
  });
});
