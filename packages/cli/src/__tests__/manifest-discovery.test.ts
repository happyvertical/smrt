/**
 * Tests for manifest discovery deduplication, version conflict detection,
 * and app-level manifest generation (issue #881)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  autoDiscoverAndLoad,
  discoverManifests,
  generateAppManifest,
  SmrtVersionConflictError,
} from '../discovery/manifest-discovery.js';

describe('manifest-discovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'smrt-discovery-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('deduplication', () => {
    it('should deduplicate packages with same name@version but different paths', async () => {
      const nodeModules = join(tempDir, 'node_modules');

      // Create two package locations with the same name@version
      // Simulating pnpm's flat .pnpm structure (package.json at root of .pnpm/pkg@version/)
      const pkg1Dir = join(nodeModules, '@happyvertical', 'smrt-profiles-1');
      const pkg2Dir = join(nodeModules, '@happyvertical', 'smrt-profiles-2');

      await mkdir(pkg1Dir, { recursive: true });
      await mkdir(pkg2Dir, { recursive: true });

      // Both have the same name and version in package.json
      const pkgJson = JSON.stringify({
        name: '@happyvertical/smrt-profiles',
        version: '0.19.34',
        dependencies: {
          '@happyvertical/smrt-core': '^0.19.34',
        },
      });

      await writeFile(join(pkg1Dir, 'package.json'), pkgJson);
      await writeFile(join(pkg2Dir, 'package.json'), pkgJson);

      // Both have manifest files
      const manifestContent = JSON.stringify({
        objects: {
          Profile: { className: 'Profile' },
        },
      });

      await writeFile(join(pkg1Dir, 'manifest.json'), manifestContent);
      await writeFile(join(pkg2Dir, 'manifest.json'), manifestContent);

      const discovered = await discoverManifests(tempDir);

      // Should only load one manifest despite two copies existing
      const profileManifests = discovered.filter(
        (m) => m.packageName === '@happyvertical/smrt-profiles',
      );
      expect(profileManifests).toHaveLength(1);
    });

    it('should load different versions of the same package separately', async () => {
      const nodeModules = join(tempDir, 'node_modules');

      // Two different versions of the same package
      const pkg1Dir = join(nodeModules, '@happyvertical', 'smrt-profiles-v1');
      const pkg2Dir = join(nodeModules, '@happyvertical', 'smrt-profiles-v2');

      await mkdir(pkg1Dir, { recursive: true });
      await mkdir(pkg2Dir, { recursive: true });

      await writeFile(
        join(pkg1Dir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.33',
          dependencies: { '@happyvertical/smrt-core': '^0.19.33' },
        }),
      );

      await writeFile(
        join(pkg2Dir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.34',
          dependencies: { '@happyvertical/smrt-core': '^0.19.34' },
        }),
      );

      // Different manifest content for different versions
      await writeFile(
        join(pkg1Dir, 'manifest.json'),
        JSON.stringify({ objects: { ProfileV1: { className: 'ProfileV1' } } }),
      );
      await writeFile(
        join(pkg2Dir, 'manifest.json'),
        JSON.stringify({ objects: { ProfileV2: { className: 'ProfileV2' } } }),
      );

      const discovered = await discoverManifests(tempDir);

      // Should load both versions (they're different)
      const profileManifests = discovered.filter(
        (m) => m.packageName === '@happyvertical/smrt-profiles',
      );
      expect(profileManifests).toHaveLength(2);
    });

    it('should skip packages without manifests', async () => {
      const nodeModules = join(tempDir, 'node_modules');
      const pkgDir = join(nodeModules, '@happyvertical', 'smrt-profiles');

      await mkdir(pkgDir, { recursive: true });

      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.34',
          dependencies: { '@happyvertical/smrt-core': '^0.19.34' },
        }),
      );

      // No manifest file

      const discovered = await discoverManifests(tempDir);

      const profileManifests = discovered.filter(
        (m) => m.packageName === '@happyvertical/smrt-profiles',
      );
      expect(profileManifests).toHaveLength(0);
    });
  });

  describe('version conflict detection', () => {
    it('should throw SmrtVersionConflictError when multiple smrt package versions are found', async () => {
      const nodeModules = join(tempDir, 'node_modules');

      // Create packages with conflicting smrt-core versions
      const pkg1Dir = join(nodeModules, '@happyvertical', 'smrt-core-v1');
      const pkg2Dir = join(nodeModules, '@happyvertical', 'smrt-core-v2');

      await mkdir(pkg1Dir, { recursive: true });
      await mkdir(pkg2Dir, { recursive: true });

      await writeFile(
        join(pkg1Dir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-core',
          version: '0.19.33',
          dependencies: { smrt: '^0.19.33' },
        }),
      );

      await writeFile(
        join(pkg2Dir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-core',
          version: '0.19.34',
          dependencies: { smrt: '^0.19.34' },
        }),
      );

      // Add manifests so they're discovered
      await writeFile(
        join(pkg1Dir, 'manifest.json'),
        JSON.stringify({ objects: { CoreV1: {} } }),
      );
      await writeFile(
        join(pkg2Dir, 'manifest.json'),
        JSON.stringify({ objects: { CoreV2: {} } }),
      );

      await expect(autoDiscoverAndLoad(tempDir)).rejects.toThrow(
        SmrtVersionConflictError,
      );
    });

    it('should provide helpful error message with fix instructions', () => {
      const conflicts = new Map<string, Set<string>>();
      conflicts.set(
        '@happyvertical/smrt-core',
        new Set(['0.19.33', '0.19.34']),
      );

      const error = new SmrtVersionConflictError(conflicts);

      expect(error.message).toContain('SMRT Version Conflict Detected');
      expect(error.message).toContain('@happyvertical/smrt-core');
      expect(error.message).toContain('0.19.33');
      expect(error.message).toContain('0.19.34');
      expect(error.message).toContain('pnpm why');
      expect(error.message).toContain('overrides');
      expect(error.message).toContain('pnpm store prune');
    });

    it('should not throw when all smrt packages have consistent versions', async () => {
      const nodeModules = join(tempDir, 'node_modules');

      // Create packages with consistent versions
      const coreDir = join(nodeModules, '@happyvertical', 'smrt-core');
      const profilesDir = join(nodeModules, '@happyvertical', 'smrt-profiles');

      await mkdir(coreDir, { recursive: true });
      await mkdir(profilesDir, { recursive: true });

      await writeFile(
        join(coreDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-core',
          version: '0.19.34',
          dependencies: { smrt: '^0.19.34' },
        }),
      );

      await writeFile(
        join(profilesDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.34',
          dependencies: { '@happyvertical/smrt-core': '^0.19.34' },
        }),
      );

      await writeFile(
        join(coreDir, 'manifest.json'),
        JSON.stringify({ objects: { Core: {} } }),
      );
      await writeFile(
        join(profilesDir, 'manifest.json'),
        JSON.stringify({ objects: { Profile: {} } }),
      );

      // Should not throw
      const result = await autoDiscoverAndLoad(tempDir);
      expect(result.discovered).toHaveLength(2);
    });
  });

  describe('generateAppManifest (issue #881)', () => {
    it('should return null when no src/ directory exists', async () => {
      // tempDir has no src/ directory
      const result = await generateAppManifest(tempDir, { verbose: true });
      expect(result).toBeNull();
    });

    it(
      'should not error when source files contain no SMRT objects',
      { timeout: 30_000 },
      async () => {
        // Create src/ directory with a non-SMRT TypeScript file
        const srcDir = join(tempDir, 'src');
        await mkdir(srcDir, { recursive: true });
        await writeFile(
          join(srcDir, 'utils.ts'),
          'export function hello() { return "hi"; }',
        );

        // Also need a package.json for ManifestBuilder
        await writeFile(
          join(tempDir, 'package.json'),
          JSON.stringify({
            name: 'test-app',
            version: '1.0.0',
            dependencies: { '@happyvertical/smrt-core': '^0.19.0' },
          }),
        );

        // Should not throw - returns null or a path depending on whether
        // external base classes are included in the environment
        const result = await generateAppManifest(tempDir, { verbose: true });
        expect(result === null || typeof result === 'string').toBe(true);
      },
    );
  });

  describe('autoDiscoverAndLoad with auto-scan (issue #881)', () => {
    it('should attempt auto-scan when package manifests exist but no project manifest', async () => {
      const nodeModules = join(tempDir, 'node_modules');
      const pkgDir = join(nodeModules, '@happyvertical', 'smrt-profiles');

      await mkdir(pkgDir, { recursive: true });

      // Create a package manifest
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.34',
          dependencies: { '@happyvertical/smrt-core': '^0.19.34' },
        }),
      );
      await writeFile(
        join(pkgDir, 'manifest.json'),
        JSON.stringify({
          objects: {
            Profile: { className: 'Profile' },
          },
        }),
      );

      // No project manifest, but package manifests exist
      // autoDiscoverAndLoad should attempt auto-scan
      // It may not find SMRT objects (no src/ with SMRT classes), but shouldn't error
      const result = await autoDiscoverAndLoad(tempDir);

      // Should still discover the package manifest
      expect(result.discovered.length).toBeGreaterThanOrEqual(1);
      expect(result.discovered.some((m) => m.source === 'package')).toBe(true);
    });

    it('should not auto-scan when project manifest already exists', async () => {
      const nodeModules = join(tempDir, 'node_modules');
      const pkgDir = join(nodeModules, '@happyvertical', 'smrt-profiles');
      const smrtDir = join(tempDir, '.smrt');

      await mkdir(pkgDir, { recursive: true });
      await mkdir(smrtDir, { recursive: true });

      // Create a package manifest
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-profiles',
          version: '0.19.34',
          dependencies: { '@happyvertical/smrt-core': '^0.19.34' },
        }),
      );
      await writeFile(
        join(pkgDir, 'manifest.json'),
        JSON.stringify({
          objects: { Profile: { className: 'Profile' } },
        }),
      );

      // Create a project manifest (simulating existing .smrt/manifest.json)
      await writeFile(
        join(smrtDir, 'manifest.json'),
        JSON.stringify({
          objects: {
            Publication: {
              className: 'Publication',
              extends: 'Profile',
            },
          },
        }),
      );

      // Spy on generateAppManifest module to verify it's NOT called
      const spy = vi.spyOn(
        await import('../discovery/manifest-discovery.js'),
        'generateAppManifest',
      );

      const result = await autoDiscoverAndLoad(tempDir);

      // Should find both project and package manifests
      expect(result.discovered.some((m) => m.source === 'project')).toBe(true);
      expect(result.discovered.some((m) => m.source === 'package')).toBe(true);

      // generateAppManifest should NOT have been called (project manifest exists)
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it('should not auto-scan when there are no package manifests', async () => {
      // Empty tempDir - no manifests at all
      const result = await autoDiscoverAndLoad(tempDir);

      // Should find nothing and not error
      expect(result.discovered).toHaveLength(0);
      expect(result.totalObjects).toBe(0);
    });
  });
});
