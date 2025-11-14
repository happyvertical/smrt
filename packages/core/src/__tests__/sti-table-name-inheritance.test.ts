/**
 * Tests for STI table name inheritance
 *
 * Verifies that child classes correctly use the parent's table name
 * when the parent uses STI (Single Table Inheritance) strategy.
 *
 * Regression test for issue #298: STI subclass incorrectly creates own table
 * instead of using parent table.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('STI Table Name Inheritance', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('should use parent table name when parent has explicit STI strategy', () => {
    @smrt({ tableStrategy: 'sti' })
    class Event extends SmrtObject {
      title: string = '';
    }

    @smrt()
    class Meeting extends Event {
      roomNumber: string = '';
    }

    // Both should use 'events' table
    expect(ObjectRegistry.getTableName('Event')).toBe('events');
    expect(ObjectRegistry.getTableName('Meeting')).toBe('events');
  });

  it('should use parent table name through multiple inheritance levels', () => {
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

    // All should use 'events' table
    expect(ObjectRegistry.getTableName('Event')).toBe('events');
    expect(ObjectRegistry.getTableName('SportingEvent')).toBe('events');
    expect(ObjectRegistry.getTableName('HockeyGame')).toBe('events');
  });

  it('should use own table name when using CTI (default)', () => {
    @smrt()
    class Product extends SmrtObject {
      name: string = '';
    }

    @smrt()
    class DigitalProduct extends Product {
      downloadUrl: string = '';
    }

    // Each should have own table
    expect(ObjectRegistry.getTableName('Product')).toBe('products');
    expect(ObjectRegistry.getTableName('DigitalProduct')).toBe(
      'digital_products',
    );
  });

  it('should handle ProfileRelationship STI inheritance (issue #298)', () => {
    @smrt({ tableStrategy: 'sti' })
    class ProfileRelationship extends SmrtObject {
      fromProfileId: string = '';
      toProfileId: string = '';
      typeId: string = '';
    }

    @smrt()
    class CouncilMember extends ProfileRelationship {
      ward: string = '';
      position: string = '';
      electionDate: Date = new Date();
    }

    // Both should use 'profile_relationships' table
    expect(ObjectRegistry.getTableName('ProfileRelationship')).toBe(
      'profile_relationships',
    );
    expect(ObjectRegistry.getTableName('CouncilMember')).toBe(
      'profile_relationships',
    );
  });

  it('should detect STI strategy from parent even without explicit config on child', () => {
    @smrt({ tableStrategy: 'sti' })
    class Vehicle extends SmrtObject {
      baseField: string = '';
    }

    // Child with NO explicit strategy should inherit STI
    @smrt()
    class Car extends Vehicle {
      childField: string = '';
    }

    // Verify strategy is inherited
    expect(ObjectRegistry.getTableStrategy('Vehicle')).toBe('sti');
    expect(ObjectRegistry.getTableStrategy('Car')).toBe('sti');

    // Verify both use same table
    expect(ObjectRegistry.getTableName('Vehicle')).toBe('vehicles');
    expect(ObjectRegistry.getTableName('Car')).toBe('vehicles');
  });

  it('should use grandparent table name when parent has no explicit strategy', () => {
    @smrt({ tableStrategy: 'sti' })
    class Grandparent extends SmrtObject {
      gField: string = '';
    }

    // Parent with no explicit strategy (inherits STI from Grandparent)
    @smrt()
    class Parent extends Grandparent {
      pField: string = '';
    }

    // Child with no explicit strategy (inherits STI through Parent)
    @smrt()
    class Child extends Parent {
      cField: string = '';
    }

    // All should use grandparent's table
    expect(ObjectRegistry.getTableName('Grandparent')).toBe('grandparents');
    expect(ObjectRegistry.getTableName('Parent')).toBe('grandparents');
    expect(ObjectRegistry.getTableName('Child')).toBe('grandparents');
  });

  it('should throw error when child explicitly sets CTI while parent uses STI', () => {
    @smrt({ tableStrategy: 'sti' })
    class Event extends SmrtObject {
      title: string = '';
    }

    // Attempting to override parent's STI with explicit CTI should fail
    expect(() => {
      @smrt({ tableStrategy: 'cti' })
      class SpecialEvent extends Event {
        special: string = '';
      }
    }).toThrow('Incompatible table strategy');
  });

  it('should use STI base class table name for deeply nested hierarchy', () => {
    @smrt({ tableStrategy: 'sti' })
    class Level1 extends SmrtObject {
      l1: string = '';
    }

    @smrt()
    class Level2 extends Level1 {
      l2: string = '';
    }

    @smrt()
    class Level3 extends Level2 {
      l3: string = '';
    }

    @smrt()
    class Level4 extends Level3 {
      l4: string = '';
    }

    const expectedTable = 'level1s';

    expect(ObjectRegistry.getTableName('Level1')).toBe(expectedTable);
    expect(ObjectRegistry.getTableName('Level2')).toBe(expectedTable);
    expect(ObjectRegistry.getTableName('Level3')).toBe(expectedTable);
    expect(ObjectRegistry.getTableName('Level4')).toBe(expectedTable);
  });
});
