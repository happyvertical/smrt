/**
 * Discovery of a workspace dependency that is linked before its first build.
 *
 * A workspace app has no lockfile of its own, and a declared dependency with no
 * manifest contributes nothing to the discovery answer. The cached answer must
 * still notice when that dependency is built, in the same process and in a new
 * one, and must follow the workspace lockfile.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type DiscoverSmrtPackages =
  typeof import('../discover-smrt-packages.js').discoverSmrtPackages;

type DiscoverSmrtPackageLocations =
  typeof import('../discover-smrt-packages.js').discoverSmrtPackageLocations;

let discoverSmrtPackages: DiscoverSmrtPackages;
let discoverSmrtPackageLocations: DiscoverSmrtPackageLocations;

/**
 * A fresh copy of the module: what a new process sees, with no in-process
 * answer and only the cache file on disk.
 */
async function startNewProcess(): Promise<void> {
  vi.resetModules();
  ({ discoverSmrtPackages, discoverSmrtPackageLocations } = await import(
    '../discover-smrt-packages.js'
  ));
}

const LATE = '@happyvertical/smrt-late-fixture';
const READY = '@happyvertical/smrt-ready-fixture';

let workspace: string;
let app: string;
let latePackage: string;

function writePackage(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest.json': './dist/manifest.json',
      },
    }),
  );
}

function buildPackage(dir: string, name: string): void {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(
    join(dir, 'dist', 'manifest.json'),
    JSON.stringify({
      moduleType: 'smrt',
      version: '1.0.0',
      packageName: name,
      objects: {},
    }),
  );
}

function cacheFile(): { lockfileHash: string | null } {
  return JSON.parse(
    readFileSync(join(app, '.smrt', 'discovery-cache.json'), 'utf-8'),
  );
}

beforeEach(async () => {
  await startNewProcess();
  workspace = mkdtempSync(join(tmpdir(), 'smrt-discovery-unbuilt-'));
  writeFileSync(join(workspace, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(workspace, 'pnpm-workspace.yaml'),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
  );

  latePackage = join(workspace, 'packages', 'late');
  writePackage(latePackage, LATE);
  const readyPackage = join(workspace, 'packages', 'ready');
  writePackage(readyPackage, READY);
  buildPackage(readyPackage, READY);

  app = join(workspace, 'apps', 'web');
  const scope = join(app, 'node_modules', '@happyvertical');
  mkdirSync(scope, { recursive: true });
  symlinkSync(latePackage, join(scope, 'smrt-late-fixture'));
  symlinkSync(readyPackage, join(scope, 'smrt-ready-fixture'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({
      name: '@fixture/web',
      type: 'module',
      dependencies: { [LATE]: 'workspace:*', [READY]: 'workspace:*' },
    }),
  );
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('discovery of a dependency built after first discovery', () => {
  it('finds the dependency once it is built, in the same process', () => {
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);

    buildPackage(latePackage, LATE);

    expect(discoverSmrtPackages({ baseDir: app }).sort()).toEqual([
      LATE,
      READY,
    ]);
  });

  it('finds the dependency once it is built, in a new process reading the cache file', async () => {
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);

    buildPackage(latePackage, LATE);
    // A new process starts with no in-process answer, only the cache file.
    await startNewProcess();

    expect(discoverSmrtPackages({ baseDir: app }).sort()).toEqual([
      LATE,
      READY,
    ]);
  });

  it('keeps answering from the cache while nothing changes', async () => {
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);
    const first = readFileSync(
      join(app, '.smrt', 'discovery-cache.json'),
      'utf-8',
    );

    await startNewProcess();
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);

    // A valid cache is reused, not rewritten.
    expect(
      readFileSync(join(app, '.smrt', 'discovery-cache.json'), 'utf-8'),
    ).toBe(first);
  });

  it('keys the cache on the workspace lockfile above the app', () => {
    discoverSmrtPackages({ baseDir: app });
    const before = cacheFile().lockfileHash;
    expect(before).toEqual(expect.any(String));

    writeFileSync(
      join(workspace, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n# changed\n",
    );
    discoverSmrtPackages({ baseDir: app });

    expect(cacheFile().lockfileHash).not.toBe(before);
  });
});

describe('discovery re-probes rebuilds that look unchanged by size and mtime', () => {
  function manifestBody(moduleType: string): string {
    return JSON.stringify({
      moduleType,
      version: '1.0.0',
      packageName: LATE,
      objects: {},
    });
  }

  it.each([
    ['in the same process', false],
    ['in a new process reading the cache file', true],
  ])('finds a manifest rewritten in place with the same size and restored mtime, %s', async (_label, restart) => {
    // A candidate that exists but is not a SMRT manifest: not selected.
    mkdirSync(join(latePackage, 'dist'), { recursive: true });
    const manifest = join(latePackage, 'dist', 'manifest.json');
    writeFileSync(manifest, manifestBody('xxxx'));
    // A whole-second mtime, so restoring it later is exact.
    const stamp = Math.floor(Date.now() / 1000) - 60;
    utimesSync(manifest, stamp, stamp);
    expect(discoverSmrtPackages({ baseDir: app })).toEqual([READY]);

    const before = statSync(manifest);
    writeFileSync(manifest, manifestBody('smrt'));
    utimesSync(manifest, stamp, stamp);
    expect(statSync(manifest).size).toBe(before.size);
    expect(statSync(manifest).mtimeMs).toBe(before.mtimeMs);
    if (restart) await startNewProcess();

    expect(discoverSmrtPackages({ baseDir: app }).sort()).toEqual([
      LATE,
      READY,
    ]);
  });
});

describe('discovery with two installs of one transitive dependency', () => {
  const DUP = '@happyvertical/smrt-dup-fixture';
  let secondCopy: string;

  beforeEach(() => {
    // Two consumed packages, each with its own unbuilt copy of DUP.
    for (const [name, dir] of [
      ['@happyvertical/smrt-left-fixture', 'left'],
      ['@happyvertical/smrt-right-fixture', 'right'],
    ] as const) {
      const pkg = join(workspace, 'packages', dir);
      writePackage(pkg, name);
      buildPackage(pkg, name);
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({
          name,
          type: 'module',
          exports: {
            '.': './dist/index.js',
            './manifest.json': './dist/manifest.json',
          },
          dependencies: { [DUP]: '1.0.0' },
        }),
      );
      const copy = join(
        pkg,
        'node_modules',
        '@happyvertical',
        'smrt-dup-fixture',
      );
      writePackage(copy, DUP);
      if (dir === 'right') secondCopy = copy;
      symlinkSync(
        pkg,
        join(app, 'node_modules', '@happyvertical', name.split('/')[1]),
      );
    }
    writeFileSync(
      join(app, 'package.json'),
      JSON.stringify({
        name: '@fixture/web',
        type: 'module',
        dependencies: {
          [READY]: 'workspace:*',
          '@happyvertical/smrt-left-fixture': 'workspace:*',
          '@happyvertical/smrt-right-fixture': 'workspace:*',
        },
      }),
    );
  });

  it.each([
    ['in the same process', false],
    ['in a new process reading the cache file', true],
  ])('finds the copy that is built second, %s', async (_label, restart) => {
    expect(
      Object.keys(discoverSmrtPackageLocations({ baseDir: app })),
    ).not.toContain(DUP);

    buildPackage(secondCopy, DUP);
    if (restart) await startNewProcess();

    const locations = discoverSmrtPackageLocations({ baseDir: app });
    expect(locations[DUP]?.via).toBe('@happyvertical/smrt-right-fixture');
  });
});
