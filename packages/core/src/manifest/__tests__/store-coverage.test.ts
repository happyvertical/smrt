/**
 * Coverage-focused tests for manifest/store.ts (issue #1500).
 *
 * store.ts is the leaf module owning the globalThis manifest caches and the
 * pure fs/path helpers. The ManifestSource tests exercise it indirectly; this
 * file targets the store's own exported primitives and their branches:
 *
 * - lookupCachedManifestEntry: qualified key, simple name, lowercase, and the
 *   iterate-and-compare fallback; null/empty manifest guard
 * - cloneManifestSchemaColumns: default backfill + foreignKey deep copy
 * - createEmptyStaticManifest shape
 * - getCurrentPackageName via npm_package_name + cwd walk
 * - findWorkspaceRootSync (found / not-found)
 * - resolveInstalledPackageJsonPathSync / resolveWorkspacePackageJsonPathSync
 * - resolveManifestExportPathSync: valid, non-json, missing-file, no-export
 * - loadExternalManifestSyncWithNode: cache reuse, invalid structure
 * - loadManifestFromPathSyncWithNode: success, invalid, missing
 * - discoverCachedManifestSync across the cache priority chain
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../../scanner/types.js';
import {
  cloneManifestSchemaColumns,
  createEmptyStaticManifest,
  discoverCachedManifestSync,
  findWorkspaceRootSync,
  getCurrentPackageName,
  getManifestCache,
  loadExternalManifestSyncWithNode,
  loadManifestFromPathSyncWithNode,
  lookupCachedManifestEntry,
  resolveInstalledPackageJsonPathSync,
  resolveManifestExportPathSync,
  resolveWorkspacePackageJsonPathSync,
} from '../store.js';

type ManifestGlobals = typeof globalThis & {
  __smrtManifestCache?: Map<string, SmartObjectManifest>;
  __smrtManifestStatic?: SmartObjectManifest | null;
  __smrtManifestStaticLoadAttempted?: boolean;
  __smrtManifestTest?: SmartObjectManifest | null;
  __smrtManifestLocalTest?: SmartObjectManifest | null;
};

function manifest(
  packageName: string,
  objects: Record<string, any>,
): SmartObjectManifest {
  return { version: '1.0.0', timestamp: 0, packageName, objects } as any;
}

describe('manifest/store coverage', () => {
  let snapshot: {
    cache?: Map<string, SmartObjectManifest>;
    staticM?: SmartObjectManifest | null;
    staticAttempted?: boolean;
    test?: SmartObjectManifest | null;
    localTest?: SmartObjectManifest | null;
    npmPkg?: string;
  };

  beforeEach(() => {
    const g = globalThis as ManifestGlobals;
    snapshot = {
      cache: g.__smrtManifestCache ? new Map(g.__smrtManifestCache) : undefined,
      staticM: g.__smrtManifestStatic,
      staticAttempted: g.__smrtManifestStaticLoadAttempted,
      test: g.__smrtManifestTest,
      localTest: g.__smrtManifestLocalTest,
      npmPkg: process.env.npm_package_name,
    };
    g.__smrtManifestCache = new Map();
    g.__smrtManifestStatic = null;
    g.__smrtManifestStaticLoadAttempted = false;
    g.__smrtManifestTest = null;
    g.__smrtManifestLocalTest = null;
  });

  afterEach(() => {
    const g = globalThis as ManifestGlobals;
    g.__smrtManifestCache = snapshot.cache ?? new Map();
    g.__smrtManifestStatic = snapshot.staticM;
    g.__smrtManifestStaticLoadAttempted = snapshot.staticAttempted;
    g.__smrtManifestTest = snapshot.test;
    g.__smrtManifestLocalTest = snapshot.localTest;
    if (snapshot.npmPkg === undefined) {
      delete process.env.npm_package_name;
    } else {
      process.env.npm_package_name = snapshot.npmPkg;
    }
  });

  describe('lookupCachedManifestEntry', () => {
    const m = manifest('@acme/pkg', {
      '@acme/pkg:Widget': { className: 'Widget', fields: {} },
      gizmo: { className: 'Gizmo', fields: {} },
    });

    it('returns undefined for a null/empty manifest', () => {
      expect(lookupCachedManifestEntry(null, 'Widget')).toBeUndefined();
      expect(
        lookupCachedManifestEntry({ objects: undefined } as any, 'Widget'),
      ).toBeUndefined();
    });

    it('matches via the constructed qualified key', () => {
      expect(lookupCachedManifestEntry(m, 'Widget')?.className).toBe('Widget');
    });

    it('matches a lowercase object key directly', () => {
      expect(lookupCachedManifestEntry(m, 'gizmo')?.className).toBe('Gizmo');
    });

    it('matches by iterating className when no key matches', () => {
      // 'Gizmo' is not a literal key, but the value's className matches.
      expect(lookupCachedManifestEntry(m, 'Gizmo')?.className).toBe('Gizmo');
    });

    it('resolves an explicit qualified name input', () => {
      expect(lookupCachedManifestEntry(m, '@acme/pkg:Widget')?.className).toBe(
        'Widget',
      );
    });

    it('returns undefined when nothing matches', () => {
      expect(lookupCachedManifestEntry(m, 'Missing')).toBeUndefined();
    });
  });

  describe('cloneManifestSchemaColumns', () => {
    it('deep-copies columns, backfills defaultValue, and clones foreignKey', () => {
      const fk = { table: 'authors', column: 'id' };
      const cloned = cloneManifestSchemaColumns({
        id: { type: 'TEXT', primaryKey: true },
        status: { type: 'TEXT', default: 'draft' } as any,
        author_id: { type: 'TEXT', foreignKey: fk } as any,
      });

      // default -> defaultValue backfill.
      expect((cloned.status as any).defaultValue).toBe('draft');
      // foreignKey object is a distinct copy, not the same reference.
      expect((cloned.author_id as any).foreignKey).toEqual(fk);
      expect((cloned.author_id as any).foreignKey).not.toBe(fk);
    });

    it('handles an undefined column map', () => {
      expect(cloneManifestSchemaColumns(undefined)).toEqual({});
    });
  });

  describe('createEmptyStaticManifest', () => {
    it('produces an empty smrt-core manifest shell', () => {
      const empty = createEmptyStaticManifest();
      expect(empty.packageName).toBe('@happyvertical/smrt-core');
      expect(empty.objects).toEqual({});
      expect(empty.timestamp).toBeGreaterThan(0);
    });
  });

  describe('getCurrentPackageName', () => {
    it('returns npm_package_name when set', () => {
      process.env.npm_package_name = '@acme/explicit';
      expect(getCurrentPackageName()).toBe('@acme/explicit');
    });

    it('walks up to the nearest package.json when env is unset', () => {
      delete process.env.npm_package_name;
      const dir = mkdtempSync(join(tmpdir(), 'smrt-store-pkg-'));
      const nested = join(dir, 'a', 'b');
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@acme/walked' }),
      );
      const prev = process.cwd();
      process.chdir(nested);
      try {
        expect(getCurrentPackageName()).toBe('@acme/walked');
      } finally {
        process.chdir(prev);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('filesystem resolution helpers', () => {
    let dir: string;
    let prev: string;
    let strictPrev: string | undefined;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-store-fs-'));
      prev = process.cwd();
      // resolveManifestExportPathSync records registry diagnostics, which throw
      // under the default strict mode. Relax it so the not-found/not-json paths
      // exercise their `return null` branch instead of throwing.
      strictPrev = process.env.SMRT_STRICT_REGISTRY;
      process.env.SMRT_STRICT_REGISTRY = 'false';
    });
    afterEach(() => {
      process.chdir(prev);
      if (strictPrev === undefined) {
        delete process.env.SMRT_STRICT_REGISTRY;
      } else {
        process.env.SMRT_STRICT_REGISTRY = strictPrev;
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it('findWorkspaceRootSync locates a pnpm-workspace.yaml ancestor', () => {
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
      const nested = join(dir, 'packages', 'core');
      mkdirSync(nested, { recursive: true });
      expect(findWorkspaceRootSync(nested)).toBe(dir);
    });

    it('findWorkspaceRootSync returns null when no workspace marker exists', () => {
      // A freshly-created temp dir under tmpdir has no pnpm-workspace.yaml chain
      // up to the filesystem root.
      const isolated = mkdtempSync(join(tmpdir(), 'smrt-no-ws-'));
      try {
        expect(findWorkspaceRootSync(isolated)).toBeNull();
      } finally {
        rmSync(isolated, { recursive: true, force: true });
      }
    });

    it('resolveInstalledPackageJsonPathSync finds an installed package', () => {
      const pkgDir = join(dir, 'node_modules', '@acme', 'inst');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@acme/inst' }),
      );
      process.chdir(dir);
      // Use a suffix match: macOS resolves tmpdir() through a /private symlink,
      // so the absolute prefix differs from the raw mkdtemp path.
      expect(resolveInstalledPackageJsonPathSync('@acme/inst')).toMatch(
        /node_modules\/@acme\/inst\/package\.json$/,
      );
    });

    it('resolveWorkspacePackageJsonPathSync finds a workspace package by name', () => {
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
      const pkgDir = join(dir, 'packages', 'thing');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@acme/workspace-thing' }),
      );
      process.chdir(dir);
      expect(
        resolveWorkspacePackageJsonPathSync('@acme/workspace-thing'),
      ).toMatch(/packages\/thing\/package\.json$/);
    });

    it('resolveManifestExportPathSync resolves a declared JSON manifest export', () => {
      const pkgDir = join(dir, 'node_modules', '@acme', 'exp');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@acme/exp',
          exports: { './manifest.json': './dist/manifest.json' },
        }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 'manifest.json'),
        JSON.stringify(manifest('@acme/exp', {})),
      );
      process.chdir(dir);
      expect(resolveManifestExportPathSync('@acme/exp')).toMatch(
        /node_modules\/@acme\/exp\/dist\/manifest\.json$/,
      );
    });

    it('resolveManifestExportPathSync rejects a non-JSON manifest export', () => {
      const pkgDir = join(dir, 'node_modules', '@acme', 'notjson');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@acme/notjson',
          exports: { './manifest': './dist/manifest.js' },
        }),
      );
      process.chdir(dir);
      expect(
        resolveManifestExportPathSync('@acme/notjson', { warn: false }),
      ).toBeNull();
    });

    it('resolveManifestExportPathSync returns null when no package.json resolves', () => {
      process.chdir(dir);
      expect(
        resolveManifestExportPathSync('@acme/absent', { warn: false }),
      ).toBeNull();
    });
  });

  describe('loadExternalManifestSyncWithNode', () => {
    let dir: string;
    let prev: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-store-load-'));
      prev = process.cwd();
    });
    afterEach(() => {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns a cached manifest without touching disk', () => {
      const cached = manifest('@acme/cached2', {
        '@acme/cached2:Q': { className: 'Q', fields: {} },
      });
      getManifestCache().set('@acme/cached2', cached);
      expect(loadExternalManifestSyncWithNode('@acme/cached2')).toBe(cached);
    });

    it('returns null for a manifest with an invalid structure', () => {
      const pkgDir = join(dir, 'node_modules', '@acme', 'badstruct');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@acme/badstruct',
          exports: { './manifest.json': './dist/manifest.json' },
        }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 'manifest.json'),
        JSON.stringify({ version: '1.0.0' }), // missing objects
      );
      process.chdir(dir);
      expect(
        loadExternalManifestSyncWithNode('@acme/badstruct', { warn: false }),
      ).toBeNull();
    });

    it('enriches a manifest lacking packageName with the requested name', () => {
      const pkgDir = join(dir, 'node_modules', '@acme', 'noname');
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@acme/noname',
          exports: { './manifest.json': './dist/manifest.json' },
        }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 'manifest.json'),
        JSON.stringify({
          version: '1.0.0',
          timestamp: 0,
          objects: { X: { className: 'X', fields: {} } },
        }),
      );
      process.chdir(dir);
      const loaded = loadExternalManifestSyncWithNode('@acme/noname');
      expect(loaded?.packageName).toBe('@acme/noname');
    });
  });

  describe('loadManifestFromPathSyncWithNode', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-store-path-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('loads and caches a manifest from an explicit path', () => {
      const file = join(dir, 'manifest.json');
      writeFileSync(
        file,
        JSON.stringify(
          manifest('@acme/path2', { '@acme/path2:W': { className: 'W' } }),
        ),
      );
      const loaded = loadManifestFromPathSyncWithNode(file);
      expect(loaded?.objects['@acme/path2:W'].className).toBe('W');
      expect(getManifestCache().get('@acme/path2')).toBe(loaded);
    });

    it('returns null for an invalid manifest structure', () => {
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify({ version: '1.0.0' }));
      expect(loadManifestFromPathSyncWithNode(file)).toBeNull();
    });

    it('returns null when the file does not exist', () => {
      expect(
        loadManifestFromPathSyncWithNode(join(dir, 'missing.json')),
      ).toBeNull();
    });
  });

  describe('discoverCachedManifestSync', () => {
    it('finds an entry from the embedded cache via the priority chain', () => {
      getManifestCache().set(
        '@acme/disc',
        manifest('@acme/disc', {
          '@acme/disc:Found': { className: 'Found', fields: {} },
        }),
      );
      expect(discoverCachedManifestSync('Found')?.className).toBe('Found');
    });

    it('finds an entry from the local-test cache before the embedded cache', () => {
      (globalThis as ManifestGlobals).__smrtManifestLocalTest = manifest(
        '@local/test',
        { '@local/test:LocalFound': { className: 'LocalFound', fields: {} } },
      );
      expect(discoverCachedManifestSync('LocalFound')?.className).toBe(
        'LocalFound',
      );
    });

    it('returns undefined when no cache holds the class', () => {
      expect(discoverCachedManifestSync('NeverEverThere')).toBeUndefined();
    });
  });
});
