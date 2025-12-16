/**
 * Test for Issue #531: CLI returns manifest stubs instead of real classes
 *
 * PROBLEM:
 * - Manifest keys are stored in lowercase (e.g., 'praeco')
 * - Real class names are PascalCase (e.g., 'Praeco')
 * - When real class is registered via @smrt() decorator, case-sensitive check fails
 * - Both 'praeco' (stub) and 'Praeco' (real) end up in registry
 * - CLI finds the stub and reports "class wasn't loaded"
 *
 * SOLUTION:
 * - ObjectRegistry.register() now does case-insensitive check for manifest stubs
 * - When stub is found (case-insensitive), it's replaced with real class
 * - Registry key is updated to use PascalCase name from real class
 *
 * What these tests verify:
 * ✅ Lowercase manifest stub is replaced by PascalCase real class
 * ✅ Registry key is updated to PascalCase after replacement
 * ✅ No duplicate entries exist after replacement
 * ✅ Real class constructor is used, not stub
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

describe('Issue #531: Case-Insensitive Manifest Stub Replacement', () => {
  // Store original registry state
  let originalClasses: Map<string, any>;

  beforeEach(() => {
    // Save registry state before each test
    originalClasses = new Map(ObjectRegistry.getAllClasses());
  });

  afterEach(() => {
    // Restore registry state after each test
    // First clear all added classes
    for (const [name] of ObjectRegistry.getAllClasses()) {
      if (!originalClasses.has(name)) {
        // @ts-expect-error - accessing private property for test cleanup
        ObjectRegistry.classes.delete(name);
      }
    }
  });

  it('should replace lowercase manifest stub with PascalCase real class', () => {
    // Simulate manifest registration (lowercase key)
    const manifestDef = {
      className: 'TestWidget',
      fields: {
        name: { type: 'text', _meta: { required: true } },
      },
      methods: {},
      decoratorConfig: {},
    };

    // Register as lowercase (how manifest keys are stored)
    ObjectRegistry.registerFromManifest(
      'testwidget', // lowercase key
      manifestDef,
      '@test/package',
    );

    // Verify stub is registered
    const stubEntry = ObjectRegistry.findClass('testwidget');
    expect(stubEntry).toBeDefined();
    expect((stubEntry?.constructor as any)?._isManifestStub).toBe(true);

    // Now define and register the real class (PascalCase)
    @smrt()
    class TestWidget extends SmrtObject {
      name: string = '';
    }

    // Verify real class replaced the stub
    const realEntry = ObjectRegistry.findClass('TestWidget');
    expect(realEntry).toBeDefined();
    expect((realEntry?.constructor as any)?._isManifestStub).toBeUndefined();
    expect(realEntry?.constructor).toBe(TestWidget);

    // Verify lowercase key no longer exists (was replaced)
    // @ts-expect-error - accessing private property
    const hasLowercase = ObjectRegistry.classes.has('testwidget');
    expect(hasLowercase).toBe(false);

    // Verify PascalCase key exists
    // @ts-expect-error - accessing private property
    const hasPascalCase = ObjectRegistry.classes.has('TestWidget');
    expect(hasPascalCase).toBe(true);
  });

  it('should preserve manifest metadata when replacing stub', () => {
    // Simulate manifest registration with fields and methods
    const manifestDef = {
      className: 'TestGadget',
      fields: {
        title: { type: 'text', _meta: { required: true } },
        count: { type: 'integer', _meta: {} },
      },
      methods: {
        doSomething: { async: true, parameters: [], returnType: 'void' },
      },
      decoratorConfig: {
        cli: true,
        api: { include: ['list', 'get'] },
      },
    };

    ObjectRegistry.registerFromManifest(
      'testgadget',
      manifestDef,
      '@test/package',
    );

    // Register real class
    @smrt()
    class TestGadget extends SmrtObject {
      title: string = '';
      count: number = 0;
    }

    // Verify metadata was preserved
    const entry = ObjectRegistry.findClass('TestGadget');
    expect(entry).toBeDefined();

    // Fields from manifest should be preserved
    expect(entry?.fields.has('title')).toBe(true);
    expect(entry?.fields.has('count')).toBe(true);

    // Config should be merged (manifest config preserved, decorator can override)
    expect(entry?.config.cli).toBe(true);
    expect(entry?.config.api).toEqual({ include: ['list', 'get'] });
  });

  it('should handle already PascalCase manifest keys (no change needed)', () => {
    // Some manifests might use PascalCase keys
    const manifestDef = {
      className: 'TestDevice',
      fields: {},
      methods: {},
      decoratorConfig: {},
    };

    // Register with PascalCase (exact match case)
    ObjectRegistry.registerFromManifest(
      'TestDevice',
      manifestDef,
      '@test/package',
    );

    // Verify stub is registered
    const stubEntry = ObjectRegistry.findClass('TestDevice');
    expect(stubEntry).toBeDefined();
    expect((stubEntry?.constructor as any)?._isManifestStub).toBe(true);

    // Register real class
    @smrt()
    class TestDevice extends SmrtObject {}

    // Verify real class replaced the stub (exact match case)
    const realEntry = ObjectRegistry.findClass('TestDevice');
    expect(realEntry).toBeDefined();
    expect((realEntry?.constructor as any)?._isManifestStub).toBeUndefined();
    expect(realEntry?.constructor).toBe(TestDevice);
  });

  it('should throw on case-insensitive collision with non-stub class', () => {
    // First register a real class
    @smrt({ name: 'collisiontest' })
    class CollisionTest1 extends SmrtObject {}

    // Verify it's registered
    const entry = ObjectRegistry.findClass('collisiontest');
    expect(entry).toBeDefined();
    expect((entry?.constructor as any)?._isManifestStub).toBeUndefined();

    // Now try to register a different class with case-insensitive match
    expect(() => {
      @smrt({ name: 'CollisionTest' })
      class CollisionTest2 extends SmrtObject {}
    }).toThrow(/Class Name Collision.*case-insensitive/);
  });
});
