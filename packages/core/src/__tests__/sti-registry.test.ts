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

      expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');
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

      expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe('Event');
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

      expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('SportingEvent')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('HockeyGame')).toBe('Event');
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
      expect(descendants).toHaveLength(2);
      expect(descendants).toContain('Meeting');
      expect(descendants).toContain('HockeyGame');
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
      expect(eventDescendants).toHaveLength(3);
      expect(eventDescendants).toContain('SportingEvent');
      expect(eventDescendants).toContain('HockeyGame');
      expect(eventDescendants).toContain('Meeting');

      const sportingDescendants =
        ObjectRegistry.getDescendants('SportingEvent');
      expect(sportingDescendants).toHaveLength(1);
      expect(sportingDescendants).toContain('HockeyGame');
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
      expect(descendants).toHaveLength(1);
      expect(descendants).toContain('ChildClass');
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
      expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('HockeyGame')).toBe('Event');

      // Verify descendants
      const descendants = ObjectRegistry.getDescendants('Event');
      expect(descendants).toHaveLength(2);
      expect(descendants).toContain('Meeting');
      expect(descendants).toContain('HockeyGame');
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

      // Verify Event hierarchy uses STI
      expect(ObjectRegistry.getTableStrategy('Event')).toBe('sti');
      expect(ObjectRegistry.getTableStrategy('Meeting')).toBe('sti');
      expect(ObjectRegistry.getSTIBase('Event')).toBe('Event');
      expect(ObjectRegistry.getSTIBase('Meeting')).toBe('Event');

      // Verify descendants are isolated
      expect(ObjectRegistry.getDescendants('Product')).toEqual(['Book']);
      expect(ObjectRegistry.getDescendants('Event')).toEqual(['Meeting']);
    });
  });
});
