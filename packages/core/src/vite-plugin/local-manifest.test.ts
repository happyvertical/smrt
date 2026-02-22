/**
 * Tests for local manifest writing (Issue #963)
 *
 * Verifies that smrtPlugin writes .smrt/manifest.json for CLI discovery
 * in non-library builds (SvelteKit apps, standalone Vite apps, etc.).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { smrtPlugin } from './index';

describe('smrtPlugin local manifest writing (Issue #963)', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Create a temporary project directory
    tmpDir = resolve(
      import.meta.dirname,
      `__test-local-manifest-${Date.now()}`,
    );
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    // Create a minimal package.json
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: {
          '@happyvertical/smrt-core': '*',
        },
      }),
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should write .smrt/manifest.json during configResolved', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    // Simulate Vite's configResolved hook (non-library build)
    const mockConfig = {
      root: tmpDir,
      build: {},
      plugins: [],
    };

    await (plugin as any).configResolved(mockConfig);

    // Verify .smrt/manifest.json was written
    const manifestPath = join(tmpDir, '.smrt', 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest).toHaveProperty('version');
    expect(manifest).toHaveProperty('objects');
  });

  it('should write .smrt/manifest.json during buildStart', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    // configResolved must be called first to set projectRoot
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [],
    });

    // Remove the manifest written by configResolved
    const manifestPath = join(tmpDir, '.smrt', 'manifest.json');
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
    }

    // Now call buildStart
    await (plugin as any).buildStart();

    // Verify .smrt/manifest.json was written again
    expect(existsSync(manifestPath)).toBe(true);
  });

  it('should still write dist/manifest.json during closeBundle for library builds', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    // configResolved with library build config
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {
        lib: { entry: 'src/index.ts' },
        outDir: 'dist',
      },
      plugins: [],
    });

    // closeBundle should write dist/manifest.json for library builds
    await (plugin as any).closeBundle();

    const distManifestPath = join(tmpDir, 'dist', 'manifest.json');
    expect(existsSync(distManifestPath)).toBe(true);

    // .smrt/manifest.json should also exist (written during configResolved)
    const localManifestPath = join(tmpDir, '.smrt', 'manifest.json');
    expect(existsSync(localManifestPath)).toBe(true);
  });

  it('should not write dist/manifest.json during closeBundle for non-library builds', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    // configResolved without library build config
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [],
    });

    // closeBundle should NOT write dist/manifest.json for non-library builds
    await (plugin as any).closeBundle();

    const distManifestPath = join(tmpDir, 'dist', 'manifest.json');
    expect(existsSync(distManifestPath)).toBe(false);

    // But .smrt/manifest.json should exist (written during configResolved)
    const localManifestPath = join(tmpDir, '.smrt', 'manifest.json');
    expect(existsSync(localManifestPath)).toBe(true);
  });
});
