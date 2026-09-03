/**
 * Acceptance coverage for issue #2648, part 2 — the WebMCP tool-id namespace.
 * https://github.com/happyvertical/smrt/issues/2648
 *
 * `buildToolDescriptors` names a WebMCP tool `` `${prefix}_${action}`.toLowerCase() ``
 * — the same whole-string lowercase `MCPGenerator` uses — but the action set
 * feeding it comes from `resolveApiActionSet`, which reserves CRUD verbs on
 * EXACT match. So a public `List()` survives alongside the generated `list`,
 * `selectWebMcpToolEntries` treats them as distinct entries, and both descriptors
 * land on the id `product_list`.
 *
 * Exact matching is correct for REST and is deliberately left alone: `apiPath`
 * emits `/${collection}/${operation}` with declared casing, so `/products/List`
 * is a genuinely distinct route from `/products`. The collision exists only in
 * the flattened lowercased tool namespace, so the reservation belongs at this
 * emission site — the same conclusion #2646 reached for `MCPGenerator`.
 */

import { describe, expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import {
  buildWebMcpToolDefinitions,
  selectWebMcpToolEntries,
} from './web-collections.js';

type ObjInput = Partial<SmartObjectDefinition> & {
  className: string;
  collection: string;
};

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

const publicMethod = (
  name: string,
): SmartObjectDefinition['methods'][string] => ({
  name,
  isPublic: true,
  isStatic: false,
  async: true,
  returnType: 'Promise<void>',
  parameters: [],
});

/** Every emitted tool id, in catalog order — the actual `name` on the wire. */
function toolIds(m: SmartObjectManifest): string[] {
  return buildWebMcpToolDefinitions(m).map((definition) => definition.name);
}

/** The selector's own view, for asserting where a duplicate originates. */
function selectedActions(m: SmartObjectManifest): string[] {
  return selectWebMcpToolEntries(m).map((entry) => entry.action);
}

describe('#2648 WebMCP tool-id collisions', () => {
  it('emits one descriptor per tool id when a method shadows a CRUD verb case-insensitively', () => {
    const m = manifest(
      obj({
        className: 'Product',
        collection: 'products',
        methods: { List: publicMethod('List') },
      }),
    );

    const ids = toolIds(m);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicates).toEqual([]);
    // The generated CRUD list tool is what owns the id.
    expect(ids.filter((id) => id === 'product_list')).toEqual(['product_list']);
    // And the selector no longer hands two actions to one id.
    expect(
      selectedActions(m).filter((a) => a.toLowerCase() === 'list'),
    ).toEqual(['list']);
  });

  it('still emits a genuinely custom action alongside CRUD', () => {
    const m = manifest(
      obj({
        className: 'Product',
        collection: 'products',
        methods: { syncNow: publicMethod('syncNow') },
      }),
    );

    expect(toolIds(m)).toContain('product_syncnow');
  });

  it('produces no duplicate tool id for any object in the manifest', () => {
    const m = manifest(
      obj({
        className: 'Product',
        collection: 'products',
        methods: {
          List: publicMethod('List'),
          Get: publicMethod('Get'),
          Delete: publicMethod('Delete'),
          syncNow: publicMethod('syncNow'),
        },
      }),
    );

    const ids = toolIds(m);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);

    expect(duplicates).toEqual([]);
  });
});
