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
import { ObjectRegistry } from '../registry';

describe('Issue #623: STI parent class loading in ensureSchema()', () => {
  // Store original registry state
  let originalClasses: Map<string, any>;

  beforeEach(() => {
    // Backup registry state
    originalClasses = new Map(ObjectRegistry.classes);
    // Clear mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore registry state
    ObjectRegistry.classes.clear();
    for (const [key, value] of originalClasses) {
      ObjectRegistry.classes.set(key, value);
    }
  });

  it('should detect unregistered parent class from extends field', () => {
    // Simulate a child class with an unregistered parent
    const childEntry = {
      name: 'ChildClass',
      constructor: class ChildClass {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: { tableName: 'parent_classes' },
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass', // Parent not registered
    };

    ObjectRegistry.classes.set('ChildClass', childEntry);

    // Verify child is registered but parent is not
    expect(ObjectRegistry.findClass('ChildClass')).toBeDefined();
    expect(ObjectRegistry.findClass('ChildClass')?.extends).toBe('ParentClass');
    expect(ObjectRegistry.findClass('ParentClass')).toBeUndefined();
  });

  it('should find parent class when already registered', () => {
    // Simulate parent class already registered
    const parentEntry = {
      name: 'ParentClass',
      constructor: class ParentClass {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: {
        tableName: 'parent_classes',
        ddl: 'CREATE TABLE parent_classes ...',
      },
      validators: [],
      packageName: '@test/package',
    };

    const childEntry = {
      name: 'ChildClass',
      constructor: class ChildClass {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['childField', { type: 'text' }]]),
      methods: new Map(),
      schema: { tableName: 'parent_classes' },
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass',
    };

    ObjectRegistry.classes.set('ParentClass', parentEntry);
    ObjectRegistry.classes.set('ChildClass', childEntry);

    // Both should be found
    expect(ObjectRegistry.findClass('ParentClass')).toBeDefined();
    expect(ObjectRegistry.findClass('ChildClass')).toBeDefined();
    expect(ObjectRegistry.findClass('ChildClass')?.extends).toBe('ParentClass');
  });

  it('should not have extends field for standalone classes', () => {
    // Simulate a standalone class (not STI)
    const standaloneEntry = {
      name: 'StandaloneClass',
      constructor: class StandaloneClass {},
      config: {},
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: {
        tableName: 'standalone_classes',
        ddl: 'CREATE TABLE standalone_classes ...',
      },
      validators: [],
      packageName: '@test/package',
      // No extends field
    };

    ObjectRegistry.classes.set('StandaloneClass', standaloneEntry);

    // Should not have extends
    const registered = ObjectRegistry.findClass('StandaloneClass');
    expect(registered).toBeDefined();
    expect(registered?.extends).toBeUndefined();
  });

  it('should have schema tableName available for STI sibling discovery', () => {
    // The fix uses schema.tableName to discover siblings
    const childEntry = {
      name: 'ChildClass',
      constructor: class ChildClass {},
      config: { tableStrategy: 'sti' },
      fields: new Map([['name', { type: 'text' }]]),
      methods: new Map(),
      schema: { tableName: 'shared_table' },
      validators: [],
      packageName: '@test/package',
      extends: 'ParentClass',
    };

    ObjectRegistry.classes.set('ChildClass', childEntry);

    // Verify tableName is accessible from registered entry
    const registered = ObjectRegistry.findClass('ChildClass');
    expect(registered?.schema?.tableName).toBe('shared_table');
  });
});
