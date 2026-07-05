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
  buildWebRelationships,
  computeWebManifestHash,
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

describe('buildWebRelationships', () => {
  const field = (f: Partial<FieldDefinition>): FieldDefinition =>
    ({ type: 'text', ...f }) as FieldDefinition;

  it('emits a foreignKey edge to the related model REST collection (same-package class name)', () => {
    // `@foreignKey(AdGroup)` stores the SIMPLE class name in `related`; the edge
    // resolves to that model's REST collection.
    const variation = obj({
      className: 'AdVariation',
      collection: 'ad_variations',
      fields: {
        name: field({ type: 'text' }),
        groupId: field({ type: 'foreignKey', related: 'AdGroup' }),
      },
    });
    const group = obj({ className: 'AdGroup', collection: 'ad_groups' });

    const edges = buildWebRelationships(variation, manifest(variation, group));
    expect(edges).toEqual([
      { field: 'groupId', kind: 'foreignKey', relatedCollection: 'ad_groups' },
    ]);
  });

  it('emits oneToMany and manyToMany edges to their related REST collections', () => {
    // A join relationship (`@manyToMany`) and a reverse-FK (`@oneToMany`) both
    // carry a `related` class name that resolves to a sibling collection.
    const post = obj({
      className: 'Post',
      collection: 'posts',
      fields: {
        title: field({ type: 'text' }),
        comments: field({ type: 'oneToMany', related: 'Comment' }),
        tags: field({ type: 'manyToMany', related: 'Tag' }),
      },
    });
    const comment = obj({ className: 'Comment', collection: 'comments' });
    const tag = obj({ className: 'Tag', collection: 'tags' });

    const edges = buildWebRelationships(post, manifest(post, comment, tag));
    expect(edges).toEqual([
      { field: 'comments', kind: 'oneToMany', relatedCollection: 'comments' },
      { field: 'tags', kind: 'manyToMany', relatedCollection: 'tags' },
    ]);
  });

  it('resolves a crossPackageRef edge by its qualified name when the target is in the manifest', () => {
    const ad = obj({
      className: 'AdVariation',
      collection: 'ad_variations',
      fields: {
        assetId: field({
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-assets:Asset',
        }),
      },
    });
    const asset = obj({
      className: 'Asset',
      collection: 'assets',
      qualifiedName: '@happyvertical/smrt-assets:Asset',
    });

    const edges = buildWebRelationships(ad, manifest(ad, asset));
    expect(edges).toEqual([
      {
        field: 'assetId',
        kind: 'crossPackageRef',
        relatedCollection: 'assets',
      },
    ]);
  });

  it('resolves a thunk forward-ref edge (@foreignKey(() => Scene)) to the related collection', () => {
    // Thunk forward-refs (heavy in video/voice) serialize `related` as the raw
    // arrow-function source "() => Scene", which findByName cannot match on its
    // own; buildWebRelationships must extract the class name so the edge resolves
    // — regression for edges silently dropped from those collections (#1761).
    const character = obj({
      className: 'Character',
      collection: 'characters',
      fields: {
        name: field({ type: 'text' }),
        defaultSceneId: field({ type: 'foreignKey', related: '() => Scene' }),
      },
    });
    const scene = obj({ className: 'Scene', collection: 'scenes' });

    const edges = buildWebRelationships(character, manifest(character, scene));
    expect(edges).toEqual([
      {
        field: 'defaultSceneId',
        kind: 'foreignKey',
        relatedCollection: 'scenes',
      },
    ]);
  });

  it('skips an edge whose related model is not in the manifest (unresolved target)', () => {
    // A cross-package ref to a model that was never scanned into this manifest
    // (the common per-package build case) has no collection to invalidate.
    const ad = obj({
      className: 'AdVariation',
      collection: 'ad_variations',
      fields: {
        zoneId: field({
          type: 'crossPackageRef',
          related: '@happyvertical/smrt-properties:Zone',
        }),
      },
    });
    const edges = buildWebRelationships(ad, manifest(ad));
    expect(edges).toEqual([]);
  });

  it('skips an edge whose related model exists but is not API-exposed', () => {
    // The related model resolves, but exposes no read surface (api:false), so it
    // never becomes a web collection — there is no cache to invalidate.
    const order = obj({
      className: 'Order',
      collection: 'orders',
      fields: {
        secretId: field({ type: 'foreignKey', related: 'Secret' }),
      },
    });
    const secret = obj({
      className: 'Secret',
      collection: 'secrets',
      decoratorConfig: {
        api: false,
      } as SmartObjectDefinition['decoratorConfig'],
    });
    const edges = buildWebRelationships(order, manifest(order, secret));
    expect(edges).toEqual([]);
  });

  it('ignores relationship fields with no related target and non-relationship fields', () => {
    const model = obj({
      className: 'Thing',
      collection: 'things',
      fields: {
        name: field({ type: 'text' }),
        count: field({ type: 'integer' }),
        // Relationship type but no `related` — cannot resolve an edge.
        orphan: field({ type: 'foreignKey' }),
      },
    });
    const edges = buildWebRelationships(model, manifest(model));
    expect(edges).toEqual([]);
  });

  it('keeps a self-referential edge (a collection related to itself)', () => {
    // Self edges are harmless: the runtime always invalidates the mutated
    // collection anyway. Keeping it avoids a special case.
    const category = obj({
      className: 'Category',
      collection: 'categories',
      fields: {
        parentId: field({ type: 'foreignKey', related: 'Category' }),
      },
    });
    const edges = buildWebRelationships(category, manifest(category));
    expect(edges).toEqual([
      {
        field: 'parentId',
        kind: 'foreignKey',
        relatedCollection: 'categories',
      },
    ]);
  });
});

