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
  buildWebCollectionDefinition,
  buildWebFieldDefinitions,
  buildWebMcpToolDefinitions,
  buildWebRelationships,
  buildWebToolDescriptors,
  computeWebManifestHash,
  isCollectionManifestClass,
  resolveCollectionItemObject,
  resolveCollectionItemTypeName,
  selectWebCollectionEntries,
  selectWebMcpToolEntries,
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

describe('collection item ancestry', () => {
  const baseWidget = obj({
    className: 'Widget',
    collection: 'widgets',
    packageName: '@base/pkg',
    qualifiedName: '@base/pkg:Widget',
  });
  const childWidget = obj({
    className: 'Widget',
    collection: 'childWidgets',
    packageName: '@child/pkg',
    qualifiedName: '@child/pkg:Widget',
  });
  const baseCollection = obj({
    className: 'WidgetCollection',
    collection: 'widgets',
    packageName: '@base/pkg',
    qualifiedName: '@base/pkg:WidgetCollection',
    extends: 'SmrtCollection',
    extendsTypeArg: 'Widget',
  });
  const childCollection = obj({
    className: 'SpecialWidgetCollection',
    collection: 'widgets',
    packageName: '@child/pkg',
    qualifiedName: '@child/pkg:SpecialWidgetCollection',
    extends: 'WidgetCollection',
    extendsQualified: '@base/pkg:WidgetCollection',
  });

  it('resolves an inherited generic in the package that declared it', () => {
    const crossPackageManifest = manifest(
      childWidget,
      childCollection,
      baseCollection,
      baseWidget,
    );

    expect(
      resolveCollectionItemObject(crossPackageManifest, childCollection),
    ).toBe(baseWidget);
    expect(
      resolveCollectionItemTypeName(crossPackageManifest, childCollection),
    ).toBe('Widget');
  });

  it('keeps a qualified generic reference when a partial manifest omits its item', () => {
    const partialManifest = manifest(
      childWidget,
      childCollection,
      baseCollection,
    );

    expect(
      resolveCollectionItemObject(partialManifest, childCollection),
    ).toBeUndefined();
    expect(
      resolveCollectionItemTypeName(partialManifest, childCollection),
    ).toBe('@base/pkg:Widget');
  });

  it('uses qualified manifest keys when legacy object bodies omit package identity', () => {
    const child = obj({
      className: 'SpecialDocCollection',
      collection: 'docs',
      extends: 'DocCollection',
      qualifiedName: '@z/base:SpecialDocCollection',
    });
    const realParent = obj({
      className: 'DocCollection',
      collection: 'docs',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Doc',
      qualifiedName: '@z/base:DocCollection',
    });
    const collidingParent = obj({
      className: 'DocCollection',
      collection: 'unrelated',
      extends: 'SmrtObject',
      qualifiedName: '@a/other:DocCollection',
    });
    const realItem = obj({
      className: 'Doc',
      collection: 'docs',
      qualifiedName: '@z/base:Doc',
    });
    for (const candidate of [child, realParent, collidingParent, realItem]) {
      candidate.qualifiedName = undefined;
      candidate.packageName = undefined;
    }
    const legacyManifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: {
        '@z/base:SpecialDocCollection': child,
        '@z/base:DocCollection': realParent,
        '@z/base:Doc': realItem,
        '@a/other:DocCollection': collidingParent,
      },
    } as SmartObjectManifest;

    expect(isCollectionManifestClass(legacyManifest, child)).toBe(true);
    expect(resolveCollectionItemTypeName(legacyManifest, child)).toBe('Doc');
    expect(resolveCollectionItemObject(legacyManifest, child)).toBe(realItem);
  });
});

