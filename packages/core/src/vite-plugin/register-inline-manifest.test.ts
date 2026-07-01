/**
 * Tests for the library-build manifest-inlining transform (#1506/#1507).
 *
 * Package dists used to self-register field metadata by resolving
 * `new URL('./manifest.json', import.meta.url)` at runtime. That silently
 * no-ops once a consumer's bundler (e.g. a SvelteKit server build) relocates
 * the compiled `__smrt-register__` module into its own chunks directory —
 * plain fields vanish from the registry, INSERTs drop them (#1506) and WHERE
 * validation rejects them (#1507). The smrtPlugin transform now inlines the
 * scanned manifest into the shim at library-build time, so the published dist
 * carries its field metadata as data and no bundler layout can break it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import {
  generateInlineRegisterModule,
  isRegisterShimModuleId,
  smrtPlugin,
} from './index';

const REGISTER_SHIM_SOURCE = [
  "import { ObjectRegistry } from '@happyvertical/smrt-core';",
  '',
  'ObjectRegistry.registerPackageManifest(',
  "  new URL('./manifest.json', import.meta.url),",
  ');',
  '',
].join('\n');

describe('smrtPlugin __smrt-register__ manifest inlining (#1506/#1507)', () => {
  let tmpDir: string;
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    tmpDir = resolve(
      import.meta.dirname,
      `__test-register-inline-${Date.now()}`,
    );
    mkdirSync(join(tmpDir, 'src'), { recursive: true });

    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/inline-register-app',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@happyvertical/smrt-core': '*',
        },
      }),
    );

    // A model with PLAIN (undecorated) fields — exactly the kind production
    // dropped: `metricKey` is the field #1507's WHERE validation rejected.
    writeFileSync(
      join(tmpDir, 'src', 'UsageMetric.ts'),
      [
        "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
        '',
        '@smrt()',
        'export class UsageMetric extends SmrtObject {',
        "  metricKey: string = '';",
        '  quantity: number = 0.0;',
        '}',
        '',
      ].join('\n'),
    );

    writeFileSync(
      join(tmpDir, 'src', '__smrt-register__.ts'),
      REGISTER_SHIM_SOURCE,
    );
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    ObjectRegistry.clear();
    clearManifestCache();
    restoreRegistry();
  });

  async function createLibraryBuildPlugin() {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {
        lib: { entry: join(tmpDir, 'src/index.ts') },
        outDir: 'dist',
        minify: false,
      },
      plugins: [],
    });
    return plugin;
  }

  it('replaces the shim with the inlined manifest during library builds', async () => {
    const plugin = await createLibraryBuildPlugin();

    const result = (plugin as any).transform(
      REGISTER_SHIM_SOURCE,
      join(tmpDir, 'src', '__smrt-register__.ts'),
    );

    expect(result).not.toBeNull();
    const { code } = result;

    // The load-bearing property: no runtime path resolution left for a
    // downstream bundler to break.
    expect(code).not.toContain('new URL(');
    expect(code).not.toContain('import.meta.url');
    expect(code).toContain(
      "import { ObjectRegistry } from '@happyvertical/smrt-core';",
    );
    expect(code).toContain('registerPackageManifest(JSON.parse(');

    // The scanned field metadata is embedded as data.
    expect(code).toContain('metricKey');
    expect(code).toContain('quantity');
  });

  it('inlined manifest registers fields with no manifest.json on disk (bundled-chunk scenario)', async () => {
    const plugin = await createLibraryBuildPlugin();

    const { code } = (plugin as any).transform(
      REGISTER_SHIM_SOURCE,
      join(tmpDir, 'src', '__smrt-register__.ts'),
    );

    // Extract the embedded JSON literal and run the exact call the generated
    // module makes. Nothing here reads the filesystem — this is what executes
    // inside a relocated SvelteKit server chunk.
    const match = code.match(
      /registerPackageManifest\(JSON\.parse\((".*")\)\)/s,
    );
    if (!match) throw new Error('inlined manifest literal not found');
    const manifest = JSON.parse(JSON.parse(match[1]));

    ObjectRegistry.clear();
    clearManifestCache();
    ObjectRegistry.clearDiagnostics();

    const result = ObjectRegistry.registerPackageManifest(manifest);

    expect(result.loaded).toBe(true);
    expect(result.packageName).toBe('@fixture/inline-register-app');
    expect(result.objectsRegistered).toBeGreaterThanOrEqual(1);

    const codes = ObjectRegistry.getDiagnostics().map((d) => d.code);
    expect(codes).not.toContain('PACKAGE_MANIFEST_NOT_FOUND');

    // The manifest cache is seeded so @smrt() decorators registering later
    // find the plain fields.
    const cache = (globalThis as any).__smrtManifestCache as Map<string, any>;
    const cached = cache.get('@fixture/inline-register-app');
    expect(cached).toBeDefined();
    const usageMetric = Object.values(cached.objects).find(
      (def: any) => def.className === 'UsageMetric',
    ) as any;
    expect(usageMetric?.fields?.metricKey).toBeDefined();
    expect(usageMetric?.fields?.quantity).toBeDefined();
  });

  it('leaves the shim untouched in non-library builds', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [],
    });

    const result = (plugin as any).transform(
      REGISTER_SHIM_SOURCE,
      join(tmpDir, 'src', '__smrt-register__.ts'),
    );

    expect(result).toBeNull();
  });

  it('does not transform other modules in library builds', async () => {
    const plugin = await createLibraryBuildPlugin();

    const result = (plugin as any).transform(
      'export const x = 1;',
      join(tmpDir, 'src', 'UsageMetric.ts'),
    );

    expect(result).toBeNull();
  });

  it('forces re-transform of cached shims in watch mode', async () => {
    const plugin = await createLibraryBuildPlugin();

    expect(
      (plugin as any).shouldTransformCachedModule({
        id: join(tmpDir, 'src', '__smrt-register__.ts'),
      }),
    ).toBe(true);
    expect(
      (plugin as any).shouldTransformCachedModule({
        id: join(tmpDir, 'src', 'UsageMetric.ts'),
      }),
    ).toBeNull();
  });

  describe('isRegisterShimModuleId', () => {
    it('matches shim ids across extensions and strips query strings', () => {
      expect(isRegisterShimModuleId('/pkg/src/__smrt-register__.ts')).toBe(
        true,
      );
      expect(
        isRegisterShimModuleId('/pkg/src/__smrt-register__.ts?v=123'),
      ).toBe(true);
      expect(isRegisterShimModuleId('/pkg/dist/__smrt-register__.js')).toBe(
        true,
      );
    });

    it('rejects non-shim ids and node_modules paths', () => {
      expect(isRegisterShimModuleId('/pkg/src/index.ts')).toBe(false);
      expect(
        isRegisterShimModuleId(
          '/pkg/node_modules/@happyvertical/smrt-users/dist/__smrt-register__.js',
        ),
      ).toBe(false);
      expect(
        isRegisterShimModuleId('/pkg/src/not__smrt-register__extra.ts'),
      ).toBe(false);
    });
  });

  describe('generateInlineRegisterModule', () => {
    it('round-trips the manifest through the emitted JSON literal', () => {
      const manifest = {
        version: '1.0.0',
        timestamp: 0,
        moduleType: 'smrt',
        packageName: '@fixture/roundtrip',
        objects: {
          '@fixture/roundtrip:Thing': {
            className: 'Thing',
            fields: {
              label: { type: 'text' },
              tricky: { type: 'text', default: 'quote " backslash \\ done' },
            },
          },
        },
      } as any;

      const code = generateInlineRegisterModule(manifest);
      const match = code.match(/JSON\.parse\((".*")\)/s);
      if (!match) throw new Error('inlined manifest literal not found');
      expect(JSON.parse(JSON.parse(match[1]))).toEqual(manifest);
    });
  });
});
