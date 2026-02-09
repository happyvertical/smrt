/**
 * Tests for manifest discovery deduplication, version conflict detection,
 * and missing manifest error (issue #881)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autoDiscoverAndLoad,
  discoverManifests,
  SmrtManifestNotBuiltError,
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

  describe('missing project manifest detection (issue #881)', () => {
    it('should throw SmrtManifestNotBuiltError when package manifests exist but project has no manifest and has src/', async () => {
      const nodeModules = join(tempDir, 'node_modules');
      const pkgDir = join(nodeModules, '@happyvertical', 'smrt-profiles');
      const srcDir = join(tempDir, 'src');

      await mkdir(pkgDir, { recursive: true });
      await mkdir(srcDir, { recursive: true });

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

      // No project manifest, but src/ exists → needs build
      await expect(autoDiscoverAndLoad(tempDir)).rejects.toThrow(
        SmrtManifestNotBuiltError,
      );
    });

    it('should provide helpful error message telling user to build', () => {
      const error = new SmrtManifestNotBuiltError();

      expect(error.message).toContain('Project manifest not found');
      expect(error.message).toContain('npm run build');
      expect(error.name).toBe('SmrtManifestNotBuiltError');
    });

    it('should not throw when project manifest already exists', async () => {
      const nodeModules = join(tempDir, 'node_modules');
      const pkgDir = join(nodeModules, '@happyvertical', 'smrt-profiles');
      const smrtDir = join(tempDir, '.smrt');
      const srcDir = join(tempDir, 'src');

      await mkdir(pkgDir, { recursive: true });
      await mkdir(smrtDir, { recursive: true });
      await mkdir(srcDir, { recursive: true });

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

      // Create a project manifest (simulating built output)
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

      // Should not throw - project manifest exists
      const result = await autoDiscoverAndLoad(tempDir);
      expect(result.discovered.some((m) => m.source === 'project')).toBe(true);
      expect(result.discovered.some((m) => m.source === 'package')).toBe(true);
    });

    it('should not throw when package manifests exist but no src/ directory', async () => {
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
          objects: { Profile: { className: 'Profile' } },
        }),
      );

      // No src/ directory → no local source to build, just using packages
      const result = await autoDiscoverAndLoad(tempDir);
      expect(result.discovered.length).toBeGreaterThanOrEqual(1);
    });

    it('should not throw when there are no package manifests', async () => {
      // Empty tempDir - no manifests at all
      const result = await autoDiscoverAndLoad(tempDir);

      // Should find nothing and not error
      expect(result.discovered).toHaveLength(0);
      expect(result.totalObjects).toBe(0);
    });
  });
});
