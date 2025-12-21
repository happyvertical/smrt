/**
 * Issue #555: Test isolation - class name collision during vitest collection
 *
 * When running tests with vitest's module isolation, the same class can be
 * imported multiple times with different constructor references. This should
 * not cause a collision error if the class comes from the same source file.
 *
 * @see https://github.com/happyvertical/smrt/issues/555
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

describe('Issue #555: Test isolation - class name collision', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  describe('Source file tracking for collision detection', () => {
    it('should store sourceFilePath when registering a class', () => {
      @smrt()
      class TestIsolation555A extends SmrtObject {
        title: string = '';
      }

      const registered = ObjectRegistry.getClass('TestIsolation555A');
      expect(registered).toBeDefined();
      // Source file path should be captured from stack trace
      // Verify it's a non-empty string without asserting specific path content
      // (which could break if the test file is renamed)
      expect(typeof registered?.sourceFilePath).toBe('string');
      expect(registered?.sourceFilePath?.length).toBeGreaterThan(0);
    });

    it('should allow re-registration from same source file (simulating module re-evaluation)', () => {
      // First registration
      @smrt()
      class TestIsolation555B extends SmrtObject {
        content: string = '';
      }

      const firstRegistration = ObjectRegistry.getClass('TestIsolation555B');
      expect(firstRegistration).toBeDefined();
      const firstConstructor = firstRegistration?.constructor;

      // Simulate module re-evaluation by registering again
      // In a real scenario, this would be the same class with a different constructor reference
      // For this test, we manually call register with the same class
      ObjectRegistry.register(TestIsolation555B, {});

      // Should not throw an error because it's the same source file
      const secondRegistration = ObjectRegistry.getClass('TestIsolation555B');
      expect(secondRegistration).toBeDefined();

      // Constructor should be the same (or updated if it was a different reference)
      expect(secondRegistration?.constructor).toBe(TestIsolation555B);
    });

    it('should throw collision error for same name from different source files', () => {
      // Register first class
      @smrt()
      class CollisionTest555 extends SmrtObject {
        field1: string = '';
      }

      // Get the registered entry and modify the source file to simulate
      // a class from a different file
      const registered = ObjectRegistry.getClass('CollisionTest555');
      expect(registered).toBeDefined();

      // Simulate the first class being from a different source file
      registered!.sourceFilePath = '/different/path/to/file.ts';

      // Create a different constructor with the same name
      // This simulates a different class with the same name from another file
      const OtherClass = class CollisionTest555 extends SmrtObject {
        field2: string = '';
      };

      // Try to register the class with the same name from a "different" source file
      // This should throw because source files differ
      expect(() => {
        ObjectRegistry.register(OtherClass as any, {
          name: 'CollisionTest555',
        });
      }).toThrow(/SMRT Class Name Collision/);
    });

    it('should allow re-registration when source file tracking is unavailable (fallback)', () => {
      // Register a class
      @smrt()
      class FallbackTest555 extends SmrtObject {
        field: string = '';
      }

      // Get the registered entry and clear the source file to simulate
      // an environment where source file tracking fails
      const registered = ObjectRegistry.getClass('FallbackTest555');
      expect(registered).toBeDefined();
      registered!.sourceFilePath = undefined;

      // Create another class with the same name
      const OtherClass = class FallbackTest555 extends SmrtObject {
        otherField: string = '';
      };

      // Should NOT throw because when both source files are undefined,
      // we fallback to allowing re-registration
      expect(() => {
        ObjectRegistry.register(OtherClass as any, { name: 'FallbackTest555' });
      }).not.toThrow();

      // Verify the constructor was updated
      const updated = ObjectRegistry.getClass('FallbackTest555');
      expect(updated?.constructor).toBe(OtherClass);
    });
  });

  describe('Collection class registration', () => {
    it('should allow collection class re-registration after module re-evaluation', () => {
      @smrt()
      class Item555 extends SmrtObject {
        name: string = '';
      }

      @smrt()
      class Items555 extends SmrtCollection<Item555> {
        static readonly _itemClass = Item555;
      }

      // Re-register the collection (simulating module re-evaluation)
      expect(() => {
        ObjectRegistry.register(Items555 as any, {});
      }).not.toThrow();
    });
  });

  describe('Manifest stub replacement still works', () => {
    it('should still replace manifest stubs with real classes', () => {
      // Manually create a stub registration
      const stubConstructor = class StubClass extends SmrtObject {} as any;
      stubConstructor._isManifestStub = true;

      ObjectRegistry.register(stubConstructor, { name: 'ManifestStub555' });

      // Verify it's registered as a stub
      const stubRegistration = ObjectRegistry.getClass('ManifestStub555');
      expect(stubRegistration).toBeDefined();
      expect((stubRegistration?.constructor as any)._isManifestStub).toBe(true);

      // Now register the "real" class
      @smrt({ name: 'ManifestStub555' })
      class RealClass555 extends SmrtObject {
        realField: string = '';
      }

      // Stub should be replaced
      const realRegistration = ObjectRegistry.getClass('ManifestStub555');
      expect(realRegistration).toBeDefined();
      expect(
        (realRegistration?.constructor as any)._isManifestStub,
      ).toBeUndefined();
      expect(realRegistration?.constructor).toBe(RealClass555);
    });
  });
});
