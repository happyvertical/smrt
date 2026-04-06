import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSmrtPackages } from '../discover-smrt-packages.js';

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
});
