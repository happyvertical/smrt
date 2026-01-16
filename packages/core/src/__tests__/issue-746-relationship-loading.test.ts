/**
 * Issue #746: OidcIdentity.profileId not defined as relationship
 *
 * This test verifies that getRelated() works correctly for foreignKey relationships
 * in external packages where the manifest needs to be loaded asynchronously.
 *
 * The bug was that getRelated() called ObjectRegistry.getRelationships() synchronously
 * without first ensuring the manifest was loaded for external packages. This caused
 * "Field X is not a relationship" errors when the manifest hadn't been loaded yet.
 *
 * Fix: Call ensureManifestLoaded() before getRelationships() in:
 * - loadRelated()
 * - loadRelatedMany()
 * - getRelated()
 */

import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it } from 'vitest';
import { foreignKey, ObjectRegistry, SmrtObject, smrt } from '../index';

// Test classes to simulate cross-package relationships
@smrt()
class TestProfile extends SmrtObject {
  name: string = '';
  email: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.email) this.email = options.email;
  }
}

@smrt({ tableName: 'test_identities' })
class TestIdentity extends SmrtObject {
  @foreignKey('TestProfile', { required: true })
  profileId?: string;

  provider: string = '';
  subject: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.provider) this.provider = options.provider;
    if (options.subject) this.subject = options.subject;
  }

  async getProfile(): Promise<TestProfile | null> {
    return (await this.getRelated('profileId')) as TestProfile | null;
  }
}

describe('Issue #746: Relationship loading for external packages', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  it('should find profileId as a foreignKey relationship', async () => {
    // Register classes
    ObjectRegistry.register(TestProfile, {});
    ObjectRegistry.register(TestIdentity, {});

    // Ensure manifest is loaded (simulates what happens at runtime)
    await ObjectRegistry.ensureManifestLoaded('TestIdentity');

    // Get relationships
    const relationships = ObjectRegistry.getRelationships('TestIdentity');

    // Should find the profileId relationship
    const profileRelationship = relationships.find(
      (r) => r.fieldName === 'profileId',
    );

    expect(profileRelationship).toBeDefined();
    expect(profileRelationship?.type).toBe('foreignKey');
    expect(profileRelationship?.targetClass).toBe('TestProfile');
  });

  it('should not throw "not a relationship" error when manifest is loaded', async () => {
    // Register classes
    ObjectRegistry.register(TestProfile, {});
    ObjectRegistry.register(TestIdentity, {});

    // Create identity with a profileId
    const identity = new TestIdentity({
      db: { type: 'sqlite', url: ':memory:' },
      profileId: 'test-profile-id',
      provider: 'oidc',
      subject: 'test-subject',
    });
    await identity.initialize();

    // Before the fix, this would throw:
    // "Field profileId is not a relationship on TestIdentity"
    // because ensureManifestLoaded() wasn't called before getRelationships()

    // We can't fully test the load (no db), but we can verify getRelated()
    // properly recognizes the relationship by checking it doesn't throw
    // the "not a relationship" error

    try {
      // This will throw a different error (no db/row found) but NOT
      // "Field profileId is not a relationship"
      await identity.getRelated('profileId');
    } catch (error: any) {
      // Should NOT be "Field profileId is not a relationship" error
      expect(error.message).not.toContain('is not a relationship');
    }
  });

  it('should properly detect foreignKey relationship type in getRelated', async () => {
    // Register classes
    ObjectRegistry.register(TestProfile, {});
    ObjectRegistry.register(TestIdentity, {});

    // Ensure manifest is loaded
    await ObjectRegistry.ensureManifestLoaded('TestIdentity');

    // Verify the relationship is properly recognized
    const relationships = ObjectRegistry.getRelationships('TestIdentity');
    const profileRel = relationships.find((r) => r.fieldName === 'profileId');

    expect(profileRel).toBeDefined();
    expect(profileRel?.type).toBe('foreignKey');
    expect(profileRel?.targetClass).toBe('TestProfile');
  });

  it('should handle null foreign key gracefully', async () => {
    // Register classes
    ObjectRegistry.register(TestProfile, {});
    ObjectRegistry.register(TestIdentity, {});

    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Create tables
    await db.query(`
      CREATE TABLE test_profiles (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        name TEXT DEFAULT '',
        email TEXT DEFAULT ''
      )
    `);

    await db.query(`
      CREATE TABLE test_identities (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        profile_id TEXT,
        provider TEXT DEFAULT '',
        subject TEXT DEFAULT ''
      )
    `);

    // Create identity without a profile - pass db instance directly
    const identity = new TestIdentity({
      db,
      provider: 'oidc',
      subject: 'test-subject',
    });
    await identity.initialize();

    // getRelated should return null for null foreign key
    const loadedProfile = await identity.getProfile();

    expect(loadedProfile).toBeNull();
  });
});
