/**
 * Tests for STI (Single Table Inheritance) registry methods
 *
 * Tests the three new registry methods that enable STI support:
 * - getTableStrategy(): Determine CTI vs STI with inheritance
 * - getSTIBase(): Find the base class for an STI hierarchy
 * - getDescendants(): Find all child classes
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('STI Registry Methods', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  describe('getTableStrategy()', () => {
    it('should return "cti" for unregistered classes', () => {
      expect(ObjectRegistry.getTableStrategy('NonExistent')).toBe('cti');
    });

    it('should return "cti" by default when no strategy is configured', () => {
      @smrt()
      class Product extends SmrtObject {
        name: string = '';
      }

      expect(ObjectRegistry.getTableStrategy('Product')).toBe('cti');
    });

    it('should return explicit "cti" strategy', () => {
      @smrt({ tableStrategy: 'cti' })
      class Product extends SmrtObject {
        name: string = '';
      }

      expect(ObjectRegistry.getTableStrategy('Product')).toBe('cti');
    });

    it('should return explicit "sti" strategy', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
    });

    it('should inherit "sti" strategy from parent', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('Meeting')).toBe('sti');
    });

    it('should inherit "sti" through multiple levels', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class SportingEvent extends Event {
        sport: string = '';
      }

      @smrt()
      class HockeyGame extends SportingEvent {
        homeTeam: string = '';
      }

      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('SportingEvent')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('HockeyGame')).toBe('sti');
    });

    it('should reject child with explicit CTI when parent uses STI', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      // Explicitly setting CTI strategy when parent uses STI should throw
      expect(() => {
        @smrt({ tableStrategy: 'cti' })
        class SpecialEvent extends Event {
          special: string = '';
        }
      }).toThrow('Incompatible table strategy');
    });
  });

  describe('getSTIBase()', () => {
    it('should return null for unregistered classes', () => {
      expect(ObjectRegistry.getSTIBase('NonExistent')).toBeNull();
    });

    it('should return null for CTI classes', () => {
      @smrt()
      class Product extends SmrtObject {
        name: string = '';
      }

      expect(ObjectRegistry.getSTIBase('Product')).toBeNull();
    });

    it('should return null for explicit CTI strategy', () => {
      @smrt({ tableStrategy: 'cti' })
      class Product extends SmrtObject {
        name: string = '';
      }

      expect(ObjectRegistry.getSTIBase('Product')).toBeNull();
    });

    it('should return the class itself when it defines STI', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      // R5-canon: getSTIBase returns qualified names.
      expect(ObjectRegistry.getSTIBase('Event')).toBe(
        '@happyvertical/smrt-core:Event',
      );
    });

    it('should return the parent class when child inherits STI', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      // R5-canon: getSTIBase returns qualified names.
      expect(ObjectRegistry.getSTIBase('Event')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe(
        '@happyvertical/smrt-core:Event',
      );
    });

    it('should return the top-most STI base through multiple levels', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class SportingEvent extends Event {
        sport: string = '';
      }

      @smrt()
      class HockeyGame extends SportingEvent {
        homeTeam: string = '';
      }

      // R5-canon: getSTIBase returns qualified names.
      expect(ObjectRegistry.getSTIBase('Event')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('SportingEvent')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('HockeyGame')).toBe(
        '@happyvertical/smrt-core:Event',
      );
    });

    it('should reject child with explicit CTI override', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      // Child attempting to override to CTI should throw during registration
      expect(() => {
        @smrt({ tableStrategy: 'cti' })
        class SpecialEvent extends Event {
          special: string = '';
        }
      }).toThrow('Incompatible table strategy');
    });
  });

  describe('getDescendants()', () => {
    it('should return empty array for unregistered classes', () => {
      expect(ObjectRegistry.getDescendants('NonExistent')).toEqual([]);
    });

    it('should return empty array for classes with no children', () => {
      @smrt()
      class Product extends SmrtObject {
        name: string = '';
      }

      expect(ObjectRegistry.getDescendants('Product')).toEqual([]);
    });

    it('should return direct children', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      @smrt()
      class HockeyGame extends Event {
        homeTeam: string = '';
      }

      const descendants = ObjectRegistry.getDescendants('Event');
      // R5-canon: getDescendants returns qualified names.
      expect(descendants).toHaveLength(2);
      expect(descendants).toContain('@happyvertical/smrt-core:Meeting');
      expect(descendants).toContain('@happyvertical/smrt-core:HockeyGame');
    });

    it('should return all descendants (direct and indirect)', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class SportingEvent extends Event {
        sport: string = '';
      }

      @smrt()
      class HockeyGame extends SportingEvent {
        homeTeam: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      const eventDescendants = ObjectRegistry.getDescendants('Event');
      // R5-canon: getDescendants returns qualified names.
      expect(eventDescendants).toHaveLength(3);
      expect(eventDescendants).toContain(
        '@happyvertical/smrt-core:SportingEvent',
      );
      expect(eventDescendants).toContain(
        '@happyvertical/smrt-core:HockeyGame',
      );
      expect(eventDescendants).toContain('@happyvertical/smrt-core:Meeting');

      const sportingDescendants =
        ObjectRegistry.getDescendants('SportingEvent');
      expect(sportingDescendants).toHaveLength(1);
      expect(sportingDescendants).toContain(
        '@happyvertical/smrt-core:HockeyGame',
      );
    });

    it('should not include the base class itself', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      const descendants = ObjectRegistry.getDescendants('Event');
      expect(descendants).not.toContain('Event');
    });

    it('should work with CTI classes too (not STI-specific)', () => {
      @smrt()
      class BaseClass extends SmrtObject {
        name: string = '';
      }

      @smrt()
      class ChildClass extends BaseClass {
        extra: string = '';
      }

      const descendants = ObjectRegistry.getDescendants('BaseClass');
      // R5-canon: getDescendants returns qualified names.
      expect(descendants).toHaveLength(1);
      expect(descendants).toContain('@happyvertical/smrt-core:ChildClass');
    });
  });

  describe('Integration: STI hierarchy discovery', () => {
    it('should correctly identify complete STI hierarchy', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      @smrt()
      class HockeyGame extends Event {
        homeTeam: string = '';
      }

      // Verify strategy
      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('Meeting')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('HockeyGame')).toBe('sti');

      // Verify base
      // R5-canon: getSTIBase/getDescendants return qualified names.
      expect(ObjectRegistry.getSTIBase('Event')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('HockeyGame')).toBe(
        '@happyvertical/smrt-core:Event',
      );

      // Verify descendants
      const descendants = ObjectRegistry.getDescendants('Event');
      expect(descendants).toHaveLength(2);
      expect(descendants).toContain('@happyvertical/smrt-core:Meeting');
      expect(descendants).toContain('@happyvertical/smrt-core:HockeyGame');
    });

    it('should handle mixed CTI and STI hierarchies', () => {
      // CTI hierarchy
      @smrt()
      class Product extends SmrtObject {
        name: string = '';
      }

      @smrt()
      class Book extends Product {
        isbn: string = '';
      }

      // STI hierarchy
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      // Verify Product hierarchy uses CTI
      expect(ObjectRegistry.getTableStrategy('Product')).toBe('cti');
      expect(ObjectRegistry.getTableStrategy('Book')).toBe('cti');
      expect(ObjectRegistry.getSTIBase('Product')).toBeNull();
      expect(ObjectRegistry.getSTIBase('Book')).toBeNull();

      // Verify Event hierarchy uses STI.
      // R5-canon: getSTIBase/getDescendants return qualified names.
      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('Meeting')).toBe('sti');
      expect(ObjectRegistry.getSTIBase('Event')).toBe(
        '@happyvertical/smrt-core:Event',
      );
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe(
        '@happyvertical/smrt-core:Event',
      );

      // Verify descendants are isolated
      expect(ObjectRegistry.getDescendants('Product')).toEqual([
        '@happyvertical/smrt-core:Book',
      ]);
      expect(ObjectRegistry.getDescendants('Event')).toEqual([
        '@happyvertical/smrt-core:Meeting',
      ]);
    });
  });

  describe('resolveType()', () => {
    it('should resolve unambiguous short name to qualified name', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      @smrt()
      class Meeting extends Event {
        roomNumber: string = '';
      }

      const qualified = ObjectRegistry.resolveType('Meeting');
      expect(qualified).toMatch(/^@[^:]+:Meeting$/);
    });

    it('should pass through already qualified names', () => {
      @smrt({ tableStrategy: 'sti' })
      class Event extends SmrtObject {
        title: string = '';
      }

      // Get the actual qualified name
      const registered = ObjectRegistry.findClass('Event');
      const qualifiedName = registered?.qualifiedName;

      // Should pass through unchanged
      const result = ObjectRegistry.resolveType(qualifiedName!);
      expect(result).toBe(qualifiedName);
    });

    it('should throw for unregistered class names', () => {
      expect(() => ObjectRegistry.resolveType('NonExistentClass')).toThrow(
        'is not registered',
      );
    });

    it('should throw for ambiguous names when multiple packages define same class', () => {
      // Register two classes with the same short name but different packages
      // We simulate this by registering directly with different qualified names

      @smrt()
      class Product extends SmrtObject {
        name: string = '';
      }

      // Get the first product's qualified name
      const product1 = ObjectRegistry.findClass('Product');

      // Manually register another "Product" from a different package
      // This simulates what happens when two packages define the same class name
      ObjectRegistry.classes.set('Product2', {
        name: 'Product',
        qualifiedName: '@other/package:Product',
        constructor: class OtherProduct extends SmrtObject {},
        collectionConstructor: undefined,
        config: {},
        fields: new Map(),
        methods: new Map(),
        schema: undefined,
        validators: [],
        packageName: '@other/package',
        extends: 'SmrtObject',
      } as any);

      // Now resolveType should throw because "Product" is ambiguous
      expect(() => ObjectRegistry.resolveType('Product')).toThrow('ambiguous');
      expect(() => ObjectRegistry.resolveType('Product')).toThrow(
        'multiple packages',
      );
    });

    it('should be case-insensitive for lookup', () => {
      @smrt()
      class MyClass extends SmrtObject {
        value: string = '';
      }

      // Should find the class regardless of case
      const qualified = ObjectRegistry.resolveType('myclass');
      expect(qualified).toMatch(/MyClass$/);
    });
  });
});
