/**
 * Unit tests for `importBuildAwareModule`'s publish-time determinism.
 *
 * The helper must always load dist when dist exists on disk, and must
 * fall back to source only when dist is absent. This removes the
 * publish-time flake where tsx's non-deterministic handling of the
 * `.ts` source branch broke 12–13 downstream packages on recent merges
 * (see the module-header comment in `../import-build-aware.ts`).
 *
 * @see https://github.com/happyvertical/smrt/issues/1139
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importBuildAwareModule } from '../import-build-aware.js';

describe('importBuildAwareModule — deterministic loader', () => {
  it('loads the scanner dist when dist exists on disk', async () => {
    // Default caller = this helper's URL. Package root = packages/core.
    // dist/vite-plugin/../scanner.js = dist/scanner.js — exists after a
    // normal build.
    const mod = await importBuildAwareModule<{
      ManifestGenerator: unknown;
    }>({
      source: '../scanner/index.ts',
      dist: '../scanner.js',
    });
    expect(mod.ManifestGenerator).toBeDefined();
  });

  it('loads dist even when the source path is wrong (dist always wins)', async () => {
    // Source deliberately nonsensical. Helper must NOT try source —
    // dist exists, so dist is the deterministic answer.
    const mod = await importBuildAwareModule<{
      ManifestGenerator: unknown;
    }>({
      source: '../scanner/does-not-exist.ts',
      dist: '../scanner.js',
    });
    expect(mod.ManifestGenerator).toBeDefined();
  });

  describe('when dist is absent', () => {
    let tmpRoot = '';
    let fakeCallerUrl = '';

    beforeEach(() => {
      // Build a fake package tree with no dist/. The fake "source" at
      // `src/vite-plugin/helper.ts` re-exports a sentinel.
      tmpRoot = mkdtempSync(join(tmpdir(), 'smrt-build-aware-'));
      const fakePluginDir = join(tmpRoot, 'src', 'vite-plugin');
      const fakeSourceTarget = join(tmpRoot, 'src', 'scanner', 'index.ts');
      mkdirSync(fakePluginDir, { recursive: true });
      mkdirSync(join(tmpRoot, 'src', 'scanner'), { recursive: true });

      writeFileSync(
        fakeSourceTarget,
        `export const SENTINEL = 'loaded-from-source';\n`,
        'utf-8',
      );
      // The caller URL mimics the plugin's location inside this fake tree.
      fakeCallerUrl = pathToFileURL(join(fakePluginDir, 'index.ts')).href;
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('falls back to source via relative import', async () => {
      const mod = await importBuildAwareModule<{ SENTINEL: string }>({
        source: '../scanner/index.ts',
        dist: '../scanner.js',
        callerUrl: fakeCallerUrl,
      });
      expect(mod.SENTINEL).toBe('loaded-from-source');
    });

    it('propagates the underlying error when source is also missing', async () => {
      await expect(
        importBuildAwareModule({
          source: '../scanner/does-not-exist.ts',
          dist: '../scanner.js',
          callerUrl: fakeCallerUrl,
        }),
      ).rejects.toThrow();
    });
  });
});