describe('computeWebManifestHash (#1764)', () => {
  const field = (f: Partial<FieldDefinition>): FieldDefinition =>
    ({ type: 'text', ...f }) as FieldDefinition;

  it('returns a short, stable base64url string', () => {
    const hash = computeWebManifestHash(
      manifest(obj({ className: 'Product', collection: 'products' })),
    );
    // 16 base64url chars (first half of a sha256 digest) — compact + stable.
    expect(hash).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('is deterministic: the same manifest always hashes the same', () => {
    const build = () =>
      computeWebManifestHash(
        manifest(
          obj({
            className: 'Product',
            collection: 'products',
            fields: {
              name: field({ type: 'text', required: true }),
              price: field({ type: 'decimal' }),
            },
          }),
        ),
      );
    expect(build()).toBe(build());
  });

  it('is replica-stable: field insertion order does not change the hash', () => {
    // Two builds visit the same schema in a DIFFERENT field order (map insertion
    // order). Canonicalization (recursive key sort) must make them hash equal —
    // otherwise a redeploy off a different scan order would spuriously drop every
    // client cache.
    const a = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({ type: 'text', required: true }),
            price: field({ type: 'decimal' }),
          },
        }),
      ),
    );
    const b = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            price: field({ type: 'decimal' }),
            name: field({ type: 'text', required: true }),
          },
        }),
      ),
    );
    expect(a).toBe(b);
  });

  it('is replica-stable: model/collection ordering does not change the hash', () => {
    const a = computeWebManifestHash(
      manifest(
        obj({ className: 'Product', collection: 'products' }),
        obj({ className: 'Order', collection: 'orders' }),
      ),
    );
    const b = computeWebManifestHash(
      manifest(
        obj({ className: 'Order', collection: 'orders' }),
        obj({ className: 'Product', collection: 'products' }),
      ),
    );
    expect(a).toBe(b);
  });

  it('CHANGES when a field is added (the drop-stale-caches guarantee)', () => {
    const before = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { name: field({ type: 'text' }) },
        }),
      ),
    );
    const after = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({ type: 'text' }),
            price: field({ type: 'decimal' }),
          },
        }),
      ),
    );
    expect(after).not.toBe(before);
  });

  it('CHANGES when a field is removed', () => {
    const before = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({ type: 'text' }),
            price: field({ type: 'decimal' }),
          },
        }),
      ),
    );
    const after = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { name: field({ type: 'text' }) },
        }),
      ),
    );
    expect(after).not.toBe(before);
  });

  it('CHANGES when a field type changes (a shape-only difference)', () => {
    const asText = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { count: field({ type: 'text' }) },
        }),
      ),
    );
    const asInteger = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { count: field({ type: 'integer' }) },
        }),
      ),
    );
    expect(asInteger).not.toBe(asText);
  });

  it('CHANGES when a relationship edge is added', () => {
    const withoutEdge = computeWebManifestHash(
      manifest(
        obj({ className: 'Order', collection: 'orders' }),
        obj({ className: 'Customer', collection: 'customers' }),
      ),
    );
    const withEdge = computeWebManifestHash(
      manifest(
        obj({
          className: 'Order',
          collection: 'orders',
          fields: {
            customerId: field({ type: 'foreignKey', related: 'Customer' }),
          },
        }),
        obj({ className: 'Customer', collection: 'customers' }),
      ),
    );
    expect(withEdge).not.toBe(withoutEdge);
  });
});
