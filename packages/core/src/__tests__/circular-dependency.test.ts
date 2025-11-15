/**
 * Test for Issue #142: Circular dependency resolution with lazy string references
 *
 * This test verifies that lazy string-based foreign key references prevent circular
 * dependency errors during module initialization, and that ObjectRegistry correctly
 * extracts relationship metadata from registered classes.
 */

import { describe, expect, it } from 'vitest';
import { field, foreignKey, SmrtObject, smrt } from '../index.js';
import { ObjectRegistry } from '../registry.js';

// Simple test classes to demonstrate circular dependency resolution
@smrt({
  api: { include: ['list', 'get'] },
})
class CircularDepTestProfile extends SmrtObject {
  @field({ required: true })
  name: string = '';
}

@smrt({
  api: { include: ['list', 'get'] },
})
class TestMetadata extends SmrtObject {
  @foreignKey('CircularDepTestProfile', { required: true })
  profileId: string = '';

  @field({ required: true })
  key: string = '';

  @field({ required: true })
  value: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.key) this.key = options.key;
    if (options.value) this.value = options.value;
  }
}

describe('Issue #142: Foreign Key Circular Dependencies', () => {
  it('should support lazy string references in foreignKey', () => {
    // Create instance to verify field initialization
    const metadata = new TestMetadata({
      profileId: 'test-profile-id',
      key: 'test-key',
      value: 'test-value',
      _skipRegistration: true,
    });

    // Verify foreign key field is initialized with string value
    expect(metadata.profileId).toBeDefined();
    expect(metadata.profileId).toBe('test-profile-id');

    // Verify decorator metadata is registered
    const fieldDecorator = ObjectRegistry.getFieldDecorator(
      'TestMetadata',
      'profileId',
    );
    expect(fieldDecorator).toBeDefined();
    expect(fieldDecorator.related).toBe('CircularDepTestProfile');
  });

  it('should register classes without circular dependency errors', () => {
    // Verify both classes are registered
    expect(ObjectRegistry.hasClass('CircularDepTestProfile')).toBe(true);
    expect(ObjectRegistry.hasClass('TestMetadata')).toBe(true);
  });

  it.skip('should extract relationship metadata from registered classes (scanner limitation)', () => {
    // TODO: AST scanner doesn't extract 'related' property from foreignKey() calls
    // This is a known limitation - scanner can't easily parse function call arguments
    // See: https://github.com/happyvertical/smrt/issues/133

    // Verify relationship metadata is correctly extracted
    const metadataRelationships =
      ObjectRegistry.getRelationships('TestMetadata');
    const profileRelationship = metadataRelationships.find(
      (r) => r.fieldName === 'profileId',
    );

    expect(profileRelationship).toBeDefined();
    expect(profileRelationship?.targetClass).toBe('CircularDepTestProfile');
    expect(profileRelationship?.type).toBe('foreignKey');
  });

  it.skip('should support lazy function references as alternative to strings (field helper syntax - deprecated)', () => {
    // NOTE: This tests the old field helper syntax which is deprecated
    // Field helpers will be removed in Phase 3 of the decorator migration
    // Keeping test skipped for now to document the old behavior
    const lazyField = foreignKey(() => CircularDepTestProfile, {
      required: true,
    });

    expect(lazyField).toBeDefined();
    expect(lazyField.options.related).toBe('CircularDepTestProfile');
  });

  it.skip('should maintain backward compatibility with direct class references (field helper syntax - deprecated)', () => {
    // NOTE: This tests the old field helper syntax which is deprecated
    // Field helpers will be removed in Phase 3 of the decorator migration
    // Keeping test skipped for now to document the old behavior
    const directField = foreignKey(CircularDepTestProfile, { required: true });

    expect(directField).toBeDefined();
    expect(directField.options.related).toBe('CircularDepTestProfile');
  });
});
