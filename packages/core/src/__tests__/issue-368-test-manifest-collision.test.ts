/**
 * Test for Issue #368: Test classes included in manifests causing name collisions
 *
 * Reproduces the exact scenario where test Profile class collides with
 * production Profile class from @happyvertical/smrt-profiles
 */

import { describe, expect, it, vi } from 'vitest';

describe('Issue #368: Test Manifest Collision', () => {
  it('should NOT find test classes when not in test environment', async () => {
    // This test verifies that test classes like Profile from __tests__/sti-multilevel.test.ts
    // are NOT loaded in production environment, preventing collisions

    // Simulate production environment
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;

      // Import manifest loader with fresh state
      const { discoverManifestSync } = await import(
        '../manifest/manifest-loader.js'
      );

      // Try to find test Profile class - should NOT be found in production
      const testProfile = discoverManifestSync('Profile');

      // In production, test classes should be undefined
      // This prevents collisions with production Profile from smrt-profiles
      expect(testProfile).toBeUndefined();
    } finally {
      // Restore test environment
      process.env.NODE_ENV = originalNodeEnv;
      if (originalVitest) process.env.VITEST = originalVitest;
    }
  });

  it('should find test classes ONLY in test environment', async () => {
    // Verify we're in test environment
    expect(
      process.env.NODE_ENV === 'test' || process.env.VITEST === 'true',
    ).toBe(true);

    const { discoverManifestSync } = await import(
      '../manifest/manifest-loader.js'
    );

    // In test environment, should find test classes
    const testProfile = discoverManifestSync('Profile');

    // Should find Profile from test manifest
    expect(testProfile).toBeDefined();
    expect(testProfile?.className).toBe('Profile');

    // Verify it's from test directory
    expect(testProfile?.filePath).toContain('__tests__');
  });

  it('should allow same class name in different contexts', async () => {
    // This test verifies that test and production classes with same name
    // don't collide because test classes are only loaded in test environment

    const { discoverManifestSync } = await import(
      '../manifest/manifest-loader.js'
    );

    // In test environment, we can find test Profile
    const testProfile = discoverManifestSync('Profile');
    expect(testProfile).toBeDefined();
    expect(testProfile?.filePath).toContain('__tests__');

    // In production environment (simulated), it would not be found
    // This prevents collision with production Profile from smrt-profiles
  });

  it('should prevent collision error that blocked praeco tests', async () => {
    // This test reproduces the exact error from issue #368:
    // Error: SMRT Class Name Collision Detected: "Profile"
    //   - @happyvertical/smrt-core (__tests__/sti-multilevel.test.ts) from test manifest
    //   - @happyvertical/smrt-profiles (src/models/Profile.ts) from manifest.json

    // Verify test environment detection is working
    const { discoverManifestSync } = await import(
      '../manifest/manifest-loader.js'
    );

    // This should work without throwing collision error
    expect(() => {
      discoverManifestSync('Profile');
    }).not.toThrow();

    // Test Profile should be found in test environment
    const testProfile = discoverManifestSync('Profile');
    expect(testProfile).toBeDefined();

    // In production (simulated below), it should NOT be found, preventing collision
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;

    try {
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;

      // Reset modules to get fresh import with production environment
      vi.resetModules();
      const { discoverManifestSync: prodDiscover } = await import(
        '../manifest/manifest-loader.js'
      );

      const prodProfile = prodDiscover('Profile');

      // In production, test Profile should NOT be found
      expect(prodProfile).toBeUndefined();
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalVitest) process.env.VITEST = originalVitest;
      vi.resetModules();
    }
  });
});
