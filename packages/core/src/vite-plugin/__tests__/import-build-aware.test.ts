/**
 * Unit tests for `importBuildAwareModule`'s publish-time determinism.
 *
 * The helper must always load dist when dist exists on disk, and must
 * fall back to source only when dist is absent. This removes the
 * publish-time flake where tsx's non-deterministic handling of the
 * `.ts` source branch broke 12–13 downstream packages on recent merges
 * (see the module-header comment in `../import-build-aware.ts`).
 *
 * Every test synthesizes a fake package tree in `/tmp` with only the
 * shape we want to exercise — no dependency on whether
 * `packages/core/dist/*` has been built. The helper derives its
 * package root from `callerUrl`, so the `/tmp`-rooted tree fully
 * isolates each case.
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
  let pkgRoot = '';
  let callerUrl = '';

  beforeEach(() => {
    pkgRoot = mkdtempSync(join(tmpdir(), 'smrt-build-aware-'));
    // Caller lives at `<pkgRoot>/src/vite-plugin/index.ts`, which is
    // where the real plugin sits inside `packages/core`. The helper
    // walks up two segments from the caller to locate `<pkgRoot>/dist`.
    const srcPluginDir = join(pkgRoot, 'src', 'vite-plugin');
    mkdirSync(srcPluginDir, { recursive: true });
    callerUrl = pathToFileURL(join(srcPluginDir, 'index.ts')).href;
  });

  afterEach(() => {
    rmSync(pkgRoot, { recursive: true, force: true });
  });

  /**
   * Write a fake scanner module. `where` selects which on-disk copy
   * gets created; each copy exports a distinct sentinel so the test
   * can assert which one actually got loaded.
   */
  function writeScannerCopy(where: 'src' | 'dist', sentinel: string): void {
    const dir = where === 'dist' ? join(pkgRoot, 'dist') : join(pkgRoot, 'src');
    mkdirSync(dir, { recursive: true });
    const filename = where === 'dist' ? 'scanner.js' : 'scanner.ts';
    writeFileSync(
      join(dir, filename),
      `export const SENTINEL = ${JSON.stringify(sentinel)};\n`,
      'utf-8',
    );
  }

  it('loads dist when dist exists (the publish-time path)', async () => {
    writeScannerCopy('dist', 'from-dist');

    const mod = await importBuildAwareModule<{ SENTINEL: string }>({
      source: '../scanner.ts',
      dist: '../scanner.js',
      callerUrl,
    });
    expect(mod.SENTINEL).toBe('from-dist');
  });

  it('loads dist even when source is wrong (dist-always-wins)', async () => {
    // Both sentinels present; the helper must pick dist.
    writeScannerCopy('dist', 'from-dist');
    writeScannerCopy('src', 'from-src');

    const mod = await importBuildAwareModule<{ SENTINEL: string }>({
      source: '../scanner/does-not-exist.ts',
      dist: '../scanner.js',
      callerUrl,
    });
    expect(mod.SENTINEL).toBe('from-dist');
  });

  it('falls back to source when dist is absent (fresh-clone path)', async () => {
    writeScannerCopy('src', 'from-src');

    const mod = await importBuildAwareModule<{ SENTINEL: string }>({
      source: '../scanner.ts',
      dist: '../scanner.js',
      callerUrl,
    });
    expect(mod.SENTINEL).toBe('from-src');
  });

  it('propagates the underlying error when neither dist nor source exists', async () => {
    // Nothing written. Helper takes the source fallback, which also misses.
    await expect(
      importBuildAwareModule({
        source: '../scanner.ts',
        dist: '../scanner.js',
        callerUrl,
      }),
    ).rejects.toThrow();
  });
});
