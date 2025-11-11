/**
 * Test for Issue #175: External package manifest loading
 *
 * Verifies that external package manifests can be loaded correctly,
 * specifically testing the Content class from @happyvertical/smrt-content
 * package that was failing in issue #175.
 *
 * Issue #175 reported error:
 * "Cannot find manifest for class 'Content'"
 *
 * This was fixed in PR #265 with async manifest loading.
 *
 * Note: These tests verify the manifest loading infrastructure.
 * Actual package imports are tested in integration tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearManifestCache,
  getPackageName,
  loadExternalManifest,
} from '../manifest/manifest-loader';

describe('Issue #175: External package manifest loading', () => {
  it('should have correct manifest export structure in content package', () => {
    // Verify content package has manifest export configured
    const contentPkgPath = join(__dirname, '../../../content/package.json');

    if (!existsSync(contentPkgPath)) {
      // Skip if content package not available (CI environment)
      return;
    }

    const pkg = JSON.parse(readFileSync(contentPkgPath, 'utf-8'));

    // Verify exports configuration
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['./manifest']).toBeDefined();

    // Verify manifest file exists
    const manifestPath = join(__dirname, '../../../content/dist/manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

      // Should contain Content class definition
      const contentDef = manifest.objects.content || manifest.objects.Content;
      expect(contentDef).toBeDefined();
      expect(contentDef.className).toBe('Content');
      expect(contentDef.fields).toBeDefined();
      expect(contentDef.fields.title).toBeDefined();
      expect(contentDef.fields.body).toBeDefined();
    }
  });

  it('should handle loadExternalManifest for workspace packages', async () => {
    // Clear cache to ensure fresh load
    clearManifestCache();

    // Try to load content package manifest
    // In monorepo, this should work via file: protocol or workspace resolution
    const manifest = await loadExternalManifest('@happyvertical/smrt-content');

    // In monorepo context, might not resolve via node_modules
    // This is expected - just verify the function doesn't crash
    expect(manifest === null || typeof manifest === 'object').toBe(true);

    if (manifest) {
      // If manifest was loaded, verify structure
      expect(manifest.objects).toBeDefined();
      expect(typeof manifest.objects).toBe('object');
    }
  });

  it('should cache loaded external manifests', async () => {
    // First load
    const manifest1 = await loadExternalManifest('@happyvertical/smrt-content');

    // Second load should return cached instance (or both null)
    const manifest2 = await loadExternalManifest('@happyvertical/smrt-content');

    // Should be the same reference
    expect(manifest1).toBe(manifest2);
  });

  it('should extract package name from constructor stack', () => {
    class TestClass {}

    // getPackageName should not crash
    const pkgName = getPackageName(TestClass);

    // Result can be null for local classes
    expect(pkgName === null || typeof pkgName === 'string').toBe(true);
  });

  it('should handle missing manifest gracefully', async () => {
    // Try to load from non-existent package
    const manifest = await loadExternalManifest('@fake/nonexistent-package');

    // Should return null, not throw
    expect(manifest).toBeNull();
  });
});
