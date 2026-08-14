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
import { resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from '../generation-snapshot.js';
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

  it('reuses a verified manifest without scanning or rewriting it (#2328)', async () => {
    const provenance = 'git-tree:fixture';
    const artifactPath = join(tmpDir, 'prebuilt-manifest.json');
    const contents = serializeSmrtGenerationSnapshot(
      {
        version: '1.0.0',
        timestamp: 0,
        packageName: 'test-app',
        objects: {
          'test-app:PrebuiltThing': {
            className: 'PrebuiltThing',
            qualifiedName: 'test-app:PrebuiltThing',
            collection: 'prebuilt_things',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      },
      provenance,
      { sourceRoot: tmpDir },
    );
    writeFileSync(artifactPath, contents);

    const plugin: any = smrtPlugin({
      include: ['missing/**/*.ts'],
      generateTypes: true,
      generationSnapshot: {
        path: artifactPath,
        sha256: sha256SmrtGenerationSnapshot(contents),
        provenance,
        sourceRoot: tmpDir,
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await plugin.configResolved({
        root: tmpDir,
        build: {},
        plugins: [],
      });
      plugin.configureServer({
        config: { root: tmpDir },
        middlewares: { use: vi.fn() },
        moduleGraph: { getModuleById: vi.fn() },
        reloadModule: vi.fn(),
        watcher: { on: vi.fn() },
      });
      await plugin.buildStart();
      await plugin.buildStart();

      const load =
        typeof plugin.load === 'function' ? plugin.load : plugin.load.handler;
      expect(await load.call(plugin, '\0smrt:manifest')).toContain(
        'PrebuiltThing',
      );
      expect(await load.call(plugin, '\0smrt:routes')).toContain(
        'prebuilt_things',
      );
      expect(await load.call(plugin, '\0smrt:types')).toContain(
        'PrebuiltThing',
      );
      expect(
        readFileSync(join(tmpDir, 'src/types/virtual-modules.d.ts'), 'utf8'),
      ).toContain('PrebuiltThingData');
      expect(existsSync(join(tmpDir, '.smrt', 'manifest.json'))).toBe(false);
      expect(readFileSync(artifactPath, 'utf8')).toBe(contents);
      expect(
        logSpy.mock.calls.some(([message]) =>
          String(message).includes('OXC scan completed'),
        ),
      ).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uses an explicit project root instead of Vite's invoking root (#2199)", async () => {
    const invokingRoot = join(tmpDir, 'foreign-vite-root');
    mkdirSync(invokingRoot, { recursive: true });

    const plugin = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await (plugin as any).configResolved({
      root: invokingRoot,
      build: {},
      plugins: [],
    });

    expect(existsSync(join(tmpDir, '.smrt', 'manifest.json'))).toBe(true);
    expect(existsSync(join(invokingRoot, '.smrt', 'manifest.json'))).toBe(
      false,
    );
  });

  it('generates SvelteKit routes from the explicit project root (#2199)', async () => {
    const invokingRoot = join(tmpDir, 'foreign-vite-root');
    mkdirSync(invokingRoot, { recursive: true });
    createLocalSmrtObject(tmpDir);
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: true } } }),
    );
    writeFileSync(
      join(invokingRoot, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: false } } }),
    );

    const plugin = smrtPlugin({
      projectRoot: tmpDir,
      include: ['src/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api/v1',
        objectsDir: 'src',
      },
    });

    await (plugin as any).configResolved({
      root: invokingRoot,
      build: {},
      plugins: [],
    });

    const generatedRoute = 'src/routes/api/v1/localthings/+server.ts';
    const knowledgeRoute = 'src/routes/__smrt/knowledge/+server.ts';
    expect(existsSync(join(tmpDir, generatedRoute))).toBe(true);
    expect(existsSync(join(tmpDir, knowledgeRoute))).toBe(true);
    expect(readFileSync(join(tmpDir, '.gitignore'), 'utf-8')).toContain(
      generatedRoute,
    );
    expect(existsSync(join(invokingRoot, generatedRoute))).toBe(false);
    expect(existsSync(join(invokingRoot, '.gitignore'))).toBe(false);
  });

  it('generates routes before SvelteKit inventories a clean checkout (#2313)', async () => {
    createLocalSmrtObject(tmpDir);
    const generatedRoute = join(
      tmpDir,
      'src/routes/api/localthings/+server.ts',
    );
    let routeExistedDuringConfig = false;

    await resolveConfig(
      {
        root: tmpDir,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          {
            name: 'sveltekit-route-inventory-fixture',
            config: {
              order: 'pre',
              handler() {
                routeExistedDuringConfig = existsSync(generatedRoute);
              },
            },
          },
          smrtPlugin({
            include: ['src/**/*.ts'],
            generateTypes: false,
            svelteKit: {
              enabled: true,
              routesDir: 'src/routes/api',
              objectsDir: 'src',
            },
          }),
        ],
      },
      'build',
    );

    expect(routeExistedDuringConfig).toBe(true);
    expect(existsSync(generatedRoute)).toBe(true);
  });

  it('writes domain knowledge when config omits this package override', async () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.json'),
      JSON.stringify({
        knowledge: { tags: ['project-default'] },
        packages: {
          '@fixture/other': {
            knowledge: { tags: ['other-package'] },
          },
        },
      }),
    );

    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });

    await (plugin as any).configResolved({
      root: tmpDir,
      build: {},
      plugins: [],
    });

    const knowledgePath = join(tmpDir, '.smrt', 'smrt-knowledge.json');
    expect(existsSync(knowledgePath)).toBe(true);

    const knowledge = JSON.parse(readFileSync(knowledgePath, 'utf-8'));
    expect(knowledge.tags).toEqual(['project-default']);
  });

  it('reuses the initial scan and rescans subsequent watch builds', async () => {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      // configResolved seeds the manifest used by the first buildStart hook.
      await (plugin as any).configResolved({
        root: tmpDir,
        build: {},
        plugins: [],
      });
      await (plugin as any).buildStart();

      const scanCount = () =>
        logSpy.mock.calls.filter(([message]) =>
          String(message).includes('[smrt] OXC scan completed'),
        ).length;
      expect(scanCount()).toBe(1);

      // A later buildStart represents a watch rebuild and must rescan changes.
      createLocalSmrtObject(tmpDir);
      await (plugin as any).buildStart();
      expect(scanCount()).toBe(2);

      const manifestPath = join(tmpDir, '.smrt', 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(
        Object.values<any>(manifest.objects).some(
          (objectDef) => objectDef.className === 'LocalThing',
        ),
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
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
          sqlType: 'UUID',
          __tenancy: expect.objectContaining({
            isTenantIdField: true,
            field: 'tenantId',
          }),
        }),
      }),
    );
    expect(tenantScopedThing?.schema?.columns.tenant_id).toEqual(
      expect.objectContaining({ type: 'UUID', referenceKind: 'tenantId' }),
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
