/**
 * Coverage-focused tests for discover-smrt-packages.ts (issue #1500).
 *
 * The existing discover-smrt-packages.test.ts covers outermost-root resolution
 * and two cache-invalidation scenarios. This file targets the remaining
 * branches of the discovery pipeline:
 *
 * - Cache write-then-reuse on a second call (the cache hit path)
 * - noCache option forcing fresh discovery (skips the cache entirely)
 * - Cache version mismatch invalidation
 * - Timing data capture via getDiscoveryTiming
 * - moduleType !== 'smrt' manifests being rejected
 * - node_modules scanning that picks up an undeclared but manifest-bearing pkg
 * - Empty result when node_modules is absent
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverSmrtPackages,
  getDiscoveryTiming,
} from '../discover-smrt-packages.js';

const SMRT_PKG = '@happyvertical/smrt-example';

function writeSmrtPackage(
  baseDir: string,
  packageName: string,
  opts: { moduleType?: string } = {},
): void {
  const pkgDir = join(
    baseDir,
    'node_modules',
    ...packageName
      .replace('@', '')
      .split('/')
      .map((p, i) => (i === 0 ? `@${p}` : p)),
  );
  mkdirSync(join(pkgDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({
      name: packageName,
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest.json': './dist/manifest.json',
      },
    }),
  );
  writeFileSync(join(pkgDir, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(
    join(pkgDir, 'dist', 'manifest.json'),
    JSON.stringify({
      moduleType: opts.moduleType ?? 'smrt',
      version: '1.0.0',
      packageName,
      objects: {},
    }),
  );
}

describe('discoverSmrtPackages coverage', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-discover-cov-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a discovery cache then reuses it on the next call', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    // First call performs discovery and saves the cache.
    const first = discoverSmrtPackages({ baseDir: dir });
    expect(first).toContain(SMRT_PKG);

    // Second call should hit the cache (no inputs changed). The result is
    // identical; the cache-hit branch is exercised.
    const second = discoverSmrtPackages({ baseDir: dir });
    expect(second).toEqual(first);
  });

  it('performs fresh discovery and skips the cache when noCache is set', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    const packages = discoverSmrtPackages({ baseDir: dir, noCache: true });
    expect(packages).toContain(SMRT_PKG);
  });

  it('captures timing data when the timing option is enabled', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', type: 'module' }),
    );

    discoverSmrtPackages({ baseDir: dir, noCache: true, timing: true });
    const timing = getDiscoveryTiming();
    expect(timing.total).toBeTypeOf('number');
    expect(timing.discovery).toBeTypeOf('number');
  });

  it('captures cache-check timing on a cached run', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    // Prime the cache.
    discoverSmrtPackages({ baseDir: dir });
    // Cached run with timing -> cacheCheck + total recorded.
    discoverSmrtPackages({ baseDir: dir, timing: true });
    const timing = getDiscoveryTiming();
    expect(timing.cacheCheck).toBeTypeOf('number');
    expect(timing.total).toBeTypeOf('number');
  });

  it('rejects manifests whose moduleType is not "smrt"', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    // moduleType: 'other' -> not a SMRT package, must be excluded.
    writeSmrtPackage(dir, SMRT_PKG, { moduleType: 'other' });

    const packages = discoverSmrtPackages({ baseDir: dir, noCache: true });
    expect(packages).not.toContain(SMRT_PKG);
  });

  it('discovers an undeclared package found by scanning node_modules', () => {
    // No dependency entry in package.json — discovery must still find it via
    // the node_modules scan (scanNodeModules + hasManifestExport).
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', type: 'module' }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    const packages = discoverSmrtPackages({ baseDir: dir, noCache: true });
    expect(packages).toContain(SMRT_PKG);
  });

  it('returns an empty list when node_modules and dependencies are absent', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', type: 'module' }),
    );
    expect(discoverSmrtPackages({ baseDir: dir, noCache: true })).toEqual([]);
  });

  it('invalidates the cache when the cache version is stale', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        dependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    // Prime the cache, then corrupt its version field.
    discoverSmrtPackages({ baseDir: dir });
    const cachePath = join(dir, '.smrt', 'discovery-cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 0, // stale version -> cache must be rejected
        lockfileHash: null,
        packageJsonHash: null,
        manifestsHash: '',
        timestamp: Date.now(),
        packages: [],
      }),
    );

    // With a stale cache version, discovery re-runs and still finds the package.
    const packages = discoverSmrtPackages({ baseDir: dir });
    expect(packages).toContain(SMRT_PKG);
  });

  it('honors the verbose option without throwing', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'consumer', type: 'module' }),
    );
    // verbose:true drives the console.log branches; just assert it completes.
    expect(() =>
      discoverSmrtPackages({ baseDir: dir, noCache: true, verbose: true }),
    ).not.toThrow();
  });

  it('logs declared SMRT packages under verbose discovery', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'consumer',
        type: 'module',
        // devDependencies path of the declared-dependency merge.
        devDependencies: { [SMRT_PKG]: '1.0.0' },
      }),
    );
    writeSmrtPackage(dir, SMRT_PKG);

    const packages = discoverSmrtPackages({
      baseDir: dir,
      noCache: true,
      verbose: true,
    });
    expect(packages).toContain(SMRT_PKG);
  });

  it('tolerates a malformed package.json while reading declared dependencies', () => {
    // Discovery still runs via node_modules scanning; the declared-dependency
    // read hits its catch branch on the malformed JSON without throwing.
    writeFileSync(join(dir, 'package.json'), '{ broken json');
    writeSmrtPackage(dir, SMRT_PKG);

    const packages = discoverSmrtPackages({
      baseDir: dir,
      noCache: true,
      verbose: true,
    });
    // The package is still found through the node_modules scan.
    expect(packages).toContain(SMRT_PKG);
  });
});
