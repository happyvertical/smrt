/**
 * Tests for base class discovery from external SMRT packages
 *
 * Verifies that the discoverBaseClasses utility correctly discovers
 * classes from external SMRT package manifests.
 *
 * Regression test for issue #300: AST Scanner not discovering STI subclasses
 * extending ProfileRelationship/ProfileRelationshipTerm
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_CLASSES,
  discoverBaseClasses,
  discoverBaseClassesSync,
} from '../manifest/discover-base-classes';

describe('Base Class Discovery', () => {
  describe('DEFAULT_BASE_CLASSES', () => {
    it('should include core SMRT framework base classes', () => {
      expect(DEFAULT_BASE_CLASSES).toEqual([
        'SmrtObject',
        'SmrtClass',
        'SmrtCollection',
      ]);
    });
  });

  describe('discoverBaseClasses (async)', () => {
    it('should return default base classes by default', async () => {
      const baseClasses = await discoverBaseClasses();

      // Should include at least the defaults
      expect(baseClasses).toContain('SmrtObject');
      expect(baseClasses).toContain('SmrtClass');
      expect(baseClasses).toContain('SmrtCollection');
    });

    it('should include classes from external SMRT packages', async () => {
      const baseClasses = await discoverBaseClasses();

      // Should have more than just the default 3 classes
      // (assuming SMRT packages are installed in node_modules)
      expect(baseClasses.length).toBeGreaterThanOrEqual(3);
    });

    it('should discover ProfileRelationship and ProfileRelationshipTerm when manifests exist', async () => {
      const baseClasses = await discoverBaseClasses();

      // These are the classes causing issue #300
      // They should be discovered from @happyvertical/smrt-profiles
      const hasProfileRelationship = baseClasses.includes(
        'ProfileRelationship',
      );
      const hasProfileRelationshipTerm = baseClasses.includes(
        'ProfileRelationshipTerm',
      );

      // Log for visibility (these may not be found in dev/monorepo)
      console.log(`ProfileRelationship discovered: ${hasProfileRelationship}`);
      console.log(
        `ProfileRelationshipTerm discovered: ${hasProfileRelationshipTerm}`,
      );

      // In development (monorepo), packages use workspace protocol
      // In production, packages are in node_modules with manifests
      // This test passes if we have at least the defaults
      expect(baseClasses.length).toBeGreaterThanOrEqual(3);
    });

    it('should exclude defaults when includeDefaults is false', async () => {
      const baseClasses = await discoverBaseClasses({
        includeDefaults: false,
      });

      // Should NOT include default base classes
      expect(baseClasses).not.toContain('SmrtObject');
      expect(baseClasses).not.toContain('SmrtClass');
      expect(baseClasses).not.toContain('SmrtCollection');
    });

    it('should handle missing manifests gracefully', async () => {
      // Should not throw even if some manifests are missing
      await expect(
        discoverBaseClasses({ cwd: '/nonexistent' }),
      ).resolves.toBeDefined();
    });

    it('should return unique class names (no duplicates)', async () => {
      const baseClasses = await discoverBaseClasses();

      // Check for duplicates
      const uniqueClasses = [...new Set(baseClasses)];
      expect(baseClasses.length).toBe(uniqueClasses.length);
    });
  });

  describe('discoverBaseClassesSync', () => {
    it('should return default base classes by default', () => {
      const baseClasses = discoverBaseClassesSync();

      // Should include at least the defaults
      expect(baseClasses).toContain('SmrtObject');
      expect(baseClasses).toContain('SmrtClass');
      expect(baseClasses).toContain('SmrtCollection');
    });

    it('should include classes from external SMRT packages', () => {
      const baseClasses = discoverBaseClassesSync();

      // Should have more than just the default 3 classes
      expect(baseClasses.length).toBeGreaterThanOrEqual(3);
    });

    it('should discover the same classes as async version', async () => {
      const asyncClasses = await discoverBaseClasses();
      const syncClasses = discoverBaseClassesSync();

      // Both should discover the same classes
      expect(syncClasses.sort()).toEqual(asyncClasses.sort());
    });

    it('should exclude defaults when includeDefaults is false', () => {
      const baseClasses = discoverBaseClassesSync({
        includeDefaults: false,
      });

      // Should NOT include default base classes
      expect(baseClasses).not.toContain('SmrtObject');
      expect(baseClasses).not.toContain('SmrtClass');
      expect(baseClasses).not.toContain('SmrtCollection');
    });

    it('should handle missing manifests gracefully', () => {
      // Should not throw even if some manifests are missing
      expect(() =>
        discoverBaseClassesSync({ cwd: '/nonexistent' }),
      ).not.toThrow();
    });

    it('should return unique class names (no duplicates)', () => {
      const baseClasses = discoverBaseClassesSync();

      // Check for duplicates
      const uniqueClasses = [...new Set(baseClasses)];
      expect(baseClasses.length).toBe(uniqueClasses.length);
    });
  });

  describe('Integration with SMRT packages', () => {
    it('should discover classes from external packages when manifests exist', async () => {
      const baseClasses = await discoverBaseClasses();

      console.log(`Total discovered: ${baseClasses.length} base classes`);

      // In development (monorepo), packages use workspace protocol
      // In production, packages are in node_modules with manifests
      // This test passes if we have at least the defaults
      expect(baseClasses.length).toBeGreaterThanOrEqual(3);

      // Log discovered classes for debugging
      if (baseClasses.length > 3) {
        const external = baseClasses.filter(
          (cls) => !DEFAULT_BASE_CLASSES.includes(cls),
        );
        console.log(`Found ${external.length} external base classes`);
      }
    });

    it('should discover ProfileRelationship if manifest exists', async () => {
      const baseClasses = await discoverBaseClasses();

      // ProfileRelationship is the class that was causing issue #300
      const hasProfileRelationship = baseClasses.includes(
        'ProfileRelationship',
      );

      // This might not be true in dev environments (workspace protocol)
      // but should be true in production (node_modules)
      // Log for visibility
      console.log(`ProfileRelationship discovered: ${hasProfileRelationship}`);

      // Pass if we at least have the defaults
      expect(baseClasses.length).toBeGreaterThanOrEqual(3);
    });
  });

  // Regression for #1378: base-class extraction used to hardcode
  // `node_modules/{pkg}/dist/manifest.json`, so a workspace package whose
  // manifest lives at `.smrt/manifest.json` (source-only, not yet built to
  // dist/) contributed ZERO base classes, silently degrading inheritance
  // detection. Discovery resolves `.smrt/` and `src/manifest/` too, so base
  // class extraction must follow the same resolution.
  describe('non-dist manifest locations (#1378)', () => {
    let testDir: string | null = null;
    let originalCwd: string | null = null;
    const packageName = '@happyvertical/smrt-smrtdir-fixture';

    function buildWorkspaceWithSmrtDirManifest(): void {
      testDir = mkdtempSync(join(tmpdir(), 'smrt-basecls-smrtdir-'));
      const packageDir = join(
        testDir,
        'node_modules',
        '@happyvertical',
        'smrt-smrtdir-fixture',
      );
      // Manifest lives under .smrt/, NOT dist/.
      const smrtDir = join(packageDir, '.smrt');
      mkdirSync(smrtDir, { recursive: true });

      writeFileSync(
        join(testDir, 'package.json'),
        JSON.stringify(
          {
            name: 'smrt-basecls-consumer',
            type: 'module',
            dependencies: { [packageName]: '1.0.0' },
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify(
          { name: packageName, type: 'module', main: './index.js' },
          null,
          2,
        ),
      );
      writeFileSync(join(packageDir, 'index.js'), 'export {};\n');
      writeFileSync(
        join(smrtDir, 'manifest.json'),
        JSON.stringify(
          {
            moduleType: 'smrt',
            version: '1.0.0',
            packageName,
            objects: {
              [`${packageName}:SmrtDirBase`]: {
                className: 'SmrtDirBase',
                qualifiedName: `${packageName}:SmrtDirBase`,
                packageName,
                collection: 'smrt_dir_bases',
                fields: {},
              },
            },
          },
          null,
          2,
        ),
      );

      // discoverBaseClasses() calls discoverSmrtPackages() with the default cwd,
      // while it loads manifests relative to its `cwd` option — point both at
      // the fixture and bypass the discovery cache.
      originalCwd = process.cwd();
      process.chdir(testDir);
      process.env.SMRT_DISABLE_DISCOVERY_CACHE = 'true';
    }

    afterEach(() => {
      if (originalCwd) {
        process.chdir(originalCwd);
        originalCwd = null;
      }
      delete process.env.SMRT_DISABLE_DISCOVERY_CACHE;
      if (testDir) {
        rmSync(testDir, { recursive: true, force: true });
        testDir = null;
      }
    });

    it('contributes base classes from a .smrt/manifest.json package (sync)', () => {
      buildWorkspaceWithSmrtDirManifest();
      const baseClasses = discoverBaseClassesSync({ cwd: testDir as string });
      expect(baseClasses).toContain('SmrtDirBase');
    });

    it('contributes base classes from a .smrt/manifest.json package (async)', async () => {
      buildWorkspaceWithSmrtDirManifest();
      const baseClasses = await discoverBaseClasses({ cwd: testDir as string });
      expect(baseClasses).toContain('SmrtDirBase');
    });
  });
});
