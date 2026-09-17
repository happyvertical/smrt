import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverSmrtPackages,
  resolveManifestPath,
} from '../discover-smrt-packages.js';

describe('discoverSmrtPackages', () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = null;
    }
  });

  it('should prefer the outermost package root when dist/package.json exists', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-'));
    const originalCwd = process.cwd();
    const packageName = '@happyvertical/smrt-example';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-example',
    );
    const distDir = join(packageDir, 'dist');

    mkdirSync(distDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
          type: 'module',
          dependencies: {
            [packageName]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          type: 'module',
          main: './dist/index.js',
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(distDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          type: 'module',
          main: './index.js',
        },
        null,
        2,
      ),
    );

    writeFileSync(join(distDir, 'index.js'), 'export {};\n');
    writeFileSync(
      join(distDir, 'manifest.json'),
      JSON.stringify(
        {
          moduleType: 'smrt',
          version: '1.0.0',
          objects: {},
        },
        null,
        2,
      ),
    );

    process.chdir(testDir);

    try {
      const packages = discoverSmrtPackages({ noCache: true });
      expect(packages).toContain(packageName);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('invalidates cached manifest hashes relative to the provided baseDir', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-cache-'));
    const packageName = '@happyvertical/smrt-example';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-example',
    );
    const manifestPath = join(packageDir, 'dist', 'manifest.json');
    const cachePath = join(testDir, '.smrt', 'discovery-cache.json');

    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
          type: 'module',
          dependencies: {
            [packageName]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          type: 'module',
          exports: {
            '.': './dist/index.js',
            './manifest': './dist/manifest.json',
            './manifest.json': './dist/manifest.json',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          moduleType: 'smrt',
          version: '1.0.0',
          packageName,
          objects: {
            [`${packageName}:FixtureExternal`]: {
              className: 'FixtureExternal',
              qualifiedName: `${packageName}:FixtureExternal`,
              packageName,
              collection: 'fixture_externals',
              fields: {},
            },
          },
        },
        null,
        2,
      ),
    );

    const firstPackages = discoverSmrtPackages({ baseDir: testDir });
    expect(firstPackages).toContain(packageName);

    const firstCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const nextTimestamp = new Date(Date.now() + 5_000);
    utimesSync(manifestPath, nextTimestamp, nextTimestamp);

    const secondPackages = discoverSmrtPackages({ baseDir: testDir });
    expect(secondPackages).toContain(packageName);

    const secondCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(secondCache.manifestsHash).not.toBe(firstCache.manifestsHash);
  });

  it('invalidates cached discovery when package.json dependencies change without a lockfile', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-package-json-'));
    const packageA = '@happyvertical/smrt-one';
    const packageB = '@happyvertical/smrt-two';

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
          type: 'module',
          dependencies: {
            [packageA]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );

    for (const packageName of [packageA]) {
      const packageDir = join(
        testDir,
        'node_modules',
        '@happyvertical',
        packageName.replace('@happyvertical/', ''),
      );
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify(
          {
            name: packageName,
            type: 'module',
            exports: {
              '.': {
                import: './dist/index.js',
              },
              './manifest': './dist/manifest.json',
              './manifest.json': './dist/manifest.json',
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
      writeFileSync(
        join(packageDir, 'dist', 'manifest.json'),
        JSON.stringify(
          {
            moduleType: 'smrt',
            version: '1.0.0',
            packageName,
            objects: {},
          },
          null,
          2,
        ),
      );
    }

    const firstPackages = discoverSmrtPackages({ baseDir: testDir });
    expect(firstPackages).toEqual([packageA]);

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
          type: 'module',
          dependencies: {
            [packageA]: '1.0.0',
            [packageB]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );

    {
      const packageDir = join(
        testDir,
        'node_modules',
        '@happyvertical',
        packageB.replace('@happyvertical/', ''),
      );
      mkdirSync(join(packageDir, 'dist'), { recursive: true });
      writeFileSync(
        join(packageDir, 'package.json'),
        JSON.stringify(
          {
            name: packageB,
            type: 'module',
            exports: {
              '.': {
                import: './dist/index.js',
              },
              './manifest': './dist/manifest.json',
              './manifest.json': './dist/manifest.json',
            },
          },
          null,
          2,
        ),
      );
      writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
      writeFileSync(
        join(packageDir, 'dist', 'manifest.json'),
        JSON.stringify(
          {
            moduleType: 'smrt',
            version: '1.0.0',
            packageName: packageB,
            objects: {},
          },
          null,
          2,
        ),
      );
    }

    const secondPackages = discoverSmrtPackages({ baseDir: testDir });
    expect(secondPackages).toContain(packageA);
    expect(secondPackages).toContain(packageB);
  });
  /**
   * Issue #2923 drive-by: build-time discovery shares the consumer plugin's
   * defect — it probed only conventional manifest paths, so a package whose
   * export map points elsewhere (`@happyvertical/smrt-products` builds its
   * library into `dist/lib`) was not discovered as a SMRT package at all.
   */
  it('discovers a package whose manifest export points outside the conventional paths', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-exports-'));
    const packageName = '@happyvertical/smrt-exported';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-exported',
    );

    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
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
        {
          name: packageName,
          type: 'module',
          main: 'dist/lib/index.js',
          exports: {
            '.': './dist/lib/index.js',
            './manifest': './dist/lib/manifest.json',
            './manifest.json': './dist/lib/manifest.json',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(packageDir, 'dist', 'lib', 'index.js'), 'export {};\n');
    writeFileSync(
      join(packageDir, 'dist', 'lib', 'manifest.json'),
      JSON.stringify(
        {
          moduleType: 'smrt',
          version: '1.0.0',
          packageName,
          objects: {},
        },
        null,
        2,
      ),
    );

    expect(discoverSmrtPackages({ baseDir: testDir, noCache: true })).toContain(
      packageName,
    );
  });
  /**
   * PR #2927 review: the export-aware probe can be hidden by a cache written
   * before it existed. A cached EMPTY package list skips manifest rehashing
   * in `getCachedDiscovery()`, so only the cache version can invalidate it.
   */
  it('invalidates a pre-export-resolution discovery cache', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-cache-version-'));
    const packageName = '@happyvertical/smrt-cached-exported';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-cached-exported',
    );
    const cachePath = join(testDir, '.smrt', 'discovery-cache.json');

    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
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
        {
          name: packageName,
          type: 'module',
          main: 'dist/lib/index.js',
          exports: {
            '.': './dist/lib/index.js',
            './manifest': './dist/lib/manifest.json',
            './manifest.json': './dist/lib/manifest.json',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(packageDir, 'dist', 'lib', 'index.js'), 'export {};\n');

    // Nothing to discover yet, so this writes a cache with an empty list.
    expect(discoverSmrtPackages({ baseDir: testDir })).toEqual([]);

    // Age that cache to the version in use before export resolution existed.
    const staleCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    expect(staleCache.packages).toEqual([]);
    writeFileSync(
      cachePath,
      JSON.stringify({ ...staleCache, version: 4 }, null, 2),
    );

    // The manifest only ever exists at the exported, non-conventional path.
    writeFileSync(
      join(packageDir, 'dist', 'lib', 'manifest.json'),
      JSON.stringify(
        { moduleType: 'smrt', version: '1.0.0', packageName, objects: {} },
        null,
        2,
      ),
    );

    expect(discoverSmrtPackages({ baseDir: testDir })).toContain(packageName);
  });
  /**
   * PR #2927 final review: an export target that EXISTS is not necessarily a
   * manifest. `./manifest` is commonly a JS module (core maps it to
   * `dist/manifest.js`) and `./static-manifest` always is, so stopping at the
   * first existing candidate would drop a package that ships a perfectly good
   * `dist/manifest.json` — reintroducing the #2923 silent skip on the
   * build-time path.
   */
  it('skips exported candidates that are not manifests and keeps the conventional one', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-nonjson-export-'));
    const packageName = '@happyvertical/smrt-js-manifest-export';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-js-manifest-export',
    );

    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
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
        {
          name: packageName,
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': './dist/index.js',
            // The JS shape @happyvertical/smrt-core itself publishes, without
            // a './manifest.json' alias to rescue it.
            './manifest': {
              types: './dist/manifest.d.ts',
              import: './dist/manifest.js',
              default: './dist/manifest.js',
            },
            './static-manifest': './dist/static-manifest.js',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(
      join(packageDir, 'dist', 'manifest.js'),
      'export const manifest = {};\n',
    );
    writeFileSync(
      join(packageDir, 'dist', 'static-manifest.js'),
      'export const staticManifest = {};\n',
    );
    // The only real manifest is at the conventional path.
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify(
        { moduleType: 'smrt', version: '1.0.0', packageName, objects: {} },
        null,
        2,
      ),
    );

    // The package root is normalized through realpath, so compare against the
    // same real path rather than the temp-dir alias (macOS /var -> /private/var).
    expect(resolveManifestPath(packageName, testDir)).toBe(
      join(realpathSync(packageDir), 'dist', 'manifest.json'),
    );
    expect(discoverSmrtPackages({ baseDir: testDir, noCache: true })).toContain(
      packageName,
    );
  });

  it('skips a stale or malformed exported manifest for the conventional one', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-stale-export-'));
    const packageName = '@happyvertical/smrt-stale-export';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-stale-export',
    );

    mkdirSync(join(packageDir, 'dist', 'lib'), { recursive: true });
    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
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
        {
          name: packageName,
          type: 'module',
          main: './dist/index.js',
          exports: {
            '.': './dist/index.js',
            './manifest': './dist/lib/manifest.json',
            './manifest.json': './dist/lib/manifest.json',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(packageDir, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(join(packageDir, 'dist', 'lib', 'manifest.json'), '{ nope');
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify(
        { moduleType: 'smrt', version: '1.0.0', packageName, objects: {} },
        null,
        2,
      ),
    );

    expect(discoverSmrtPackages({ baseDir: testDir, noCache: true })).toContain(
      packageName,
    );
  });
});
