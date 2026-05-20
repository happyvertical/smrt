/**
 * Tests for SmrtHierarchical base class.
 *
 * Covers:
 * - getParent / getChildren happy path + nullability
 * - getAncestors ordering (root-first) + cycle protection
 * - getDescendants (BFS, batched) + cycle protection
 * - getHierarchy aggregates ancestors + self + descendants
 * - moveTo accepts id / instance / null; refuses self-loop + descendant cycle
 * - Abstract-base guard: hierarchy methods throw when called on a bare
 *   `SmrtHierarchical` instance.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtHierarchical } from '../hierarchical';
import { ObjectRegistry, smrt } from '../registry';

@smrt({
  tableName: 'hierarchical_test_nodes',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class HierarchicalTestNode extends SmrtHierarchical {
  name = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

@smrt()
class HierarchicalTestNodeCollection extends SmrtCollection<HierarchicalTestNode> {
  static readonly _itemClass = HierarchicalTestNode;
}

function tmpDbUrl(name: string): string {
  return `file:${join(
    tmpdir(),
    `smrt-hierarchical-test-${name}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.db`,
  )}`;
}

describe('SmrtHierarchical', () => {
  let dbPath: string;
  let dbUrl: string;
  let nodes: HierarchicalTestNodeCollection;

  /**
   * Build a small forest:
   *
   *     root
   *     ├── a
   *     │   ├── a1
   *     │   └── a2
   *     │       └── a2x
   *     └── b
   *
   *     orphan (separate tree, no parent)
   */
  async function buildForest() {
    const root = await nodes.create({ name: 'root' });
    await root.save();
    const a = await nodes.create({ name: 'a', parentId: root.id });
    await a.save();
    const b = await nodes.create({ name: 'b', parentId: root.id });
    await b.save();
    const a1 = await nodes.create({ name: 'a1', parentId: a.id });
    await a1.save();
    const a2 = await nodes.create({ name: 'a2', parentId: a.id });
    await a2.save();
    const a2x = await nodes.create({ name: 'a2x', parentId: a2.id });
    await a2x.save();
    const orphan = await nodes.create({ name: 'orphan' });
    await orphan.save();
    return { root, a, b, a1, a2, a2x, orphan };
  }

  beforeEach(async () => {
    dbUrl = tmpDbUrl('basic');
    dbPath = dbUrl.replace('file:', '');
    nodes = await HierarchicalTestNodeCollection.create({
      db: { type: 'sqlite', url: dbUrl },
    });
  });

  afterEach(() => {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  describe('getParent', () => {
    it('returns null when row has no parent', async () => {
      const { root } = await buildForest();
      expect(await root.getParent()).toBeNull();
    });

    it('returns the parent row when set', async () => {
      const { root, a } = await buildForest();
      const parent = await a.getParent();
      expect(parent?.id).toBe(root.id);
      expect(parent?.name).toBe('root');
    });
  });

  describe('getChildren', () => {
    it('returns immediate children only', async () => {
      const { root, a, b } = await buildForest();
      const children = await root.getChildren();
      const ids = children.map((c) => c.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
    });

    it('returns empty array for a leaf', async () => {
      const { a1 } = await buildForest();
      expect(await a1.getChildren()).toEqual([]);
    });

    it('returns empty array for an unsaved instance', async () => {
      const unsaved = await nodes.create({ name: 'unsaved' });
      expect(await unsaved.getChildren()).toEqual([]);
    });
  });

  describe('getAncestors', () => {
    it('returns ancestors root-first, excluding self', async () => {
      const { root, a, a2, a2x } = await buildForest();
      const ancestors = await a2x.getAncestors();
      expect(ancestors.map((n) => n.id)).toEqual([root.id, a.id, a2.id]);
    });

    it('returns empty array for a root row', async () => {
      const { root } = await buildForest();
      expect(await root.getAncestors()).toEqual([]);
    });

    it('terminates cleanly when the chain forms a cycle', async () => {
      const { a, a2 } = await buildForest();
      // Manually corrupt: point `a` at its own descendant `a2`. Now
      // a.parentId === a2.id and a2's chain goes a2 → a → a2 → …
      a.parentId = a2.id;
      await a.save();
      const reloaded = (await nodes.get({
        id: a.id,
      })) as HierarchicalTestNode;
      const ancestors = await reloaded.getAncestors();
      // Walk should stop instead of looping forever; exact contents depend
      // on traversal order but length must be bounded.
      expect(ancestors.length).toBeLessThan(10);
    });
  });

  describe('getDescendants', () => {
    it('returns all descendants in BFS order', async () => {
      const { root, a, b, a1, a2, a2x } = await buildForest();
      const descendants = await root.getDescendants();
      const ids = descendants.map((n) => n.id);
      // a and b must appear before a1/a2 (BFS), and a2x must appear last
      expect(ids.slice(0, 2).sort()).toEqual([a.id, b.id].sort());
      expect(ids.slice(2, 4).sort()).toEqual([a1.id, a2.id].sort());
      expect(ids[4]).toBe(a2x.id);
    });

    it('returns empty array for a leaf', async () => {
      const { a1 } = await buildForest();
      expect(await a1.getDescendants()).toEqual([]);
    });

    it('does not bleed across unrelated trees', async () => {
      const { root, orphan } = await buildForest();
      const descendants = await root.getDescendants();
      expect(descendants.find((n) => n.id === orphan.id)).toBeUndefined();
    });
  });

  describe('getHierarchy', () => {
    it('returns ancestors + self + descendants together', async () => {
      const { root, a, a1, a2, a2x } = await buildForest();
      const { ancestors, current, descendants } = await a.getHierarchy();
      expect(ancestors.map((n) => n.id)).toEqual([root.id]);
      expect(current.id).toBe(a.id);
      expect(descendants.map((n) => n.id).sort()).toEqual(
        [a1.id, a2.id, a2x.id].sort(),
      );
    });
  });

  describe('moveTo', () => {
    it('accepts a target instance and persists the new parent', async () => {
      const { b, a2 } = await buildForest();
      await b.moveTo(a2);
      const reloaded = (await nodes.get({
        id: b.id,
      })) as HierarchicalTestNode;
      expect(reloaded.parentId).toBe(a2.id);
    });

    it('accepts a target id string', async () => {
      const { b, a2 } = await buildForest();
      await b.moveTo(a2.id as string);
      const reloaded = (await nodes.get({
        id: b.id,
      })) as HierarchicalTestNode;
      expect(reloaded.parentId).toBe(a2.id);
    });

    it('accepts null to promote to root', async () => {
      const { a } = await buildForest();
      await a.moveTo(null);
      const reloaded = (await nodes.get({
        id: a.id,
      })) as HierarchicalTestNode;
      expect(reloaded.parentId).toBeNull();
    });

    it('refuses self-loop', async () => {
      const { a } = await buildForest();
      await expect(a.moveTo(a)).rejects.toThrow(/itself/);
    });

    it('refuses moving under one of its own descendants', async () => {
      const { a, a2x } = await buildForest();
      await expect(a.moveTo(a2x)).rejects.toThrow(/cycle/i);
    });
  });

  describe('abstract-base guard', () => {
    it('throws when hierarchy methods are called on a bare SmrtHierarchical instance', async () => {
      class BareHierarchical extends SmrtHierarchical {}
      // Bypass subclass — instantiate the base directly via Object.create
      // so `this.constructor === SmrtHierarchical`.
      const bare = Object.create(
        SmrtHierarchical.prototype,
      ) as SmrtHierarchical;
      bare.parentId = 'some-id';
      (bare as any).id = 'self-id';
      (bare as any).options = {};
      await expect(bare.getChildren()).rejects.toThrow(/abstract/);
      // Sanity: a real subclass should NOT throw the abstract error
      const subclass = new BareHierarchical({} as any);
      expect(subclass).toBeInstanceOf(SmrtHierarchical);
    });
  });
});

/**
 * Cross-package qualified-name disambiguation
 *
 * Exercises the constructor prototype-chain walk in
 * `_hierarchyCollection`. Two hierarchical classes share the SAME simple
 * name (`CollisionDoc`) but are registered under different package
 * contexts. The constructor identities are unique even though the names
 * collide, so the walk should resolve each instance to ITS package's
 * qualified registration rather than picking whichever registration won
 * the simple-name lookup race.
 *
 * Pre-PR-#1269 behavior: `_hierarchyCollection` called
 * `ObjectRegistry.getCollection(this.constructor.name)` — the simple
 * name `'CollisionDoc'` — and `findClass` would pick one registration
 * arbitrarily (whichever entry won the classNameMap iteration, or
 * throw on ambiguity).
 *
 * Post-PR-#1269 behavior: the constructor reference uniquely identifies
 * the right registration regardless of name collision.
 *
 * Setting up a true cross-package registry collision in-process is
 * non-trivial (the registry's package-name inference reads stack
 * traces and manifest data), so this suite stubs
 * `ObjectRegistry.getClassByConstructor` to return synthetic
 * registrations keyed by constructor identity, then asserts the
 * qualified name produced by `_hierarchyCollection` matches the
 * constructor that was instantiated. That's exactly the property the
 * fix is supposed to preserve.
 */
describe('SmrtHierarchical cross-package qualified-name disambiguation', () => {
  // Two distinct constructors with the SAME simple `.name`. The
  // `class CollisionDoc extends SmrtHierarchical {}` expression literal
  // gives each `const` a class whose `.name === 'CollisionDoc'`, but
  // the constructors are distinct values in JS — `DocA !== DocB`.
  const DocA = class CollisionDoc extends SmrtHierarchical {
    marker = 'A';
  };
  const DocB = class CollisionDoc extends SmrtHierarchical {
    marker = 'B';
  };

  // Synthetic registrations keyed by constructor reference, returned
  // by the stubbed `getClassByConstructor` below.
  const regByCtor = new Map<Function, any>([
    [
      DocA,
      {
        name: 'CollisionDoc',
        qualifiedName: '@test/package-a:CollisionDoc',
        config: {},
      },
    ],
    [
      DocB,
      {
        name: 'CollisionDoc',
        qualifiedName: '@test/package-b:CollisionDoc',
        config: {},
      },
    ],
  ]);

  let getClassByConstructorSpy: ReturnType<typeof vi.spyOn>;
  let getCollectionSpy: ReturnType<typeof vi.spyOn>;
  const getCollectionCalls: string[] = [];

  beforeEach(() => {
    getCollectionCalls.length = 0;
    getClassByConstructorSpy = vi
      .spyOn(ObjectRegistry, 'getClassByConstructor')
      .mockImplementation(
        (ctor: any) => regByCtor.get(ctor) ?? undefined,
      ) as any;
    getCollectionSpy = vi
      .spyOn(ObjectRegistry, 'getCollection')
      .mockImplementation(async (className: string) => {
        getCollectionCalls.push(className);
        // Return a minimal mock — the test only cares which className
        // was passed in. Cast as any since SmrtCollection's shape is
        // larger than what we need here.
        return { tableName: `mock-table-for-${className}` } as any;
      }) as any;
  });

  afterEach(() => {
    getClassByConstructorSpy.mockRestore();
    getCollectionSpy.mockRestore();
  });

  it('resolves each constructor to ITS own qualified name despite sharing a simple name', async () => {
    const a = new DocA({} as any);
    const b = new DocB({} as any);

    await (a as any)._hierarchyCollection();
    await (b as any)._hierarchyCollection();

    expect(getCollectionCalls).toEqual([
      '@test/package-a:CollisionDoc',
      '@test/package-b:CollisionDoc',
    ]);
  });

  it('walks past intermediate STI subclasses to the OLDEST STI base', async () => {
    // `Child extends Mid extends StiRoot extends SmrtHierarchical`.
    // StiRoot declares tableStrategy:'sti'; the walk should land there
    // (the OLDEST STI ancestor), NOT on Mid or Child.
    const StiRoot = class StiBase extends SmrtHierarchical {};
    const Mid = class StiMid extends StiRoot {};
    const Child = class StiChild extends Mid {};

    regByCtor.set(StiRoot, {
      name: 'StiBase',
      qualifiedName: '@test/sti-pkg:StiBase',
      config: { tableStrategy: 'sti' },
    });
    regByCtor.set(Mid, {
      name: 'StiMid',
      qualifiedName: '@test/sti-pkg:StiMid',
      config: {},
    });
    regByCtor.set(Child, {
      name: 'StiChild',
      qualifiedName: '@test/sti-pkg:StiChild',
      config: {},
    });

    const inst = new Child({} as any);
    await (inst as any)._hierarchyCollection();

    expect(getCollectionCalls).toEqual(['@test/sti-pkg:StiBase']);
  });

  it('terminates cleanly without registry lookups against Function/Object prototypes', async () => {
    // Constructor that isn't registered anywhere should walk up its
    // chain (Function.prototype → Object.prototype → null) without
    // throwing and without the lookup being invoked with Function or
    // Object themselves (the loop terminates at the prototype-object
    // boundaries — round-1 review fix).
    const Unregistered = class UnregisteredDoc extends SmrtHierarchical {};
    // Deliberately NOT in regByCtor — getClassByConstructor returns
    // undefined for it.

    const inst = new Unregistered({} as any);
    await (inst as any)._hierarchyCollection();

    // collectionClass falls back to `this.constructor.name` since
    // no registration and no STI base were found. The fix should leave
    // that fallback path intact.
    expect(getCollectionCalls).toEqual(['UnregisteredDoc']);

    // Sanity: getClassByConstructor was called for the leaf ctor itself,
    // never for `Function.prototype` or `Object.prototype` (the
    // termination conditions skip them).
    const callArgs = getClassByConstructorSpy.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(callArgs).not.toContain(Function.prototype);
    expect(callArgs).not.toContain(Object.prototype);
  });
});
