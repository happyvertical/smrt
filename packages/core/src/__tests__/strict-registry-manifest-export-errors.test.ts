/**
 * Strict-mode regression tests for the three MANIFEST_EXPORT_* error codes.
 *
 * Release C (#1134) flipped SMRT_STRICT_REGISTRY to on-by-default, which
 * promotes four error-severity diagnostics from silent to throwing. The
 * fourth, PACKAGE_MANIFEST_READ_FAILED, is covered by
 * register-package-manifest.test.ts. The three MANIFEST_EXPORT_* codes
 * fire in a different path (resolveManifestExportPathSync, reached via
 * loadExternalManifestSyncWithNode / the NodeModulesFallbackSource),
 * which the existing tests don't exercise.
 *
 * Each code gets two tests:
 *   - throw path: strict default, expect throw with the opt-out hint
 *   - opt-out path: SMRT_STRICT_REGISTRY=false, expect null return with
 *     the diagnostic recorded
 *
 * PR #1140 review raised the missing coverage as a gap (subagent review
 * section 4).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeModulesFallbackSource } from '../manifest/sources/fallback.js';
import { ObjectRegistry } from '../registry.js';

function writeScopedPackage(
  appDir: string,
  packageName: string,
  packageJson: Record<string, unknown>,
  distFiles: Record<string, string> = {},
): string {
  const [scope, pkg] = packageName.startsWith('@')
    ? packageName.slice(1).split('/')
    : [undefined, packageName];
  const packageDir = scope
    ? join(appDir, 'node_modules', `@${scope}`, pkg)
    : join(appDir, 'node_modules', pkg);

  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.0', ...packageJson }),
  );
  for (const [relative, content] of Object.entries(distFiles)) {
    const filePath = join(packageDir, relative);
    mkdirSync(join(filePath, '..'), { recursive: true });
    writeFileSync(filePath, content);
  }
  return packageDir;
}

describe('strict-mode error paths for MANIFEST_EXPORT_* codes (#1134)', () => {
  let tempRoot = '';
  let appDir = '';
  let originalCwd: string;
  let originalStrict: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalStrict = process.env.SMRT_STRICT_REGISTRY;
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-strict-exports-'));
    appDir = join(tempRoot, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'strict-test-app', version: '1.0.0' }),
    );
    process.chdir(appDir);
    ObjectRegistry.clearDiagnostics();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalStrict === undefined) {
      delete process.env.SMRT_STRICT_REGISTRY;
    } else {
      process.env.SMRT_STRICT_REGISTRY = originalStrict;
    }
    ObjectRegistry.clearDiagnostics();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  // --- MANIFEST_EXPORT_INVALID ------------------------------------------

  describe('MANIFEST_EXPORT_INVALID — exports entry with no import/default/require', () => {
    it('throws in strict mode (default)', async () => {
      writeScopedPackage(appDir, '@happyvertical/smrt-fixture-invalid-export', {
        exports: {
          // Object form with only `types` — no import / default / require
          './manifest.json': { types: './dist/manifest.d.ts' },
        },
      });
      const source = new NodeModulesFallbackSource();
      await expect(
        source.hydrate({
          packageName: '@happyvertical/smrt-fixture-invalid-export',
        }),
      ).rejects.toThrow(/MANIFEST_EXPORT_INVALID/);
    });

    it('records the diagnostic and returns false when SMRT_STRICT_REGISTRY=false', async () => {
      process.env.SMRT_STRICT_REGISTRY = 'false';
      writeScopedPackage(appDir, '@happyvertical/smrt-fixture-invalid-optout', {
        exports: {
          './manifest.json': { types: './dist/manifest.d.ts' },
        },
      });
      const source = new NodeModulesFallbackSource();
      const hydrated = await source.hydrate({
        packageName: '@happyvertical/smrt-fixture-invalid-optout',
      });
      expect(hydrated).toBe(false);
      const diagnostics = ObjectRegistry.getDiagnostics();
      expect(
        diagnostics.some((d) => d.code === 'MANIFEST_EXPORT_INVALID'),
      ).toBe(true);
    });
  });

  // --- MANIFEST_EXPORT_NOT_JSON -----------------------------------------

  describe('MANIFEST_EXPORT_NOT_JSON — manifest export points at a non-JSON file', () => {
    it('throws in strict mode (default)', async () => {
      writeScopedPackage(appDir, '@happyvertical/smrt-fixture-not-json', {
        exports: {
          './manifest.json': './dist/manifest.js',
        },
      });
      const source = new NodeModulesFallbackSource();
      await expect(
        source.hydrate({ packageName: '@happyvertical/smrt-fixture-not-json' }),
      ).rejects.toThrow(/MANIFEST_EXPORT_NOT_JSON/);
    });

    it('records the diagnostic and returns false when SMRT_STRICT_REGISTRY=false', async () => {
      process.env.SMRT_STRICT_REGISTRY = 'false';
      writeScopedPackage(
        appDir,
        '@happyvertical/smrt-fixture-not-json-optout',
        {
          exports: { './manifest.json': './dist/manifest.js' },
        },
      );
      const source = new NodeModulesFallbackSource();
      const hydrated = await source.hydrate({
        packageName: '@happyvertical/smrt-fixture-not-json-optout',
      });
      expect(hydrated).toBe(false);
      const diagnostics = ObjectRegistry.getDiagnostics();
      expect(
        diagnostics.some((d) => d.code === 'MANIFEST_EXPORT_NOT_JSON'),
      ).toBe(true);
    });
  });

  // --- MANIFEST_EXPORT_NOT_FOUND ----------------------------------------

  describe('MANIFEST_EXPORT_NOT_FOUND — exports declares a manifest.json that does not exist on disk', () => {
    it('throws in strict mode (default)', async () => {
      writeScopedPackage(appDir, '@happyvertical/smrt-fixture-missing-file', {
        exports: {
          './manifest.json': './dist/manifest.json',
        },
        // Intentionally no dist/manifest.json file — only package.json
      });
      const source = new NodeModulesFallbackSource();
      await expect(
        source.hydrate({
          packageName: '@happyvertical/smrt-fixture-missing-file',
        }),
      ).rejects.toThrow(/MANIFEST_EXPORT_NOT_FOUND/);
    });

    it('records the diagnostic and returns false when SMRT_STRICT_REGISTRY=false', async () => {
      process.env.SMRT_STRICT_REGISTRY = 'false';
      writeScopedPackage(
        appDir,
        '@happyvertical/smrt-fixture-missing-file-optout',
        {
          exports: { './manifest.json': './dist/manifest.json' },
        },
      );
      const source = new NodeModulesFallbackSource();
      const hydrated = await source.hydrate({
        packageName: '@happyvertical/smrt-fixture-missing-file-optout',
      });
      expect(hydrated).toBe(false);
      const diagnostics = ObjectRegistry.getDiagnostics();
      expect(
        diagnostics.some((d) => d.code === 'MANIFEST_EXPORT_NOT_FOUND'),
      ).toBe(true);
    });
  });

  // --- Opt-out hint in error messages -----------------------------------

  it('thrown error messages include the SMRT_STRICT_REGISTRY=false opt-out hint', async () => {
    writeScopedPackage(appDir, '@happyvertical/smrt-fixture-hint-check', {
      exports: { './manifest.json': './dist/manifest.js' }, // triggers NOT_JSON
    });
    const source = new NodeModulesFallbackSource();
    let caught: Error | undefined;
    try {
      await source.hydrate({
        packageName: '@happyvertical/smrt-fixture-hint-check',
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).toMatch(/SMRT_STRICT_REGISTRY=false/);
  });
});