describe('buildWebToolDescriptors', () => {
  const field = (f: Partial<FieldDefinition>): FieldDefinition =>
    ({ type: 'text', ...f }) as FieldDefinition;

  const productEntry = () =>
    selectWebCollectionEntries(
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
    )[0];

  it('emits one WebMCP descriptor per exposed action, named <class>_<action>', () => {
    const names = buildWebToolDescriptors(productEntry()).map((d) => d.name);
    // default (omitted) api config = full CRUD
    expect(names).toEqual(
      expect.arrayContaining([
        'product_list',
        'product_get',
        'product_create',
        'product_update',
        'product_delete',
      ]),
    );
  });

  it('marks only reads read-only and builds create inputs from public fields', () => {
    const descriptors = buildWebToolDescriptors(productEntry());
    expect(descriptors.find((d) => d.action === 'list')?.readOnly).toBe(true);
    const create = descriptors.find((d) => d.action === 'create');
    expect(create?.readOnly).toBe(false);
    const props = (create?.inputSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('price');
    expect(create?.inputSchema.required).toContain('name');
  });

  it('threads @field descriptions into the generated tool input schemas (#2046)', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({
              type: 'text',
              required: true,
              description: 'Display name shown on invoices',
            }),
            price: field({ type: 'decimal' }),
          },
        }),
      ),
    )[0];
    const create = buildWebToolDescriptors(entry).find(
      (d) => d.action === 'create',
    );
    const schema = create?.inputSchema as {
      properties: Record<string, { $ref: string }>;
      $defs: Record<string, { description?: string }>;
    };
    const definition = (name: string) =>
      schema.$defs[schema.properties[name].$ref.slice('#/$defs/'.length)];
    expect(definition('name').description).toBe(
      'Display name shown on invoices',
    );
    // No authored description → the type-derived fallback, not an empty string.
    expect(definition('price').description).toBeTruthy();
  });

  it('preserves nullable manifest fields in generated tool schemas', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            discontinuedAt: field({
              type: 'datetime',
              _meta: { nullable: true },
            }),
          },
        }),
      ),
    )[0];
    const create = buildWebToolDescriptors(entry).find(
      (tool) => tool.action === 'create',
    );
    const schema = create?.inputSchema as {
      properties: Record<string, { $ref: string }>;
      $defs: Record<string, { type?: unknown }>;
    };
    const definition =
      schema.$defs[
        schema.properties.discontinuedAt.$ref.slice('#/$defs/'.length)
      ];
    expect(definition.type).toEqual(['string', 'null']);
  });

  it('does not advertise UUID-only identifiers for text-id objects', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'ExternalProduct',
          collection: 'external-products',
          decoratorConfig: { idType: 'text' },
        }),
      ),
    )[0];

    for (const action of ['get', 'update', 'delete']) {
      const descriptor = buildWebToolDescriptors(entry).find(
        (tool) => tool.action === action,
      );
      const properties = descriptor?.inputSchema.properties as Record<
        string,
        unknown
      >;
      expect(properties.id).not.toEqual(
        expect.objectContaining({ format: 'uuid' }),
      );
    }
  });

  it('uses the same item receiver and typed custom arguments as Node MCP', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { name: field({ type: 'text' }) },
          methods: {
            apply: {
              name: 'apply',
              isPublic: true,
              isStatic: false,
              async: true,
              returnType: 'Promise<void>',
              parameters: [
                {
                  name: 'idempotencyKey',
                  type: 'string',
                  optional: false,
                },
                {
                  name: 'expectedVersion',
                  type: 'number',
                  optional: true,
                },
              ],
            },
          },
          decoratorConfig: {
            api: {
              include: ['list', 'apply'],
              // A config-only collection override cannot change this instance
              // method's receiver.
              routes: {
                apply: {
                  scope: 'collection',
                  method: 'PATCH',
                  path: 'publish-now',
                },
              },
            },
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    )[0];

    const descriptor = buildWebToolDescriptors(entry).find(
      (tool) => tool.action === 'apply',
    );
    expect(descriptor?.inputSchema).toMatchObject({
      properties: {
        id: { type: 'string' },
        idempotencyKey: { type: 'string' },
        expectedVersion: { type: 'number' },
      },
      required: ['id', 'idempotencyKey'],
    });
    expect(descriptor?.route).toEqual({
      method: 'PATCH',
      scope: 'item',
      path: ['publish-now'],
    });
  });

  it('emits kebab-case custom route segments when configured', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          methods: {
            publishNow: {
              name: 'publishNow',
              isPublic: true,
              isStatic: false,
              async: true,
              returnType: 'Promise<void>',
              parameters: [{ name: 'id', type: 'string', optional: false }],
            },
          },
          decoratorConfig: {
            api: { include: ['list', 'publishNow'] },
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    )[0];
    const descriptor = buildWebToolDescriptors(entry, {
      kebabRoutes: true,
    }).find((tool) => tool.action === 'publishNow');
    expect(descriptor?.route).toEqual({
      method: 'POST',
      scope: 'item',
      path: ['publish-now'],
      parameterAliases: { actionId: 'id' },
    });
  });

  it('marks a generated single-options action for direct transport unwrapping', () => {
    const entry = selectWebCollectionEntries(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          methods: {
            publish: {
              name: 'publish',
              isPublic: true,
              isStatic: false,
              async: true,
              returnType: 'Promise<void>',
              parameters: [{ name: 'options', type: 'object', optional: true }],
            },
          },
          decoratorConfig: {
            api: { include: ['list', 'publish'] },
          } as SmartObjectDefinition['decoratorConfig'],
        }),
      ),
    )[0];

    const descriptor = buildWebToolDescriptors(entry).find(
      (tool) => tool.action === 'publish',
    );
    expect(descriptor?.inputSchema.properties).toHaveProperty('options');
    expect(descriptor?.route).toMatchObject({ optionsBag: true });
  });

  it('stays OUT of buildWebCollectionDefinition, so the #1764 shape digest never covers it', () => {
    const m = manifest(
      obj({
        className: 'Product',
        collection: 'products',
        fields: { name: field({ type: 'text' }) },
      }),
    );
    const def = buildWebCollectionDefinition(
      selectWebCollectionEntries(m)[0],
      m,
    );
    // Descriptors are layered on in generateWebModule, NOT here — that is what
    // keeps computeWebManifestHash (which hashes this shape) row-shape-only.
    expect(def).not.toHaveProperty('toolDescriptors');
    expect(def.objectRef).toBe('@happyvertical/smrt-core:Product');
  });

  it('uses the qualified manifest key when legacy objects omit package identity', () => {
    const legacyProduct = obj({
      className: 'Product',
      collection: 'products',
      qualifiedName: '@example/products:Product',
    });
    legacyProduct.qualifiedName = undefined;
    legacyProduct.packageName = undefined;
    const legacyManifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: { '@example/products:Product': legacyProduct },
    } as SmartObjectManifest;

    const definition = buildWebCollectionDefinition(
      selectWebCollectionEntries(legacyManifest)[0],
      legacyManifest,
    );
    expect(definition.objectRef).toBe('@example/products:Product');
  });
});

