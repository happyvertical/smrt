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

function createExternalSmrtPackage(
  projectRoot: string,
  packageName: string,
): void {
  const packageDir = join(
    projectRoot,
    'node_modules',
    ...packageName.split('/'),
  );
  mkdirSync(join(packageDir, 'dist'), { recursive: true });

  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest': './dist/manifest.json',
        './manifest.json': './dist/manifest.json',
      },
    }),
  );

  writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(
    join(packageDir, 'dist', 'manifest.json'),
    JSON.stringify({
      version: '1.0.0',
      timestamp: Date.now(),
      packageName,
      moduleType: 'smrt',
      objects: {
        [`${packageName}:FixtureExternal`]: {
          className: 'FixtureExternal',
          qualifiedName: `${packageName}:FixtureExternal`,
          packageName,
          collection: 'fixture_externals',
          fields: {},
        },
      },
    }),
  );
}

function createLocalSmrtObject(projectRoot: string): void {
  writeFileSync(
    join(projectRoot, 'src', 'LocalThing.ts'),
    [
      "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
      '',
      '@smrt()',
      'export class LocalThing extends SmrtObject {',
      "  name: string = '';",
      '}',
      '',
    ].join('\n'),
  );
}

function createTenantScopedLocalSmrtObject(projectRoot: string): void {
  writeFileSync(
    join(projectRoot, 'src', 'TenantScopedThing.ts'),
    [
      "import { SmrtObject, smrt } from '@happyvertical/smrt-core';",
      '',
      '@smrt({ tenantScoped: true })',
      'export class TenantScopedThing extends SmrtObject {',
      "  name: string = '';",
      '}',
      '',
    ].join('\n'),
  );
}

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

  it('does not generate legacy src/manifest/test-manifest-stub.ts during closeBundle', async () => {
    mkdirSync(join(tmpDir, 'src', 'manifest'), { recursive: true });

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await (plugin as any).configResolved({
      root: tmpDir,
      build: {
        lib: { entry: 'src/index.ts' },
        outDir: 'dist',
      },
      plugins: [],
    });

    await (plugin as any).closeBundle();

    expect(existsSync(join(tmpDir, 'dist', 'manifest.json'))).toBe(true);
    expect(
      existsSync(join(tmpDir, 'src', 'manifest', 'test-manifest-stub.ts')),
    ).toBe(false);
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

  it('materializes tenantScoped fields in the Vite plugin manifest path', async () => {
    createTenantScopedLocalSmrtObject(tmpDir);

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [],
    });

    const manifestPath = join(tmpDir, '.smrt', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const tenantScopedThing = Object.values<any>(manifest.objects).find(
      (objectDef) => objectDef.className === 'TenantScopedThing',
    );

    expect(tenantScopedThing?.fields.tenantId).toEqual(
      expect.objectContaining({
        type: 'text',
        _meta: expect.objectContaining({
          sqlType: 'TEXT',
          __tenancy: expect.objectContaining({
            isTenantIdField: true,
            field: 'tenantId',
          }),
        }),
      }),
    );
    expect(tenantScopedThing?.schema?.columns.tenant_id).toEqual(
      expect.objectContaining({ type: 'TEXT' }),
    );
  });

  it('fails fast when a consumer app has external SMRT dependencies but no smrtConsumer plugin', async () => {
    createExternalSmrtPackage(tmpDir, '@fixture/messages');
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: {
          '@happyvertical/smrt-core': '*',
          '@fixture/messages': '1.0.0',
        },
      }),
    );

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await expect(
      (plugin as any).configResolved({
        root: tmpDir,
        build: {},
        plugins: [{ name: 'smrt-auto-service' }],
      }),
    ).rejects.toThrow(/missing smrtConsumer\(\)/);
  });

  it('allows consumer apps when smrtConsumer is registered in Vite', async () => {
    createExternalSmrtPackage(tmpDir, '@fixture/messages');
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: {
          '@happyvertical/smrt-core': '*',
          '@fixture/messages': '1.0.0',
        },
      }),
    );

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await expect(
      (plugin as any).configResolved({
        root: tmpDir,
        build: {},
        plugins: [{ name: 'smrt-auto-service' }, { name: 'smrt-consumer' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('does not enforce smrtConsumer during vitest startup', async () => {
    createExternalSmrtPackage(tmpDir, '@fixture/messages');
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: {
          '@happyvertical/smrt-core': '*',
          '@fixture/messages': '1.0.0',
        },
      }),
    );

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await expect(
      (plugin as any).configResolved({
        root: tmpDir,
        build: {},
        mode: 'test',
        plugins: [{ name: 'smrt-auto-service' }],
      }),
    ).resolves.toBeUndefined();
  });

  it('fails fast when a library build with SMRT objects enables minification', async () => {
    createLocalSmrtObject(tmpDir);

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await expect(
      (plugin as any).configResolved({
        root: tmpDir,
        build: {
          lib: { entry: 'src/index.ts' },
          outDir: 'dist',
          minify: 'esbuild',
        },
        plugins: [],
      }),
    ).rejects.toThrow(/build\.minify = false/);
  });

  it('allows library builds with SMRT objects when minification is disabled', async () => {
    createLocalSmrtObject(tmpDir);

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await expect(
      (plugin as any).configResolved({
        root: tmpDir,
        build: {
          lib: { entry: 'src/index.ts' },
          outDir: 'dist',
          minify: false,
        },
        plugins: [],
      }),
    ).resolves.toBeUndefined();
  });
});
