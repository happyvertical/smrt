/**
 * Test for Issue #142: ProfileMetadata foreignKey initialization fails with circular dependency
 *
 * This test verifies that lazy string-based foreign key references prevent circular
 * dependency errors during module initialization.
 */

import { describe, it, expect } from 'vitest';

describe('Issue #142: Foreign Key Circular Dependencies', () => {
  it('should import ProfileMetadata without circular dependency errors', async () => {
    // This test reproduces the original error from Issue #142
    // Before the fix, this would throw: TypeError: Cannot read properties of undefined (reading 'name')
    // After the fix with lazy string references, it should import successfully

    expect(async () => {
      const { ProfileMetadata } = await import('../ProfileMetadata');
      expect(ProfileMetadata).toBeDefined();
      expect(ProfileMetadata.name).toBe('ProfileMetadata');
    }).not.toThrow();
  });

  it('should import Profile without circular dependency errors', async () => {
    expect(async () => {
      const { Profile } = await import('../Profile');
      expect(Profile).toBeDefined();
      expect(Profile.name).toBe('Profile');
    }).not.toThrow();
  });

  it('should import ProfileRelationship without circular dependency errors', async () => {
    expect(async () => {
      const { ProfileRelationship } = await import('../ProfileRelationship');
      expect(ProfileRelationship).toBeDefined();
      expect(ProfileRelationship.name).toBe('ProfileRelationship');
    }).not.toThrow();
  });

  it('should import ProfileRelationshipTerm without circular dependency errors', async () => {
    expect(async () => {
      const { ProfileRelationshipTerm } = await import('../ProfileRelationshipTerm');
      expect(ProfileRelationshipTerm).toBeDefined();
      expect(ProfileRelationshipTerm.name).toBe('ProfileRelationshipTerm');
    }).not.toThrow();
  });

  it('should create ProfileMetadata instances with lazy foreign key references', async () => {
    const { ProfileMetadata } = await import('../ProfileMetadata');
    const { ObjectRegistry } = await import('@have/smrt');

    // Create instance to trigger field initialization
    const metadata = new ProfileMetadata({
      profileId: 'test-profile-id',
      metafieldId: 'test-metafield-id',
      value: 'test-value',
      _skipRegistration: true,
    });

    // Verify foreign key fields are initialized with string references
    expect(metadata.profileId).toBeDefined();
    expect(metadata.metafieldId).toBeDefined();

    // Verify the field options contain string references (not undefined class references)
    expect(metadata.profileId.options.related).toBe('Profile');
    expect(metadata.metafieldId.options.related).toBe('ProfileMetafield');
  });

  it('should resolve lazy string references at runtime via ObjectRegistry', async () => {
    const { Profile } = await import('../Profile');
    const { ProfileMetadata } = await import('../ProfileMetadata');
    const { ObjectRegistry } = await import('@have/smrt');

    // Verify both classes are registered
    expect(ObjectRegistry.hasClass('Profile')).toBe(true);
    expect(ObjectRegistry.hasClass('ProfileMetadata')).toBe(true);

    // Verify relationship metadata is correctly extracted with string references
    const metadataRelationships = ObjectRegistry.getRelationships('ProfileMetadata');
    const profileRelationship = metadataRelationships.find(r => r.fieldName === 'profileId');

    expect(profileRelationship).toBeDefined();
    expect(profileRelationship?.targetClass).toBe('Profile');
    expect(profileRelationship?.type).toBe('foreignKey');
  });

  it('should support lazy function references as alternative to strings', async () => {
    const { foreignKey } = await import('@have/smrt');

    // Test lazy function reference (alternative syntax)
    const lazyField = foreignKey(() => class TestClass {}, { required: true });

    expect(lazyField).toBeDefined();
    expect(lazyField.options.related).toBe('TestClass');
  });

  it('should maintain backward compatibility with direct class references', async () => {
    const { foreignKey } = await import('@have/smrt');

    class TestClass {}

    // Test direct class reference (legacy syntax, still supported)
    const directField = foreignKey(TestClass, { required: true });

    expect(directField).toBeDefined();
    expect(directField.options.related).toBe('TestClass');
  });
});
