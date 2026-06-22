/**
 * Coverage tests for registry/inheritance-resolver.ts.
 *
 * IMPORTANT: ObjectRegistry.getInheritanceChain / getAllFields / getAllMethods
 * are INLINE re-implementations in registry.ts — they do NOT call the
 * inheritance-resolver module. So inheritance.test.ts (which goes through
 * ObjectRegistry) leaves this module at ~26%. These tests import the module
 * functions DIRECTLY to cover their real branches.
 *
 * The module functions read/write the same globalThis registry + caches the
 * decorator populates, so we register real `@smrt()` fixtures and, for the
 * synthetic edge cases (circular chains, missing parents), splice fake
 * RegisteredClass entries into the shared `classes` map and clean them up.
 *
 * @see src/registry/inheritance-resolver.ts (issue #1500 coverage, ORM group)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IRConstraintChild,
  IRLeaf,
  IRSolo,
} from '../../__tests__/fixtures/inheritance-resolver-fixtures.js';
import { ConfigurationError } from '../../errors';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import {
  buildInheritanceChain,
  getAllFields,
  getAllMethods,
  getInheritanceChain,
  mergeFieldConfigs,
} from '../inheritance-resolver';
import { getClasses, getInheritanceCache } from '../shared-state';

/** Track synthetic registry keys we add so afterEach can remove them. */
const syntheticKeys = new Set<string>();

function addSyntheticClass(key: string, registered: any): void {
  getClasses().set(key, registered);
  syntheticKeys.add(key);
}

beforeEach(() => {
  ObjectRegistry.invalidateAllInheritanceCaches();
  getInheritanceCache().clear();
});

afterEach(() => {
  for (const key of syntheticKeys) {
    getClasses().delete(key);
  }
  syntheticKeys.clear();
  ObjectRegistry.invalidateAllInheritanceCaches();
  getInheritanceCache().clear();
  vi.restoreAllMocks();
});

