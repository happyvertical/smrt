/**
 * Unit tests for the Release B ManifestSource implementations.
 *
 * Each source gets its own describe block. CompositeManifestSource tests at
 * the bottom verify priority order, de-duplication in `entries()`, and the
 * hydrate fall-through chain.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { SmartObjectManifest } from '../../../scanner/types.js';
import { getManifestCache, shouldLoadCoreTestManifest } from '../../store.js';
import { CompositeManifestSource } from '../composite.js';
import { EmbeddedManifestSource } from '../embedded.js';
import { ExplicitPathsManifestSource } from '../explicit-paths.js';
import { NodeModulesFallbackSource } from '../fallback.js';
import { LocalTestManifestSource } from '../local-test.js';
import { StaticManifestSource } from '../static.js';
import { TestManifestSource } from '../test.js';
import type { ManifestEntry, ManifestSource } from '../types.js';

type ManifestGlobals = typeof globalThis & {
  __smrtManifestCache?: Map<string, SmartObjectManifest>;
  __smrtManifestStatic?: SmartObjectManifest | null;
  __smrtManifestStaticLoadAttempted?: boolean;
  __smrtManifestTest?: SmartObjectManifest | null;
  __smrtManifestLocalTest?: SmartObjectManifest | null;
};

function manifest(
  packageName: string,
  objects: Record<string, { fields?: Record<string, { type: string }> }>,
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects: Object.fromEntries(
      Object.entries(objects).map(([className, def]) => [
        `${packageName}:${className}`,
        {
          className,
          packageName,
          fields: def.fields ?? {},
        } as any,
      ]),
    ) as any,
  };
}

function snapshotCaches() {
  const globals = globalThis as ManifestGlobals;
  return {
    cache: globals.__smrtManifestCache
      ? new Map(globals.__smrtManifestCache)
      : undefined,
    staticM: globals.__smrtManifestStatic,
    staticAttempted: globals.__smrtManifestStaticLoadAttempted,
    test: globals.__smrtManifestTest,
    localTest: globals.__smrtManifestLocalTest,
  };
}

function restoreCaches(snapshot: ReturnType<typeof snapshotCaches>) {
  const globals = globalThis as ManifestGlobals;
  globals.__smrtManifestCache = snapshot.cache ?? new Map();
  globals.__smrtManifestStatic = snapshot.staticM;
  globals.__smrtManifestStaticLoadAttempted = snapshot.staticAttempted;
  globals.__smrtManifestTest = snapshot.test;
  globals.__smrtManifestLocalTest = snapshot.localTest;
}

describe('ManifestSource implementations', () => {
  let originalSnapshot: ReturnType<typeof snapshotCaches>;
  const originalPackageName = process.env.npm_package_name;
  const originalCwd = process.cwd();

  beforeAll(() => {
    originalSnapshot = snapshotCaches();
  });

  beforeEach(() => {
    const globals = globalThis as ManifestGlobals;
    globals.__smrtManifestCache = new Map();
    globals.__smrtManifestStatic = null;
    globals.__smrtManifestStaticLoadAttempted = false;
    globals.__smrtManifestTest = null;
    globals.__smrtManifestLocalTest = null;
  });

  afterAll(() => {
    if (originalPackageName) {
      process.env.npm_package_name = originalPackageName;
    } else {
      delete process.env.npm_package_name;
    }
    process.chdir(originalCwd);
    restoreCaches(originalSnapshot);
  });

  describe('LocalTestManifestSource', () => {
    it('returns undefined when the cache is empty', () => {
      const source = new LocalTestManifestSource();
      expect(source.lookup({ className: 'Any' })).toBeUndefined();
      expect([...source.entries()]).toEqual([]);
    });

    it('hits qualified-name queries before simple ones', () => {
      (globalThis as ManifestGlobals).__smrtManifestLocalTest = manifest(
        '@acme/pkg',
        { Widget: { fields: { size: { type: 'text' } } } },
      );
      const source = new LocalTestManifestSource();

      const hit = source.lookup({
        className: 'Widget',
        qualifiedName: '@acme/pkg:Widget',
      });
      expect(hit?.def.className).toBe('Widget');
      expect(hit?.source).toBe('local-test');
      expect(hit?.packageName).toBe('@acme/pkg');
    });

    it('iterates entries for parity snapshots', () => {
      (globalThis as ManifestGlobals).__smrtManifestLocalTest = manifest(
        '@acme/pkg',
        { Widget: {}, Gizmo: {} },
      );
      const source = new LocalTestManifestSource();
      const names = [...source.entries()].map((e) => e.className).sort();
      expect(names).toEqual(['Gizmo', 'Widget']);
    });
  });

  describe('TestManifestSource', () => {
    it('activates only when __smrtManifestTest is populated', () => {
      const originalPackageName = process.env.npm_package_name;
      process.env.npm_package_name = '@happyvertical/smrt-core';

      const source = new TestManifestSource();
      try {
        expect(source.lookup({ className: 'Anything' })).toBeUndefined();

        (globalThis as ManifestGlobals).__smrtManifestTest = manifest(
          '@acme/pkg',
          { Widget: {} },
        );
        const hit = source.lookup({ className: 'Widget' });
        expect(hit?.source).toBe('test');
      } finally {
        if (originalPackageName) {
          process.env.npm_package_name = originalPackageName;
        } else {
          delete process.env.npm_package_name;
        }
      }
    });

    it('stays inert in consumer package test environments', () => {
      const originalPackageName = process.env.npm_package_name;
      process.env.npm_package_name = 'consumer-app';

      try {
        (globalThis as ManifestGlobals).__smrtManifestTest = manifest(
          '@happyvertical/smrt-core',
          { TestObject: {} },
        );

        const source = new TestManifestSource();
        expect(source.lookup({ className: 'TestObject' })).toBeUndefined();
        expect([...source.entries()]).toEqual([]);
      } finally {
        if (originalPackageName) {
          process.env.npm_package_name = originalPackageName;
        } else {
          delete process.env.npm_package_name;
        }
      }
    });

    it('does not treat non-smrt workspaces as core test environments', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'smrt-consumer-workspace-'));
      const workspacePath = join(tmp, 'pnpm-workspace.yaml');
      const packagePath = join(tmp, 'package.json');
      const originalPackageName = process.env.npm_package_name;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;

      writeFileSync(workspacePath, 'packages: []\n');
      writeFileSync(
        packagePath,
        JSON.stringify({ name: 'consumer-app', type: 'module' }),
      );

      try {
        process.chdir(tmp);
        delete process.env.npm_package_name;
        process.env.NODE_ENV = 'test';
        process.env.VITEST = 'true';

        expect(shouldLoadCoreTestManifest()).toBe(false);
      } finally {
        process.chdir(originalCwd);
        if (originalPackageName) {
          process.env.npm_package_name = originalPackageName;
        } else {
          delete process.env.npm_package_name;
        }
        if (originalNodeEnv) {
          process.env.NODE_ENV = originalNodeEnv;
        } else {
          delete process.env.NODE_ENV;
        }
        if (originalVitest) {
          process.env.VITEST = originalVitest;
        } else {
          delete process.env.VITEST;
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('does not treat sibling workspace packages as core test environments', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'smrt-workspace-'));
      const coreDir = join(tmp, 'packages', 'core');
      const consumerDir = join(tmp, 'packages', 'consumer');
      const originalPackageName = process.env.npm_package_name;
      const originalNodeEnv = process.env.NODE_ENV;
      const originalVitest = process.env.VITEST;

      mkdirSync(coreDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });
      writeFileSync(
        join(tmp, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\n',
      );
      writeFileSync(
        join(coreDir, 'package.json'),
        JSON.stringify({ name: '@happyvertical/smrt-core', type: 'module' }),
      );
      writeFileSync(
        join(consumerDir, 'package.json'),
        JSON.stringify({ name: '@acme/consumer-app', type: 'module' }),
      );

      try {
        process.chdir(consumerDir);
        delete process.env.npm_package_name;
        process.env.NODE_ENV = 'test';
        process.env.VITEST = 'true';

        expect(shouldLoadCoreTestManifest()).toBe(false);
      } finally {
        process.chdir(originalCwd);
        if (originalPackageName) {
          process.env.npm_package_name = originalPackageName;
        } else {
          delete process.env.npm_package_name;
        }
        if (originalNodeEnv) {
          process.env.NODE_ENV = originalNodeEnv;
        } else {
          delete process.env.NODE_ENV;
        }
        if (originalVitest) {
          process.env.VITEST = originalVitest;
        } else {
          delete process.env.VITEST;
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('StaticManifestSource', () => {
    // NOTE: StaticManifestSource queries `loadStaticManifestSyncWithNode`,
    // which hits the smrt-core bundled manifest. We don't override that here
    // — covering the "no static manifest" fallback path is enough for unit
    // scope. Parity testing happens in the integration harness.
    it('returns undefined when no static manifest is bundled', () => {
      (globalThis as ManifestGlobals).__smrtManifestStatic = {
        version: '1.0.0',
        timestamp: 0,
        packageName: '@happyvertical/smrt-core',
        objects: {},
      };
      const source = new StaticManifestSource();
      expect(source.lookup({ className: 'NeverExists' })).toBeUndefined();
    });
  });

  describe('EmbeddedManifestSource', () => {
    it('uses the package hint for direct cache access', () => {
      const cache = getManifestCache();
      cache.set(
        '@acme/pkg',
        manifest('@acme/pkg', {
          Widget: { fields: { size: { type: 'text' } } },
        }),
      );
      cache.set(
        '@other/pkg',
        manifest('@other/pkg', {
          Widget: { fields: { color: { type: 'text' } } },
        }),
      );

      const source = new EmbeddedManifestSource();

      // Qualified query resolves to the right package even with name collision
      const scoped = source.lookup({
        className: 'Widget',
        qualifiedName: '@other/pkg:Widget',
      });
      expect(scoped?.packageName).toBe('@other/pkg');
      expect(scoped?.def.fields?.color).toBeDefined();

      // Simple-name query returns a match from the cache (either package is fine,
      // but something must come back)
      const anyWidget = source.lookup({ className: 'Widget' });
      expect(anyWidget).toBeDefined();
    });

    it('iterates every cached manifest', () => {
      getManifestCache().set('@a/x', manifest('@a/x', { A: {} }));
      getManifestCache().set('@b/x', manifest('@b/x', { B: {} }));

      const source = new EmbeddedManifestSource();
      const entries = [...source.entries()];
      expect(entries.length).toBe(2);
      expect(entries.map((e) => e.className).sort()).toEqual(['A', 'B']);
    });
  });

  describe('ExplicitPathsManifestSource', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'smrt-explicit-'));
    });
    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('loads manifests from explicit paths at construction', () => {
      const path = join(tmp, 'manifest.json');
      writeFileSync(
        path,
        JSON.stringify(manifest('@acme/pkg', { Widget: {} })),
      );

      const source = new ExplicitPathsManifestSource([path]);
      const hit = source.lookup({ className: 'Widget' });
      expect(hit?.source).toBe('explicit-paths');
      expect(hit?.packageName).toBe('@acme/pkg');
    });

    it('ignores missing paths silently', () => {
      const source = new ExplicitPathsManifestSource([
        join(tmp, 'does-not-exist.json'),
      ]);
      expect([...source.entries()]).toEqual([]);
    });

    it('enumerates every entry across all loaded manifests', () => {
      const a = join(tmp, 'a.json');
      const b = join(tmp, 'b.json');
      writeFileSync(a, JSON.stringify(manifest('@a/x', { A1: {}, A2: {} })));
      writeFileSync(b, JSON.stringify(manifest('@b/x', { B1: {} })));

      const source = new ExplicitPathsManifestSource([a, b]);
      const names = [...source.entries()].map((e) => e.className).sort();
      expect(names).toEqual(['A1', 'A2', 'B1']);
    });
  });

  describe('NodeModulesFallbackSource', () => {
    let tmp: string;
    let originalCwd: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'smrt-fallback-'));
      originalCwd = process.cwd();
      process.chdir(tmp);
    });

    afterEach(() => {
      process.chdir(originalCwd);
      rmSync(tmp, { recursive: true, force: true });
    });

    it('lookup never returns hits; it only hydrates the embedded cache', () => {
      const source = new NodeModulesFallbackSource();
      expect(source.lookup({ className: 'Widget' })).toBeUndefined();
    });

    it('hydrate(packageName) loads from node_modules and seeds the embedded cache', async () => {
      const pkgDir = join(
        tmp,
        'node_modules',
        '@happyvertical',
        'smrt-fallback-fixture',
      );
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-fallback-fixture',
          exports: { './manifest.json': './dist/manifest.json' },
        }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 'manifest.json'),
        JSON.stringify(
          manifest('@happyvertical/smrt-fallback-fixture', { Widget: {} }),
        ),
      );

      const source = new NodeModulesFallbackSource();
      const hydrated = await source.hydrate({
        packageName: '@happyvertical/smrt-fallback-fixture',
      });

      expect(hydrated).toBe(true);
      expect(
        getManifestCache().has('@happyvertical/smrt-fallback-fixture'),
      ).toBe(true);
    });
  });

  describe('CompositeManifestSource', () => {
    it('queries sources in priority order, returning first hit', () => {
      const hits: string[] = [];
      const makeSource = (name: string, hit: boolean): ManifestSource => ({
        name,
        lookup() {
          hits.push(name);
          return hit
            ? ({
                className: 'Widget',
                def: { className: 'Widget', fields: {} } as any,
                source: name,
              } as ManifestEntry)
            : undefined;
        },
        *entries() {},
      });

      const composite = new CompositeManifestSource([
        makeSource('a', false),
        makeSource('b', true),
        makeSource('c', true), // never reached
      ]);

      const result = composite.lookup({ className: 'Widget' });
      expect(result?.source).toBe('b');
      expect(hits).toEqual(['a', 'b']);
    });

    it('deduplicates entries across sources by qualified name', () => {
      const entry = (name: string, sourceName: string): ManifestEntry => ({
        className: name,
        qualifiedName: `@pkg:${name}`,
        def: { className: name, fields: {} } as any,
        source: sourceName,
      });
      const makeSource = (
        name: string,
        items: ManifestEntry[],
      ): ManifestSource => ({
        name,
        lookup: () => undefined,
        *entries() {
          yield* items;
        },
      });

      const composite = new CompositeManifestSource([
        makeSource('a', [entry('Widget', 'a'), entry('Gizmo', 'a')]),
        // source b re-emits Widget; should be skipped by the seen-set
        makeSource('b', [entry('Widget', 'b'), entry('Doodad', 'b')]),
      ]);

      const collected = [...composite.entries()];
      expect(collected.map((e) => e.className)).toEqual([
        'Widget',
        'Gizmo',
        'Doodad',
      ]);
      // The Widget that won the dedup came from source 'a' (first yield)
      expect(collected.find((e) => e.className === 'Widget')?.source).toBe('a');
    });

    it('hydrate falls through each source until one returns true', async () => {
      const calls: string[] = [];
      const makeSource = (name: string, result: boolean): ManifestSource => ({
        name,
        lookup: () => undefined,
        *entries() {},
        async hydrate() {
          calls.push(name);
          return result;
        },
      });

      const composite = new CompositeManifestSource([
        makeSource('a', false),
        makeSource('b', true),
        makeSource('c', true), // never reached
      ]);

      const ok = await composite.hydrate({ className: 'Widget' });
      expect(ok).toBe(true);
      expect(calls).toEqual(['a', 'b']);
    });
  });
});