describe('canonical WebMCP tool definitions (#2518)', () => {
  const publicMethod = (
    name: string,
    options: {
      isStatic?: boolean;
      parameters?: SmartObjectDefinition['methods'][string]['parameters'];
    } = {},
  ): SmartObjectDefinition['methods'][string] => ({
    name,
    isPublic: true,
    isStatic: options.isStatic ?? false,
    async: true,
    returnType: 'Promise<void>',
    parameters: options.parameters ?? [],
  });

  it('emits get-only and custom-action-only object tools without materializing collections', () => {
    const product = obj({
      className: 'Product',
      collection: 'products',
      decoratorConfig: { api: { include: ['get'] } },
    });
    const report = obj({
      className: 'Report',
      collection: 'reports',
      methods: {
        refresh: publicMethod('refresh', {
          isStatic: true,
          parameters: [{ name: 'options', type: 'object', optional: true }],
        }),
      },
      decoratorConfig: {
        api: {
          include: ['refresh'],
          routes: {
            refresh: {
              method: 'PATCH',
              scope: 'collection',
              path: 'refresh-now',
            },
          },
        },
      } as SmartObjectDefinition['decoratorConfig'],
    });
    const m = manifest(product, report);

    expect(selectWebCollectionEntries(m)).toEqual([]);
    expect(buildWebMcpToolDefinitions(m)).toMatchObject([
      {
        collection: 'products',
        action: 'get',
        name: 'product_get',
        route: { method: 'GET', scope: 'item', path: [] },
      },
      {
        collection: 'reports',
        action: 'refresh',
        name: 'report_refresh',
        route: {
          method: 'PATCH',
          scope: 'collection',
          path: ['refresh-now'],
          optionsBag: true,
        },
      },
    ]);
  });

  it('merges collection-class custom actions into the owning row collection', () => {
    const product = obj({
      className: 'Product',
      collection: 'products',
      decoratorConfig: { api: false },
    });
    const products = obj({
      className: 'ProductCollection',
      collection: 'products',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Product',
      methods: {
        publish: publicMethod('publish', {
          parameters: [{ name: 'id', type: 'string', optional: false }],
        }),
      },
      decoratorConfig: {
        api: {
          include: ['publish'],
          routes: {
            publish: {
              method: 'POST',
              scope: 'collection',
              path: 'publish/[batchId]',
            },
          },
        },
      } as SmartObjectDefinition['decoratorConfig'],
    });

    const [definition] = buildWebMcpToolDefinitions(
      manifest(products, product),
    );
    expect(definition).toMatchObject({
      collection: 'products',
      objectRef: '@happyvertical/smrt-core:Product',
      className: 'Product',
      action: 'publish',
      name: 'product_publish',
      route: {
        method: 'POST',
        scope: 'collection',
        path: ['publish', '[batchId]'],
        parameterAliases: { actionId: 'id' },
      },
    });
    expect(definition?.inputSchema).toMatchObject({
      properties: {
        actionId: { type: 'string' },
        batchId: { type: 'string' },
      },
      required: ['actionId', 'batchId'],
    });
  });

  it('matches the last emitted collection-class route owner on a shared action', () => {
    const product = obj({
      className: 'Product',
      collection: 'products',
      decoratorConfig: { api: false },
    });
    const baseCollection = obj({
      className: 'ProductCollection',
      collection: 'products',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Product',
      methods: { search: publicMethod('search') },
      decoratorConfig: {
        api: { include: ['search'], routes: { search: { path: 'base' } } },
      } as SmartObjectDefinition['decoratorConfig'],
    });
    const specializedCollection = obj({
      className: 'SpecialProductCollection',
      collection: 'products',
      extends: 'ProductCollection',
      methods: { search: publicMethod('search') },
      decoratorConfig: {
        api: {
          include: ['search'],
          routes: { search: { path: 'specialized' } },
        },
      } as SmartObjectDefinition['decoratorConfig'],
    });

    const forward = buildWebMcpToolDefinitions(
      manifest(product, baseCollection, specializedCollection),
    );
    const reverse = buildWebMcpToolDefinitions(
      manifest(product, specializedCollection, baseCollection),
    );
    expect(forward[0]).toMatchObject({
      collection: 'products',
      action: 'search',
      name: 'product_search',
      route: { path: ['specialized'] },
    });
    expect(reverse[0]).toMatchObject({
      collection: 'products',
      action: 'search',
      name: 'product_search',
      route: { path: ['base'] },
    });
  });

  it('honors API disablement, empty includes, exclusions, and ignores CLI/MCP-only exposure', () => {
    const definitions = buildWebMcpToolDefinitions(
      manifest(
        obj({
          className: 'Disabled',
          collection: 'disabled',
          decoratorConfig: { api: false, mcp: true, cli: true },
        }),
        obj({
          className: 'Empty',
          collection: 'empty',
          decoratorConfig: { api: { include: [] } },
        }),
        obj({
          className: 'Excluded',
          collection: 'excluded',
          decoratorConfig: {
            api: { include: ['get'], exclude: ['get'] },
          },
        }),
      ),
    );

    expect(definitions).toEqual([]);
  });

  it('uses public DTO fields and finalized bounded schemas', () => {
    const definitions = buildWebMcpToolDefinitions(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: { type: 'text', required: true } as FieldDefinition,
            secret: { type: 'text', sensitive: true } as FieldDefinition,
            scratch: { type: 'text', transient: true } as FieldDefinition,
            metadata: { type: 'meta' } as FieldDefinition,
            items: { type: 'oneToMany', related: 'Item' } as FieldDefinition,
          },
          decoratorConfig: { api: { include: ['create'] } },
        }),
      ),
    );
    const schema = definitions[0]?.inputSchema as {
      $schema?: string;
      properties?: Record<string, unknown>;
    };

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(schema.properties ?? {})).toEqual(['name']);
  });

  it('is scan-order independent and gives an object action precedence over a collection action collision', () => {
    const product = obj({
      className: 'Product',
      collection: 'products',
      methods: { publish: publicMethod('publish', { isStatic: true }) },
      decoratorConfig: {
        api: {
          include: ['publish'],
          routes: { publish: { path: 'object-publish' } },
        },
      } as SmartObjectDefinition['decoratorConfig'],
    });
    const products = obj({
      className: 'ProductCollection',
      collection: 'products',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Product',
      methods: { publish: publicMethod('publish') },
      decoratorConfig: {
        api: {
          include: ['publish'],
          routes: { publish: { path: 'collection-publish' } },
        },
      } as SmartObjectDefinition['decoratorConfig'],
    });

    const forward = manifest(product, products);
    const reverse = manifest(products, product);
    expect(selectWebMcpToolEntries(forward)).toHaveLength(1);
    expect(buildWebMcpToolDefinitions(forward)).toEqual(
      buildWebMcpToolDefinitions(reverse),
    );
    expect(buildWebMcpToolDefinitions(forward)[0]?.route.path).toEqual([
      'object-publish',
    ]);
  });

  it('keeps unique STI child actions while the base owns shared CRUD tools', () => {
    const animal = obj({
      className: 'Animal',
      collection: 'animals',
      decoratorConfig: { api: false, tableStrategy: 'sti' },
    });
    const cat = obj({
      className: 'Cat',
      collection: 'animals',
      extends: 'Animal',
      methods: { groom: publicMethod('groom') },
      decoratorConfig: { api: { include: ['get', 'groom'] } },
    });

    const definitions = buildWebMcpToolDefinitions(manifest(cat, animal));
    expect(
      definitions.map(({ action, className, name }) => ({
        action,
        className,
        name,
      })),
    ).toEqual([
      { action: 'get', className: 'Animal', name: 'animal_get' },
      { action: 'groom', className: 'Animal', name: 'animal_groom' },
    ]);
    expect(definitions[1]?.route.scope).toBe('item');
  });

  it('does not add WebMCP-only inputs to the row-shape manifest hash', () => {
    const getOnly = obj({
      className: 'Lookup',
      collection: 'lookups',
      decoratorConfig: { api: { include: ['get'] } },
    });
    const before = computeWebManifestHash(manifest(getOnly));
    getOnly.decoratorConfig.idType = 'text';
    getOnly.methods.lookup = publicMethod('lookup');

    expect(computeWebManifestHash(manifest(getOnly))).toBe(before);
  });
});

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

  it('resolves duplicate simple parent names package-locally regardless of manifest order', () => {
    const collectionParent = obj({
      qualifiedName: '@a/pkg:Parent',
      packageName: '@a/pkg',
      className: 'Parent',
      collection: 'collectionParents',
      extends: 'SmrtCollection',
      extendsTypeArg: 'Item',
    });
    const modelParent = obj({
      qualifiedName: '@z/pkg:Parent',
      packageName: '@z/pkg',
      className: 'Parent',
      collection: 'modelParents',
      extends: 'SmrtObject',
    });
    const localChild = obj({
      qualifiedName: '@z/pkg:LocalChild',
      packageName: '@z/pkg',
      className: 'LocalChild',
      collection: 'localChildren',
      extends: 'Parent',
    });

    for (const objects of [
      [collectionParent, modelParent, localChild],
      [modelParent, collectionParent, localChild],
    ]) {
      expect(
        selectWebCollectionEntries(manifest(...objects)).find(
          ({ obj: candidate }) =>
            candidate.qualifiedName === '@z/pkg:LocalChild',
        )?.collection,
      ).toBe('localChildren');
    }
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

  it('carries nullable through as public field metadata', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          discontinuedAt: field({
            type: 'datetime',
            _meta: { nullable: true },
          }),
        },
      }),
    );
    expect(fields.discontinuedAt).toEqual({
      type: 'datetime',
      nullable: true,
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

  it('carries @field description and _meta.ui hints through (#2046)', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          name: field({
            type: 'text',
            required: true,
            description: 'Display name shown on invoices',
            _meta: { ui: { basic: true, group: 'identity', order: 1 } },
          }),
          taxClass: field({
            type: 'text',
            _meta: { ui: { locked: true } },
          }),
          plain: field({ type: 'text' }),
        },
      }),
    );
    expect(fields).toEqual({
      name: {
        type: 'text',
        required: true,
        description: 'Display name shown on invoices',
        ui: { basic: true, group: 'identity', order: 1 },
      },
      taxClass: { type: 'text', ui: { locked: true } },
      plain: { type: 'text' },
    });
  });

  it('falls back to _meta.description when the top-level key is absent (runtime-registry manifests)', () => {
    // registeredFieldsToManifest (computeRuntimeWebManifestHash) hoists only
    // `default` out of `_meta` — description stays nested. The emission must
    // read both places or build-time and runtime shape digests diverge and
    // smrt-web latches a false contract-update signal on SSE connect.
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          nested: field({
            type: 'text',
            _meta: { description: 'From runtime registration' },
          }),
          topWins: field({
            type: 'text',
            description: 'Top-level wins',
            _meta: { description: 'Shadowed' },
          }),
          junk: field({ type: 'text', _meta: { description: 42 } }),
        },
      }),
    );
    expect(fields).toEqual({
      nested: { type: 'text', description: 'From runtime registration' },
      topWins: { type: 'text', description: 'Top-level wins' },
      junk: { type: 'text' },
    });
  });

  it('sanitizes _meta.ui: wrong-typed and unknown keys are dropped, empty bags emit no ui', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          a: field({
            type: 'text',
            // basic wrong type, order non-finite, group empty, junk extra key —
            // only the valid `locked` survives.
            _meta: {
              ui: {
                basic: 'yes',
                order: Number.NaN,
                group: '',
                locked: false,
                rogue: { deep: 'junk' },
              },
            },
          }),
          b: field({ type: 'text', _meta: { ui: { basic: 'yes' } } }),
          c: field({ type: 'text', _meta: { ui: 'not-an-object' } }),
          d: field({ type: 'text', _meta: { ui: ['array'] } }),
        },
      }),
    );
    expect(fields).toEqual({
      a: { type: 'text', ui: { locked: false } },
      b: { type: 'text' },
      c: { type: 'text' },
      d: { type: 'text' },
    });
  });

  it('never leaks a sensitive or transient field even when it carries description/ui', () => {
    const fields = buildWebFieldDefinitions(
      obj({
        className: 'Product',
        collection: 'products',
        fields: {
          name: field({ type: 'text' }),
          apiKey: field({
            type: 'text',
            sensitive: true,
            description: 'Secret integration key — must never ship',
            _meta: { ui: { basic: true } },
          }),
          scratch: field({
            type: 'text',
            transient: true,
            description: 'Computed only',
          }),
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

  it('CHANGES when a description or ui hint is added (#2046 — deliberate over-invalidation)', () => {
    const bare = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { name: field({ type: 'text' }) },
        }),
      ),
    );
    const withDescription = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: { name: field({ type: 'text', description: 'Shown name' }) },
        }),
      ),
    );
    const withUi = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({ type: 'text', _meta: { ui: { basic: true } } }),
          },
        }),
      ),
    );
    expect(withDescription).not.toBe(bare);
    expect(withUi).not.toBe(bare);
    // Junk-only ui bags sanitize away, so they do NOT churn the hash.
    const withJunkUi = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          fields: {
            name: field({ type: 'text', _meta: { ui: { rogue: 'junk' } } }),
          },
        }),
      ),
    );
    expect(withJunkUi).toBe(bare);
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

  it('CHANGES when the canonical objectRef changes', () => {
    const core = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          qualifiedName: '@happyvertical/smrt-core:Product',
        }),
      ),
    );
    const products = computeWebManifestHash(
      manifest(
        obj({
          className: 'Product',
          collection: 'products',
          qualifiedName: '@happyvertical/smrt-products:Product',
        }),
      ),
    );
    expect(products).not.toBe(core);
  });

  // The salt covers get-OR-list routes, not just materializable (list) ones
  // (#1764 / codex P2): a get-only model has a generated GET route that IS
  // salted, so a shape-only change to it must change the hash — else a client
  // holding the old concrete ETag gets a zero-query 304 after a shape-only deploy.
  const getOnly = (fields: Record<string, FieldDefinition>) =>
    obj({
      className: 'Doc',
      collection: 'docs',
      fields,
      decoratorConfig: {
        api: { include: ['get'] },
      } as SmartObjectDefinition['decoratorConfig'],
    });

  it('INCLUDES get-only models (not materializable, but their GET route is salted)', () => {
    // A manifest with ONLY a get-only model still produces a non-empty hash that
    // reflects its shape — proving get-only entries are covered, not dropped
    // (selectWebCollectionEntries would have excluded it for lacking `list`).
    const withGetOnly = computeWebManifestHash(
      manifest(getOnly({ title: field({ type: 'text' }) })),
    );
    const empty = computeWebManifestHash(manifest());
    expect(withGetOnly).not.toBe(empty);
  });

  it('CHANGES when a GET-ONLY model shape changes (the salt covers get routes)', () => {
    const before = computeWebManifestHash(
      manifest(getOnly({ title: field({ type: 'text' }) })),
    );
    const after = computeWebManifestHash(
      manifest(
        getOnly({
          title: field({ type: 'text' }),
          author: field({ type: 'text' }),
        }),
      ),
    );
    expect(after).not.toBe(before);
  });
});
