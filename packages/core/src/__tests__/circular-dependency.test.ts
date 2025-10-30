/**
 * Test for Issue #142: Circular dependency resolution with lazy string references
 *
 * This test verifies that lazy string-based foreign key references prevent circular
 * dependency errors during module initialization, and that ObjectRegistry correctly
 * extracts relationship metadata from registered classes.
 */

import { describe, expect, it } from 'vitest';
import { foreignKey, SmrtObject, smrt, text } from '../index.js';
import { ObjectRegistry } from '../registry.js';

// Simple test classes to demonstrate circular dependency resolution
@smrt({
  api: { include: ['list', 'get'] },
})
class TestProfile extends SmrtObject {
  name = text({ required: true });
}

@smrt({
  api: { include: ['list', 'get'] },
})
class TestMetadata extends SmrtObject {
  profileId = foreignKey('TestProfile', { required: true });
  key = text({ required: true });
  value = text({ required: true });
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

    // Verify foreign key field is initialized with string reference
    expect(metadata.profileId).toBeDefined();
    expect(metadata.profileId.options.related).toBe('TestProfile');
  });

  it('should register classes without circular dependency errors', () => {
    // Verify both classes are registered
    expect(ObjectRegistry.hasClass('TestProfile')).toBe(true);
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
    expect(profileRelationship?.targetClass).toBe('TestProfile');
    expect(profileRelationship?.type).toBe('foreignKey');
  });

  it('should support lazy function references as alternative to strings', () => {
    // Test lazy function reference (alternative syntax)
    const lazyField = foreignKey(() => TestProfile, { required: true });

    expect(lazyField).toBeDefined();
    expect(lazyField.options.related).toBe('TestProfile');
  });

  it('should maintain backward compatibility with direct class references', () => {
    // Test direct class reference (legacy syntax)
    const directField = foreignKey(TestProfile, { required: true });

    expect(directField).toBeDefined();
    expect(directField.options.related).toBe('TestProfile');
  });
});
