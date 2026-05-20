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
 * Two hierarchical classes share the SAME simple name (`CollisionDoc`)
 * but live in different package contexts. Each instance's
 * `_hierarchyCollection()` must resolve to ITS own qualified collection
 * rather than picking whichever registration won the simple-name lookup
 * race.
 *
 * After R5-canon, the resolution is:
 *
 *   1. Read `ctor._smrtQualifiedName` (set by the registry at
 *      registration on every registered class).
 *   2. Fall back to `ObjectRegistry.getClassByConstructor(ctor)?.
 *      qualifiedName` when the static isn't present.
 *   3. Fall back to the simple `ctor.name` only when nothing is
 *      registered at all.
 *
 * The result is passed through `ObjectRegistry.getSTIBase(...)` (which
 * also returns a qualified name in R5-canon) before reaching
 * `getCollection`. The whole pipeline is qualified-name-canonical end
 * to end, so the previous prototype-chain walk workaround (added in
 * #1269 when `getSTIBase` still returned simple names) is now dead
 * code and has been removed.
 */
describe('SmrtHierarchical cross-package qualified-name disambiguation', () => {
  // Two distinct constructors with the SAME simple `.name`. The `class
  // CollisionDoc extends SmrtHierarchical {}` expression literal gives
  // each `const` a class whose `.name === 'CollisionDoc'`, but the
  // constructors are distinct values in JS — `DocA !== DocB`.
  //
  // Why not exercise the `_smrtQualifiedName` static directly here:
  // the test environment's manifest stub auto-loads any
  // `extends SmrtHierarchical` class it finds in the file, then the
  // registry stamps the static under the test runner's own package
  // context (`@happyvertical/smrt-core:CollisionDoc`). That stamping
  // happens lazily on construction and overwrites whatever we set in
  // beforeEach. So we test the disambiguation property the same way
  // PR #1269's suite did — via `getClassByConstructor` mocks that
  // model the WeakMap fallback. The fast-path static read is covered
  // by `class-registration.ts`'s registration unit (separate suite).
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
  let getSTIBaseSpy: ReturnType<typeof vi.spyOn>;
  let getCollectionSpy: ReturnType<typeof vi.spyOn>;
  const getCollectionCalls: string[] = [];
  const getSTIBaseCalls: string[] = [];

  beforeEach(() => {
    // Strip the auto-registered static so the WeakMap fallback path
    // (via the spy below) becomes the source of qualified-name
    // identity for this suite.
    delete (DocA as any)._smrtQualifiedName;
    delete (DocB as any)._smrtQualifiedName;

    getCollectionCalls.length = 0;
    getSTIBaseCalls.length = 0;
    getClassByConstructorSpy = vi
      .spyOn(ObjectRegistry, 'getClassByConstructor')
      .mockImplementation(
        (ctor: any) => regByCtor.get(ctor) ?? undefined,
      ) as any;
    getSTIBaseSpy = vi
      .spyOn(ObjectRegistry, 'getSTIBase')
      .mockImplementation((className: string) => {
        getSTIBaseCalls.push(className);
        return null;
      }) as any;
    getCollectionSpy = vi
      .spyOn(ObjectRegistry, 'getCollection')
      .mockImplementation(async (className: string) => {
        getCollectionCalls.push(className);
        return { tableName: `mock-table-for-${className}` } as any;
      }) as any;
  });

  afterEach(() => {
    getClassByConstructorSpy.mockRestore();
    getSTIBaseSpy.mockRestore();
    getCollectionSpy.mockRestore();
  });

  it('resolves each constructor to ITS own qualified name despite sharing a simple name', async () => {
    const a = new DocA({} as any);
    const b = new DocB({} as any);

    await (a as any)._hierarchyCollection();
    await (b as any)._hierarchyCollection();

    // Both `getSTIBase` and `getCollection` see the per-instance
    // qualified name — never the ambiguous simple `'CollisionDoc'`.
    expect(getSTIBaseCalls).toEqual([
      '@test/package-a:CollisionDoc',
      '@test/package-b:CollisionDoc',
    ]);
    expect(getCollectionCalls).toEqual([
      '@test/package-a:CollisionDoc',
      '@test/package-b:CollisionDoc',
    ]);
  });

  it('routes STI subclasses through the qualified STI base from getSTIBase', async () => {
    // For an STI subclass, `_hierarchyCollection` calls
    // `getSTIBase(qualifiedSubclass)` and passes the qualified base
    // name to `getCollection`. Mock `getSTIBase` to return the base
    // for DocA only.
    getSTIBaseSpy.mockImplementation((className: string) => {
      getSTIBaseCalls.push(className);
      return className === '@test/package-a:CollisionDoc'
        ? '@test/package-a:CollisionDocBase'
        : null;
    });

    const a = new DocA({} as any);
    await (a as any)._hierarchyCollection();

    expect(getSTIBaseCalls).toEqual(['@test/package-a:CollisionDoc']);
    // The STI base's qualified name flows into getCollection, NOT the
    // leaf subclass — that's the property R5-canon guarantees end to
    // end.
    expect(getCollectionCalls).toEqual(['@test/package-a:CollisionDocBase']);
  });

  it('falls back to the simple constructor name when nothing is registered', async () => {
    // Unregistered constructor: no static, no WeakMap entry. The
    // `regByCtor` map returns undefined for any other class.
    //
    // The auto-registration path stamps `_smrtQualifiedName` at
    // construction time, so we delete it AFTER construction and
    // immediately before the lookup runs.
    const Unregistered = class UnregisteredDoc extends SmrtHierarchical {};
    const inst = new Unregistered({} as any);
    delete (Unregistered as any)._smrtQualifiedName;

    await (inst as any)._hierarchyCollection();

    // Lookup receives the bare simple name. `getCollection` will
    // surface the existing "not found in ObjectRegistry" error in
    // production; here we just verify the lookup key is the leaf
    // class name (no static tag, no qualified resolution available).
    expect(getCollectionCalls).toEqual(['UnregisteredDoc']);
  });
});