describe('inheritance-resolver: buildInheritanceChain', () => {
  it('walks the prototype chain base→child, stopping at SmrtObject', () => {
    const chain = buildInheritanceChain(IRLeaf as unknown as typeof SmrtObject);
    expect(chain).toEqual(['IRBase', 'IRMiddle', 'IRLeaf']);
  });

  it('returns a single-element chain for a direct SmrtObject subclass', () => {
    const chain = buildInheritanceChain(IRSolo as unknown as typeof SmrtObject);
    expect(chain).toEqual(['IRSolo']);
  });

  it('throws circularInheritance when the walk revisits a constructor', () => {
    // Real JS prototype chains cannot contain a cycle (the engine rejects
    // `__proto__` loops), so drive the visited-set guard by stubbing
    // Object.getPrototypeOf to return an already-seen node on the 2nd hop.
    const nodeA: any = { name: 'CycleA' };
    const nodeB: any = { name: 'CycleB' };
    const realGetProto = Object.getPrototypeOf;
    const spy = vi
      .spyOn(Object, 'getPrototypeOf')
      .mockImplementation((obj: any) => {
        if (obj === nodeA) return nodeB; // A -> B
        if (obj === nodeB) return nodeA; // B -> A (revisits A => cycle)
        return realGetProto(obj);
      });
    try {
      expect(() => buildInheritanceChain(nodeA)).toThrow(ConfigurationError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('inheritance-resolver: getInheritanceChain (module)', () => {
  it('returns [] for an unregistered class', () => {
    expect(getInheritanceChain('TotallyUnregisteredXYZ')).toEqual([]);
  });

  it('builds a qualified chain for a registered 3-level hierarchy', () => {
    const chain = getInheritanceChain('IRLeaf');
    expect(chain).toEqual([
      '@happyvertical/smrt-core:IRBase',
      '@happyvertical/smrt-core:IRMiddle',
      '@happyvertical/smrt-core:IRLeaf',
    ]);
  });

  it('serves a cached chain on the second call (same reference)', () => {
    const first = getInheritanceChain('IRMiddle');
    const second = getInheritanceChain('IRMiddle');
    expect(second).toBe(first);
  });

  it('returns a pre-stored inheritanceChain and seeds the cache from it', () => {
    const registered = ObjectRegistry.getClass('IRSolo');
    expect(registered).toBeDefined();
    getInheritanceCache().clear();
    const sentinel = ['pre', 'computed', 'IRSolo'];
    (registered as any).inheritanceChain = sentinel;
    try {
      const chain = getInheritanceChain('IRSolo');
      expect(chain).toBe(sentinel);
      // cache now holds the same reference
      expect(getInheritanceCache().get('IRSolo')).toBe(sentinel);
    } finally {
      (registered as any).inheritanceChain = undefined;
    }
  });

  it('stops at a framework base class named in `extends`', () => {
    // Synthetic class whose extends points straight at SmrtClass (framework base)
    addSyntheticClass('@test/ir:FrameworkExtender', {
      name: 'FrameworkExtender',
      qualifiedName: '@test/ir:FrameworkExtender',
      constructor: SmrtObject,
      config: {},
      fields: new Map(),
      methods: new Map(),
      packageName: '@test/ir',
      extends: 'SmrtClass',
    });

    const chain = getInheritanceChain('@test/ir:FrameworkExtender');
    expect(chain).toEqual(['@test/ir:FrameworkExtender']);
  });

  it('gracefully ends the chain when a named parent is not registered', () => {
    addSyntheticClass('@test/ir:OrphanLeaf', {
      name: 'OrphanLeaf',
      qualifiedName: '@test/ir:OrphanLeaf',
      constructor: SmrtObject,
      config: {},
      fields: new Map(),
      methods: new Map(),
      packageName: '@test/ir',
      extends: 'GhostParentNeverRegistered',
    });

    const chain = getInheritanceChain('@test/ir:OrphanLeaf');
    // Chain still includes the leaf; missing parent just terminates the walk.
    expect(chain).toEqual(['@test/ir:OrphanLeaf']);
  });

  it('detects a multi-node cycle, warns, and does NOT cache the broken chain', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Two distinct registrations that point at each other by qualified extends.
    const cycleA: any = {
      name: 'CycleNodeA',
      qualifiedName: '@test/ir:CycleNodeA',
      constructor: SmrtObject,
      config: {},
      fields: new Map(),
      methods: new Map(),
      packageName: '@test/ir',
      extends: '@test/ir:CycleNodeB',
    };
    const cycleB: any = {
      name: 'CycleNodeB',
      qualifiedName: '@test/ir:CycleNodeB',
      constructor: SmrtObject,
      config: {},
      fields: new Map(),
      methods: new Map(),
      packageName: '@test/ir',
      extends: '@test/ir:CycleNodeA',
    };
    addSyntheticClass('@test/ir:CycleNodeA', cycleA);
    addSyntheticClass('@test/ir:CycleNodeB', cycleB);

    const chain = getInheritanceChain('@test/ir:CycleNodeA');
    expect(chain.length).toBeGreaterThan(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Circular inheritance detected'),
    );
    // Broken (circular) chains must not be cached.
    expect(getInheritanceCache().get('@test/ir:CycleNodeA')).toBeUndefined();
  });

  it('treats a self-referential single node as expected (no warn, cached)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A class whose extends resolves back to itself (same package + name).
    const selfRef: any = {
      name: 'SelfRef',
      qualifiedName: '@test/ir:SelfRef',
      constructor: SmrtObject,
      config: {},
      fields: new Map(),
      methods: new Map(),
      packageName: '@test/ir',
      extends: 'SelfRef',
    };
    addSyntheticClass('@test/ir:SelfRef', selfRef);

    const chain = getInheritanceChain('@test/ir:SelfRef');
    expect(chain).toEqual(['@test/ir:SelfRef']);
    // chain.length === 1 → not treated as a misconfigured cycle
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Circular inheritance detected'),
    );
  });
});

describe('inheritance-resolver: getAllFields (module)', () => {
  it('returns an empty map for an unregistered class that cannot be loaded', async () => {
    const fields = await getAllFields('NoSuchClassForFieldsXYZ');
    expect(fields.size).toBe(0);
  });

  it('merges fields across the full inheritance chain and prepends system fields', async () => {
    const fields = await getAllFields('IRLeaf');

    // Own + inherited declared fields
    expect(fields.has('baseTitle')).toBe(true); // IRBase
    expect(fields.has('shared')).toBe(true); // IRBase
    expect(fields.has('middleField')).toBe(true); // IRMiddle
    expect(fields.has('leafField')).toBe(true); // IRLeaf

    // System fields prepended
    expect(fields.has('id')).toBe(true);
    expect(fields.has('slug')).toBe(true);
    expect(fields.has('created_at')).toBe(true);
  });

  it('returns the cached inheritedFields when already populated (with system fields)', async () => {
    const registered = ObjectRegistry.getClass('IRSolo');
    expect(registered).toBeDefined();
    (registered as any).inheritedFields = new Map([
      ['cachedOnly', { type: 'text', _meta: {} }],
    ]);
    try {
      const fields = await getAllFields('IRSolo');
      expect(fields.has('cachedOnly')).toBe(true);
      // prependSmrtSystemFields still runs on the cached map
      expect(fields.has('id')).toBe(true);
    } finally {
      (registered as any).inheritedFields = undefined;
    }
  });

  it('rewrites SmrtHierarchical parentId into a self-referential foreignKey', async () => {
    const fields = await getAllFields('IRTreeNode');
    const parentId = fields.get('parentId');
    expect(parentId).toBeDefined();
    // normalizeFrameworkInheritedField turns it into a nullable FK back to the child
    expect(parentId.type).toBe('foreignKey');
    expect(parentId.related).toBe('IRTreeNode');
    expect(parentId.required).toBe(false);
    expect(parentId._meta?.nullable).toBe(true);
  });
});

describe('inheritance-resolver: getAllMethods (module)', () => {
  it('returns an empty map for an unregistered class', async () => {
    const methods = await getAllMethods('NoSuchClassForMethodsXYZ');
    expect(methods.size).toBe(0);
  });

  it('merges methods across the chain with child overriding parent', async () => {
    const methods = await getAllMethods('IRLeaf');
    expect(methods.has('baseMethod')).toBe(true); // declared on IRBase, overridden on IRLeaf
    expect(methods.has('middleMethod')).toBe(true); // IRMiddle
  });

  it('serves cached inheritedMethods on the second call', async () => {
    const registered = ObjectRegistry.getClass('IRMiddle');
    expect(registered).toBeDefined();
    (registered as any).inheritedMethods = undefined;

    const first = await getAllMethods('IRMiddle');
    // populate cache and re-call
    const second = await getAllMethods('IRMiddle');
    expect(Array.from(second.keys()).sort()).toEqual(
      Array.from(first.keys()).sort(),
    );
    expect((registered as any).inheritedMethods).toBeDefined();
  });
});

describe('inheritance-resolver: mergeFieldConfigs', () => {
  it('child type wins and warns on a genuine type mismatch', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeFieldConfigs(
      { type: 'text', _meta: {} },
      { type: 'integer', _meta: {} },
      'someField',
    );
    expect(merged.type).toBe('integer');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Field type mismatch'),
    );
  });

  it('suppresses the warning for a tenantId field type conflict', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeFieldConfigs(
      { type: 'foreignKey', __tenancy: { isTenantIdField: true }, _meta: {} },
      { type: 'text', _meta: {} },
      'tenantId',
    );
    // child type still wins...
    expect(merged.type).toBe('text');
    // ...but no warning for the known decorator/AST tenantId mismatch
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Field type mismatch'),
    );
  });

  it('takes the strictest numeric min/max from parent and child _meta', () => {
    const merged = mergeFieldConfigs(
      { type: 'integer', _meta: { min: 0, max: 100 } },
      { type: 'integer', _meta: { min: 10, max: 80 } },
      'amount',
    );
    expect(merged._meta.min).toBe(10); // larger min = stricter lower bound
    expect(merged._meta.max).toBe(80); // smaller max = stricter upper bound
  });

  it('combines parent and child validators (both must pass)', async () => {
    const parentValidate = vi.fn(async (v: number) => v > 0);
    const childValidate = vi.fn(async (v: number) => v < 100);
    const merged = mergeFieldConfigs(
      { type: 'integer', _meta: { validate: parentValidate } },
      { type: 'integer', _meta: { validate: childValidate } },
      'amount',
    );

    expect(await merged._meta.validate(50)).toBe(true); // both pass
    expect(await merged._meta.validate(-1)).toBe(false); // parent fails
    expect(await merged._meta.validate(150)).toBe(false); // child fails
    expect(parentValidate).toHaveBeenCalled();
    expect(childValidate).toHaveBeenCalled();
  });

  it('ORs the unique flag (unique if either parent or child says so)', () => {
    const merged = mergeFieldConfigs(
      { type: 'text', _meta: { unique: false } },
      { type: 'text', _meta: { unique: true } },
      'email',
    );
    expect(merged._meta.unique).toBe(true);
  });

  it('preserves __tenancy with parent (decorator) precedence', () => {
    const merged = mergeFieldConfigs(
      {
        type: 'foreignKey',
        __tenancy: { isTenantIdField: true, src: 'parent' },
      },
      { type: 'text', __tenancy: { isTenantIdField: false, src: 'child' } },
      'tenantId',
    );
    // parent (decorator) wins on the overlapping keys
    expect(merged.__tenancy.isTenantIdField).toBe(true);
    expect(merged.__tenancy.src).toBe('parent');
  });

  it('lets the child override the default value', () => {
    const merged = mergeFieldConfigs(
      { type: 'text', value: 'parentDefault' },
      { type: 'text', value: 'childDefault' },
      'label',
    );
    expect(merged.value).toBe('childDefault');
  });

  it('keeps the parent value when the child does not define one', () => {
    const merged = mergeFieldConfigs(
      { type: 'text', value: 'parentDefault' },
      { type: 'text' },
      'label',
    );
    expect(merged.value).toBe('parentDefault');
  });
});

describe('inheritance-resolver: end-to-end constraint merge via getAllFields', () => {
  it('applies the strictest numeric constraints from the chain', async () => {
    const fields = await getAllFields('IRConstraintChild');
    const amount = fields.get('amount');
    expect(amount).toBeDefined();
    expect(amount._meta.min).toBe(10);
    expect(amount._meta.max).toBe(80);
    // Reference the parent fixture so the import is load-bearing.
    expect(typeof IRConstraintChild).toBe('function');
  });
});
