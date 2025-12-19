/**
 * Manifest Loading Integration Tests
 *
 * Tests the manifest loading system including:
 * - Test environment detection
 * - Lazy loading of test manifests
 * - Prevention of test/production class collisions
 * - External package manifest loading
 */

import { describe, expect, it, vi } from 'vitest';

describe('Manifest Loading', () => {
  describe('Test Environment Detection', () => {
    it('should detect test environment with NODE_ENV=test', () => {
      expect(process.env.NODE_ENV).toBe('test');
    });

    it('should detect test environment with VITEST variable', () => {
      expect(process.env.VITEST).toBe('true');
    });
  });

  describe('Test Manifest Lazy Loading', () => {
    it('should load test manifests in test environment', async () => {
      const { discoverManifestSync } = await import('../manifest-loader.js');

      // TestObject is defined in test-manifest-stub.ts
      // Should be findable in test environment
      const testObj = discoverManifestSync('TestObject');

      expect(testObj).toBeDefined();
      expect(testObj?.className).toBe('TestObject');
    });

    it('should NOT load test manifests in production environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;
      const originalJest = process.env.JEST_WORKER_ID;

      try {
        // Simulate production environment
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;
        delete process.env.JEST_WORKER_ID;

        vi.resetModules();

        const { discoverManifestSync } = await import('../manifest-loader.js');

        // TestObject is ONLY in test manifest
        // Should NOT be findable in production
        const testObj = discoverManifestSync('TestObject');

        expect(testObj).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalVitest) process.env.VITEST = originalVitest;
        if (originalJest) process.env.JEST_WORKER_ID = originalJest;
        vi.resetModules();
      }
    });
  });

  describe('Test/Production Class Collision Prevention', () => {
    it('should find test classes in test environment', async () => {
      const { discoverManifestSync } = await import('../manifest-loader.js');

      // STITestProfile from __tests__/sti-multilevel.test.ts (renamed from Profile to avoid collision with @happyvertical/smrt-profiles)
      const testProfile = discoverManifestSync('STITestProfile');

      expect(testProfile).toBeDefined();
      expect(testProfile?.className).toBe('STITestProfile');
      expect(testProfile?.filePath).toContain('__tests__');
    });

    it('should NOT find test classes in production environment', async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;

        vi.resetModules();
        const { discoverManifestSync } = await import('../manifest-loader.js');

        // STITestProfile should NOT be found in production
        const testProfile = discoverManifestSync('STITestProfile');

        expect(testProfile).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalVitest) process.env.VITEST = originalVitest;
        vi.resetModules();
      }
    });

    it('should prevent collision errors between test and production classes', async () => {
      const { discoverManifestSync } = await import('../manifest-loader.js');

      // Should not throw collision error
      expect(() => {
        discoverManifestSync('STITestProfile');
      }).not.toThrow();

      // In test environment, finds test STITestProfile
      const testProfile = discoverManifestSync('STITestProfile');
      expect(testProfile).toBeDefined();
      expect(testProfile?.filePath).toContain('__tests__');
    });

    it('should isolate test and production classes across environments', async () => {
      const { discoverManifestSync: testDiscover } = await import(
        '../manifest-loader.js'
      );

      // In test environment: test STITestProfile found
      const testProfile = testDiscover('STITestProfile');
      expect(testProfile).toBeDefined();
      expect(testProfile?.filePath).toContain('__tests__');

      // Simulate production environment
      const originalNodeEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;

      try {
        process.env.NODE_ENV = 'production';
        delete process.env.VITEST;

        vi.resetModules();
        const { discoverManifestSync: prodDiscover } = await import(
          '../manifest-loader.js'
        );

        // In production environment: test STITestProfile NOT found
        const prodProfile = prodDiscover('STITestProfile');
        expect(prodProfile).toBeUndefined();
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalVitest) process.env.VITEST = originalVitest;
        vi.resetModules();
      }
    });
  });
});
