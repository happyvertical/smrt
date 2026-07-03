/**
 * Unit tests for the shared web-collection selector (#1761).
 *
 * These drive {@link selectWebCollectionEntries} and
 * {@link buildWebFieldDefinitions} directly over synthetic manifests — the
 * single source of truth all three emission sites (runtime module, virt-web
 * d.ts, prebuild @smrt/web d.ts) import. The vite-plugin load-hook integration
 * lives in web-module.test.ts; this file covers the selection + field rules
 * exhaustively without a scanner round-trip.
 */

import { describe, expect, it } from 'vitest';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  buildWebFieldDefinitions,
  selectWebCollectionEntries,
} from './web-collections.js';

type ObjInput = Partial<SmartObjectDefinition> & {
  className: string;
  collection: string;
};

/** Build a minimal manifest object; only selector-relevant fields matter. */
function obj(input: ObjInput): SmartObjectDefinition {
  return {
    name: input.className.toLowerCase(),
    qualifiedName:
      input.qualifiedName ?? `@happyvertical/smrt-core:${input.className}`,
    filePath: `src/${input.className}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    ...input,
  } as SmartObjectDefinition;
}

function manifest(...objects: SmartObjectDefinition[]): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    objects: Object.fromEntries(
      objects.map((o) => [o.qualifiedName ?? o.className, o]),
    ),
  } as SmartObjectManifest;
}

describe('selectWebCollectionEntries', () => {
  it('includes a model with the default (omitted) api config as full CRUD', () => {
    const entries = selectWebCollectionEntries(
      manifest(obj({ className: 'Product', collection: 'products' })),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].collection).toBe('products');
    expect(entries[0].obj.className).toBe('Product');
    // Omitted api config exposes the full CRUD surface.
    expect(entries[0].actions).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'update',
    ]);
  });

  it('excludes api:false models (no read surface)', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Secret',
          collection: 'secrets',
          decoratorConfig: {
            api: false,
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    );
    expect(entries).toEqual([]);
  });

  it('excludes models that do not expose list', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'WriteOnly',
          collection: 'writeonlys',
          decoratorConfig: {
            api: { exclude: ['list'] },
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    );
    expect(entries).toEqual([]);
  });

  it('emits the exposed action set, sorted', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Article',
          collection: 'articles',
          decoratorConfig: {
            api: { include: ['list', 'get'] },
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    );
    expect(entries[0].actions).toEqual(['get', 'list']);
  });

  it('excludes direct SmrtCollection subclasses', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'ProductCollection',
          collection: 'products',
          extends: 'SmrtCollection',
          extendsTypeArg: 'Product',
        }),
      ),
    );
    expect(entries).toEqual([]);
  });

  it('excludes transitive collection subclasses (no type arg of their own)', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'ProductCollection',
          collection: 'products',
          extends: 'SmrtCollection',
          extendsTypeArg: 'Product',
        }),
        // Deeper subclass carries no type arg — must still be excluded via the
        // extends chain, not mistaken for a model owning `products`.
        obj({
          className: 'SpecialProductCollection',
          collection: 'products',
          extends: 'ProductCollection',
          extendsQualified: '@happyvertical/smrt-core:ProductCollection',
        }),
      ),
    );
    expect(entries).toEqual([]);
  });

  it('folds STI children into the base model even when the child is scanned first', () => {
    // Child listed BEFORE the base to prove order-independence.
    const entries = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Material',
          collection: 'products',
          extends: 'Product',
          extendsQualified: '@happyvertical/smrt-core:Product',
        }),
        obj({ className: 'Product', collection: 'products' }),
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].obj.className).toBe('Product');
  });

  it('emits one entry per REST collection across many models', () => {
    const entries = selectWebCollectionEntries(
      manifest(
        obj({ className: 'Product', collection: 'products' }),
        obj({ className: 'Order', collection: 'orders' }),
        obj({ className: 'Customer', collection: 'customers' }),
      ),
    );
    expect(entries.map((e) => e.collection).sort()).toEqual([
      'customers',
      'orders',
      'products',
    ]);
  });
});

describe('buildWebFieldDefinitions', () => {
  const field = (f: Partial<FieldDefinition>): FieldDefinition =>
    ({ type: 'text', ...f }) as FieldDefinition;

  it('carries scalar and reference columns through with required/default', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          name: field({ type: 'text', required: true }),
          price: field({ type: 'decimal', default: 0 }),
          inStock: field({ type: 'boolean' }),
          count: field({ type: 'integer' }),
          releasedAt: field({ type: 'datetime' }),
          meta: field({ type: 'json' }),
          ownerId: field({ type: 'foreignKey' }),
          tenantRef: field({ type: 'crossPackageRef' }),
        },
      }),
    );
    expect(fields).toEqual({
      name: { type: 'text', required: true },
      price: { type: 'decimal', default: 0 },
      inStock: { type: 'boolean' },
      count: { type: 'integer' },
      releasedAt: { type: 'datetime' },
      meta: { type: 'json' },
      ownerId: { type: 'foreignKey' },
      tenantRef: { type: 'crossPackageRef' },
    });
  });

  it('excludes relationship pseudo-fields, STI meta, transient and sensitive columns', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          name: field({ type: 'text' }),
          items: field({ type: 'oneToMany' }),
          tags: field({ type: 'manyToMany' }),
          _meta_type: field({ type: 'meta' }),
          computed: field({ type: 'text', transient: true }),
          apiKey: field({ type: 'text', sensitive: true }),
        },
      }),
    );
    expect(fields).toEqual({ name: { type: 'text' } });
  });
});
