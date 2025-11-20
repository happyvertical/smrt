/**
 * Tests for test environment detection in manifest loader
 * Ensures test manifests are ONLY loaded during tests, not in production
 *
 * This prevents test classes from colliding with production classes (issue #368)
 */

import { describe, expect, it, vi } from 'vitest';

describe('Test Environment Detection', () => {
  it('should detect test environment with NODE_ENV=test', () => {
    // This test itself proves NODE_ENV is set correctly by vitest
    expect(process.env.NODE_ENV).toBe('test');
  });

  it('should detect test environment with VITEST variable', () => {
    // Vitest sets this automatically
    expect(process.env.VITEST).toBe('true');
  });

  it('should load test manifests in test environment', async () => {
    const { discoverManifestSync } = await import('../manifest-loader.js');

    // TestObject is defined in test-manifest-stub.ts
    // Should be findable in test environment
    const testObj = discoverManifestSync('TestObject');

    expect(testObj).toBeDefined();
    expect(testObj?.className).toBe('TestObject');
  });

  it('should NOT load test manifests in production environment', async () => {
    // Temporarily override environment variables
    const originalNodeEnv = process.env.NODE_ENV;
    const originalVitest = process.env.VITEST;
    const originalJest = process.env.JEST_WORKER_ID;

    try {
      // Simulate production environment
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      delete process.env.JEST_WORKER_ID;

      // Clear module cache to force re-evaluation
      vi.resetModules();

      // Re-import to get fresh module state
      const { discoverManifestSync } = await import('../manifest-loader.js');

      // TestObject is ONLY in test manifest, not in static manifest
      // Should NOT be findable in production environment
      const testObj = discoverManifestSync('TestObject');

      // In production, test classes should NOT be found
      expect(testObj).toBeUndefined();
    } finally {
      // Restore original environment
      process.env.NODE_ENV = originalNodeEnv;
      if (originalVitest) process.env.VITEST = originalVitest;
      if (originalJest) process.env.JEST_WORKER_ID = originalJest;

      // Clear module cache again to restore normal test state
      vi.resetModules();
    }
  });

  it('should prevent test class collisions with production classes', async () => {
    // This test verifies the fix for issue #368
    // Test classes like Profile in __tests__/sti-multilevel.test.ts
    // should NOT collide with production Profile from @happyvertical/smrt-profiles

    const { discoverManifestSync } = await import('../manifest-loader.js');

    // In test environment, we should find the test Profile
    const testProfile = discoverManifestSync('Profile');

    expect(testProfile).toBeDefined();
    // Test Profile is from __tests__/sti-multilevel.test.ts
    expect(testProfile?.filePath).toContain('__tests__');
  });
});
