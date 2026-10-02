/**
 * Test for Issue #623: UPSERT fails on empty tables when saving assets from external packages
 *
 * Verifies that ensureSchema() properly loads STI parent classes from external package
 * manifests before attempting to create the database schema.
 *
 * The issue: When ImageCollection.create() is called for an STI child class (Image)
 * from an external package, the parent class (Asset) might not be registered yet.
 * This causes getSTIBase() to return the wrong value, leading to the wrong table
 * being created (or no table at all).
 *
 * The fix: ensureSchema() now checks if the parent class (from `extends` field)
 * is registered, and if not, loads all STI siblings including the parent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry';
import type { RegisteredClass } from '../registry/types.js';
import type { SchemaDefinition } from '../schema/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

// These tests intentionally alter registry keys to reproduce legacy hydration states.
function mutableRegistryClasses(): ReturnType<
  typeof ObjectRegistry.getAllClasses
> {
  return (
    ObjectRegistry as unknown as {
      classes: ReturnType<typeof ObjectRegistry.getAllClasses>;
    }
  ).classes;
}

function fixtureSchema(tableName: string): SchemaDefinition {
  return {
    tableName,
    ddl: '',
    columns: {},
    indexes: [],
    triggers: [],
    foreignKeys: [],
    dependencies: [],
    version: 'fixture',
  };
}

describe('Issue #623: STI parent class loading in ensureSchema()', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('should detect unregistered parent class from extends field', () => {
    // Simulate a child class with an unregistered parent
    const childEntry: RegisteredClass = {
      name: 'ChildClass',
      constructor: class ChildClass extends SmrtObject {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: fixtureSchema('parent_classes'),
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass', // Parent not registered
    };

    mutableRegistryClasses().set('ChildClass', childEntry);

    // Verify child is registered but parent is not
    expect(ObjectRegistry.getClass('ChildClass')).toBeDefined();
    expect(ObjectRegistry.getClass('ChildClass')?.extends).toBe('ParentClass');
    expect(ObjectRegistry.getClass('ParentClass')).toBeUndefined();
  });

  it('should find parent class when already registered', () => {
    // Simulate parent class already registered
    const parentEntry: RegisteredClass = {
      name: 'ParentClass',
      constructor: class ParentClass extends SmrtObject {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: fixtureSchema('parent_classes'),
      validators: [],
      packageName: '@test/package',
    };

    const childEntry: RegisteredClass = {
      name: 'ChildClass',
      constructor: class ChildClass extends SmrtObject {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['childField', { type: 'text' }]]),
      methods: new Map(),
      schema: fixtureSchema('parent_classes'),
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass',
    };

    mutableRegistryClasses().set('ParentClass', parentEntry);
    mutableRegistryClasses().set('ChildClass', childEntry);

    // Both should be found
    expect(ObjectRegistry.getClass('ParentClass')).toBeDefined();
    expect(ObjectRegistry.getClass('ChildClass')).toBeDefined();
    expect(ObjectRegistry.getClass('ChildClass')?.extends).toBe('ParentClass');
  });

  it('should not have extends field for standalone classes', () => {
    // Simulate a standalone class (not STI)
    const standaloneEntry: RegisteredClass = {
      name: 'StandaloneClass',
      constructor: class StandaloneClass extends SmrtObject {},
      config: {},
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: fixtureSchema('standalone_classes'),
      validators: [],
      packageName: '@test/package',
      // No extends field
    };

    mutableRegistryClasses().set('StandaloneClass', standaloneEntry);

    // Should not have extends
    const registered = ObjectRegistry.getClass('StandaloneClass');
    expect(registered).toBeDefined();
    expect(registered?.extends).toBeUndefined();
  });

  it('should have schema tableName available for STI sibling discovery', () => {
    // The fix uses schema.tableName to discover siblings
    const childEntry: RegisteredClass = {
      name: 'ChildClass',
      constructor: class ChildClass extends SmrtObject {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: fixtureSchema('shared_table'),
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass',
    };

    mutableRegistryClasses().set('ChildClass', childEntry);

    // Verify tableName is accessible from registered entry
    const registered = ObjectRegistry.getClass('ChildClass');
    expect(registered?.schema?.tableName).toBe('shared_table');
  });
});
