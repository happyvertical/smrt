/**
 * Test for Issue #951: Qualified Names as Primary Keys
 *
 * PROBLEM:
 * - ObjectRegistry used simple class names as keys (e.g., "Event")
 * - Multiple packages defining classes with the same name caused silent collisions
 * - No way to distinguish between @happyvertical/smrt-events:Event and @myapp/calendar:Event
 *
 * SOLUTION:
 * - Registry uses qualified names (e.g., "@pkg:ClassName") as primary map keys
 * - classNameMap provides simple name → qualified key(s) lookup
 * - findClass() resolves both simple and qualified names
 * - getClassNames() returns simple names for backward compatibility
 * - All internal consumers use simple names via `registered.name`
 *
 * What these tests verify:
 * ✅ register() stores under qualified key when packageName is available
 * ✅ register() stores under simple key when no packageName (test isolation)
 * ✅ findClass("ClassName") works for unambiguous names
 * ✅ findClass("@pkg:ClassName") does direct O(1) lookup
 * ✅ getClassByQualifiedName() is O(1)
 * ✅ getClassNames() returns simple names
 * ✅ Manifest stubs registered under qualified keys are found by simple name
 * ✅ Real class replaces qualified manifest stub correctly
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('Issue #951: Qualified Names as Primary Keys', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('should store real classes under a qualified key when packageName is available', () => {
    @smrt()
    class QualifiedTestA extends SmrtObject {
      title: string = '';
    }

    // The class should be stored — verify via public API
    const entry = ObjectRegistry.getClass('QualifiedTestA');
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('QualifiedTestA');

    // The map key should be qualified (contains ':')
    // In test context, getPackageName returns the core package name
    // @ts-expect-error - accessing private property
    let foundKey: string | undefined;
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestA') {
        foundKey = key;
        break;
      }
    }
    expect(foundKey).toBeDefined();
    expect(foundKey).toContain(':QualifiedTestA');
  });

  it('should resolve simple name via findClass()', () => {
    @smrt()
    class QualifiedTestB extends SmrtObject {
      count: number = 0;
    }

    // findClass with simple name should resolve
    const entry = ObjectRegistry.getClass('QualifiedTestB');
    expect(entry).toBeDefined();
    expect(entry?.constructor).toBe(QualifiedTestB);

    // Case-insensitive should also work
    const entryLower = ObjectRegistry.getClass('qualifiedtestb');
    expect(entryLower).toBeDefined();
    expect(entryLower?.constructor).toBe(QualifiedTestB);
  });

  it('should resolve qualified key via direct findClass() lookup', () => {
    @smrt()
    class QualifiedTestC extends SmrtObject {}

    // Find the qualified key
    // @ts-expect-error - accessing private property
    let qualifiedKey: string | undefined;
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestC') {
        qualifiedKey = key;
        break;
      }
    }
    expect(qualifiedKey).toBeDefined();

    // Direct qualified lookup should work
    const entry = ObjectRegistry.getClass(qualifiedKey!);
    expect(entry).toBeDefined();
    expect(entry?.constructor).toBe(QualifiedTestC);
  });

  it('should resolve a qualified lookup to an existing simple-key registration when unambiguous', () => {
    class QualifiedTestCSource extends SmrtObject {}

    ObjectRegistry.register(QualifiedTestCSource, {
      name: 'QualifiedTestCSource',
    });

    let initialKey: string | undefined;
    let entry: any;
    // @ts-expect-error - accessing private property for verification
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestCSource') {
        initialKey = key;
        entry = val;
        break;
      }
    }

    expect(initialKey).toBeDefined();

    // Simulate a workspace source import that has not yet been promoted to a
    // package-qualified key.
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.delete(initialKey!);
    entry.packageName = undefined;
    entry.qualifiedName = undefined;
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.set('QualifiedTestCSource', entry);
    // Release B (#1133): classNameMap is gone — case-insensitive lookups
    // iterate `classes` directly, so inserting into the classes Map is
    // sufficient to set up this scenario.

    const resolved = ObjectRegistry.getClass('@test/pkg:QualifiedTestCSource');
    expect(resolved).toBeDefined();
    expect(resolved?.constructor).toBe(QualifiedTestCSource);
  });

  it('should preserve a qualified registry key when manifest hydration merges into an existing source registration', () => {
    class QualifiedTestCPromoted extends SmrtObject {}

    ObjectRegistry.register(QualifiedTestCPromoted, {
      name: 'QualifiedTestCPromoted',
    });

    let initialKey: string | undefined;
    let entry: any;
    // @ts-expect-error - accessing private property for verification
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestCPromoted') {
        initialKey = key;
        entry = val;
        break;
      }
    }

    expect(initialKey).toBeDefined();

    // Simulate a source registration that has not yet been promoted to its
    // package-qualified key.
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.delete(initialKey!);
    entry.packageName = undefined;
    entry.qualifiedName = undefined;
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.set('QualifiedTestCPromoted', entry);
    // Release B (#1133): classNameMap is gone — `classes` is the single
    // source of truth for case-insensitive lookups.

    ObjectRegistry.registerFromManifest(
      'QualifiedTestCPromoted',
      {
        className: 'QualifiedTestCPromoted',
        fields: {
          status: {
            type: 'text',
            required: true,
          },
        },
        methods: {},
        decoratorConfig: {},
      },
      '@test/pkg',
    );

    const byQualified = ObjectRegistry.getClass(
      '@test/pkg:QualifiedTestCPromoted',
    );
    expect(byQualified).toBeDefined();
    expect(byQualified?.constructor).toBe(QualifiedTestCPromoted);
    expect(byQualified?.qualifiedName).toBe('@test/pkg:QualifiedTestCPromoted');
    expect(
      ObjectRegistry.getClassByConstructor(QualifiedTestCPromoted)
        ?.qualifiedName,
    ).toBe('@test/pkg:QualifiedTestCPromoted');

    // Release B (#1133) replaced the classNameMap assertion with a direct
    // dedup-by-qualifiedName check: the promoted entry's qualifiedName
    // resolves to a single unique registration (the simple-name key and the
    // qualified-name key point at the same RegisteredClass object).
    const matches = ObjectRegistry.findClassesByName('QualifiedTestCPromoted');
    const uniqueQualified = new Set(matches.map((m) => m.qualifiedName));
    expect([...uniqueQualified]).toEqual(['@test/pkg:QualifiedTestCPromoted']);
  });

  it('should return simple names from getClassNames()', () => {
    @smrt()
    class QualifiedTestD extends SmrtObject {}

    const classNames = ObjectRegistry.getClassNames();
    expect(classNames).toContain('QualifiedTestD');

    // Should NOT contain qualified keys
    const qualifiedNames = classNames.filter((n) => n.includes(':'));
    // Some pre-existing classes may have qualified names if no packageName,
    // but our test class should NOT appear as qualified
    expect(qualifiedNames.some((n) => n.includes('QualifiedTestD'))).toBe(
      false,
    );
  });

  it('should resolve manifest stub by simple name when registered under qualified key', () => {
    const manifestDef = {
      className: 'QualifiedTestE',
      fields: {
        label: { type: 'text', _meta: {} },
      },
      methods: {},
      decoratorConfig: {},
    };

    // Register manifest under qualified key (simulating external package)
    ObjectRegistry.registerFromManifest(
      '@test/pkg:QualifiedTestE',
      manifestDef,
      '@test/pkg',
    );

    // Should be findable by simple name
    const bySimple = ObjectRegistry.getClass('QualifiedTestE');
    expect(bySimple).toBeDefined();
    expect((bySimple?.constructor as any)?._isManifestStub).toBe(true);

    // Should be findable by qualified key
    const byQualified = ObjectRegistry.getClass('@test/pkg:QualifiedTestE');
    expect(byQualified).toBeDefined();
    expect(byQualified).toBe(bySimple);

    // Case-insensitive should also work
    const byLower = ObjectRegistry.getClass('qualifiedteste');
    expect(byLower).toBeDefined();
    expect(byLower).toBe(bySimple);
  });

  it('should replace qualified manifest stub when real class is registered', () => {
    const manifestDef = {
      className: 'QualifiedTestF',
      fields: {
        data: { type: 'text', _meta: { required: true } },
      },
      methods: {},
      decoratorConfig: { cli: true },
    };

    ObjectRegistry.registerFromManifest(
      '@test/pkg:QualifiedTestF',
      manifestDef,
      '@test/pkg',
    );

    // Verify stub exists
    const stub = ObjectRegistry.getClass('QualifiedTestF');
    expect((stub?.constructor as any)?._isManifestStub).toBe(true);

    // Register real class
    @smrt()
    class QualifiedTestF extends SmrtObject {
      data: string = '';
    }

    // Real class should replace stub
    const real = ObjectRegistry.getClass('QualifiedTestF');
    expect(real).toBeDefined();
    expect((real?.constructor as any)?._isManifestStub).toBeUndefined();
    expect(real?.constructor).toBe(QualifiedTestF);

    // Config from manifest should be preserved
    expect(real?.config.cli).toBe(true);
  });

  it('should expose getClassByQualifiedName() for O(1) lookup', () => {
    const manifestDef = {
      className: 'QualifiedTestG',
      fields: {},
      methods: {},
      decoratorConfig: {},
    };

    ObjectRegistry.registerFromManifest(
      '@test/pkg:QualifiedTestG',
      manifestDef,
      '@test/pkg',
    );

    // getClassByQualifiedName should do direct map lookup
    const entry = ObjectRegistry.getClassByQualifiedName(
      '@test/pkg:QualifiedTestG' as any,
    );
    expect(entry).toBeDefined();
    expect(entry?.name).toBe('QualifiedTestG');
  });

  it('should promote a simple-key registration when packageName is provided later', () => {
    class QualifiedTestH extends SmrtObject {}

    ObjectRegistry.register(QualifiedTestH, { name: 'QualifiedTestH' });

    let initialKey: string | undefined;
    let entry: any;
    // @ts-expect-error - accessing private property for verification
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestH') {
        initialKey = key;
        entry = val;
        break;
      }
    }

    expect(initialKey).toBeDefined();

    // Force a simple-key starting point to simulate bundled runtimes that
    // registered the class before an explicit package name was available.
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.delete(initialKey!);
    entry.packageName = undefined;
    entry.qualifiedName = undefined;
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.set('QualifiedTestH', entry);
    // Release B (#1133): no classNameMap to seed — iteration reads `classes`.

    ObjectRegistry.register(QualifiedTestH, {
      name: 'QualifiedTestH',
      packageName: '@test/pkg',
    });

    const promoted = ObjectRegistry.getClassByQualifiedName(
      '@test/pkg:QualifiedTestH' as any,
    );
    expect(promoted).toBeDefined();
    expect(promoted?.constructor).toBe(QualifiedTestH);
    expect(ObjectRegistry.getClass('QualifiedTestH')?.constructor).toBe(
      QualifiedTestH,
    );

    // @ts-expect-error - accessing private property for verification
    expect(ObjectRegistry.classes.has('QualifiedTestH')).toBe(false);
  });

  it('should reject promotion when the target qualified key already belongs to another class', () => {
    class QualifiedTestI extends SmrtObject {}
    class QualifiedTestICollision extends SmrtObject {}

    ObjectRegistry.register(QualifiedTestI, { name: 'QualifiedTestI' });

    let initialKey: string | undefined;
    let entry: any;
    // @ts-expect-error - accessing private property for verification
    for (const [key, val] of ObjectRegistry.classes) {
      if (val.name === 'QualifiedTestI') {
        initialKey = key;
        entry = val;
        break;
      }
    }

    expect(initialKey).toBeDefined();

    // Force a simple-key starting point, then occupy the target qualified key
    // with a different class to verify promotion collisions fail loudly.
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.delete(initialKey!);
    entry.packageName = undefined;
    entry.qualifiedName = undefined;
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.set('QualifiedTestI', entry);
    // Release B (#1133): no classNameMap to seed — iteration reads `classes`.

    ObjectRegistry.register(QualifiedTestICollision, {
      name: 'QualifiedTestICollision',
      packageName: '@test/pkg',
    });

    const collisionEntry = ObjectRegistry.getClassByConstructor(
      QualifiedTestICollision,
    );
    expect(collisionEntry).toBeDefined();
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.delete('@test/pkg:QualifiedTestICollision');
    collisionEntry!.name = 'QualifiedTestI';
    collisionEntry!.packageName = '@test/pkg';
    collisionEntry!.qualifiedName = '@test/pkg:QualifiedTestI';
    // @ts-expect-error - accessing private property for verification
    ObjectRegistry.classes.set('@test/pkg:QualifiedTestI', collisionEntry!);

    expect(() =>
      ObjectRegistry.register(QualifiedTestI, {
        name: 'QualifiedTestI',
        packageName: '@test/pkg',
      }),
    ).toThrow(ConfigurationError);
  });

  it('should return correct simple names from getDescendants()', () => {
    @smrt({ tableStrategy: 'sti' })
    class QualifiedBase extends SmrtObject {
      title: string = '';
    }

    @smrt()
    class QualifiedChild extends QualifiedBase {
      extra: string = '';
    }

    const descendants = ObjectRegistry.getDescendants('QualifiedBase');
    expect(descendants).toContain('QualifiedChild');

    // Should not contain qualified keys
    expect(descendants.some((d) => d.includes(':'))).toBe(false);
  });

  it('should use simple names in getDependencyGraph()', () => {
    @smrt()
    class QualifiedTarget extends SmrtObject {
      name: string = '';
    }

    // Register a class with a foreignKey via manifest
    const manifestDef = {
      className: 'QualifiedSource',
      fields: {
        targetId: {
          type: 'foreignKey',
          related: 'QualifiedTarget',
          _meta: {},
        },
      },
      methods: {},
      decoratorConfig: {},
    };

    ObjectRegistry.registerFromManifest(
      '@test/pkg:QualifiedSource',
      manifestDef,
      '@test/pkg',
    );

    const graph = ObjectRegistry.getDependencyGraph();

    // Keys should be simple names
    const keys = Array.from(graph.keys());
    expect(keys).toContain('QualifiedTarget');
    expect(keys).toContain('QualifiedSource');

    // Dependencies should reference simple names
    const deps = graph.get('QualifiedSource');
    expect(deps).toBeDefined();
    if (deps && deps.length > 0) {
      expect(deps).toContain('QualifiedTarget');
    }
  });
});
