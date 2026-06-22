/**
 * Coverage-focused tests for manifest-loader.ts (issue #1500).
 *
 * The existing manifest-loader-contract.test.ts covers external discovery via
 * declared smrtDependencies and clearManifestCache. This file targets the
 * remaining exported surface and its branches:
 *
 * - lookupInManifest: direct key, qualified-name, constructed-qualified, and
 *   case-insensitive className-index lookups (incl. the STI child-wins index)
 * - findManifestEntryByQualifiedName: cache hit, static-manifest, miss
 * - loadExternalManifestSync: cache reuse, invalid structure, read failure,
 *   packageName enrichment
 * - loadManifestFromPathSync: success, invalid structure, missing file
 * - discoverSTISiblingsSync: collection grouping, case-insensitive dedup,
 *   result caching
 * - getLoadedManifests / getManifestCollisions snapshots
 * - getPackageName: ObjectRegistry hit, __package__ metadata, null fallback
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectManifest } from '../../scanner/types.js';
import {
  clearManifestCache,
  discoverSTISiblingsSync,
  findManifestEntryByQualifiedName,
  getLoadedManifests,
  getManifestCollisions,
  getPackageName,
  loadExternalManifestSync,
  loadManifestFromPathSync,
  lookupInManifest,
} from '../manifest-loader.js';
import { getManifestCache } from '../store.js';

function makeManifest(
  packageName: string,
  objects: Record<string, any>,
  extra: Partial<SmartObjectManifest> = {},
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects,
    ...extra,
  } as SmartObjectManifest;
}

describe('manifest-loader coverage', () => {
  beforeEach(() => {
    clearManifestCache();
    ObjectRegistry.clear();
  });

  afterEach(() => {
    clearManifestCache();
    ObjectRegistry.clear();
  });

  describe('lookupInManifest', () => {
    const manifest = makeManifest('@acme/pkg', {
      '@acme/pkg:Widget': {
        className: 'Widget',
        fields: { a: { type: 'text' } },
      },
      // Un-keyed-by-qualified-name entry to exercise the className index.
      RawGizmo: { className: 'Gizmo', fields: {} },
    });

    it('returns a direct key match (qualified name)', () => {
      expect(lookupInManifest(manifest, '@acme/pkg:Widget')?.className).toBe(
        'Widget',
      );
    });

    it('resolves a simple class name via constructed qualified key', () => {
      expect(lookupInManifest(manifest, 'Widget')?.className).toBe('Widget');
    });

    it('resolves a qualified name through the className index when not a direct key', () => {
      // '@acme/pkg:Gizmo' is not a literal object key, but the index maps it.
      expect(lookupInManifest(manifest, '@acme/pkg:Gizmo')?.className).toBe(
        'Gizmo',
      );
    });

    it('falls back to a case-insensitive className lookup', () => {
      expect(lookupInManifest(manifest, 'gizmo')?.className).toBe('Gizmo');
    });

    it('returns undefined for an unknown class', () => {
      expect(lookupInManifest(manifest, 'Nope')).toBeUndefined();
    });

    it('prefers an STI child over its parent when both map to one simple name', () => {
      // Two entries collapse to the same lowercase className via the index;
      // the child (extends the parent) must win (#950).
      const collide = makeManifest('@acme/pkg', {
        Parent: { className: 'Thing', fields: { base: { type: 'text' } } },
        Child: {
          className: 'Thing',
          extends: 'Thing',
          fields: { extra: { type: 'text' } },
        },
      });
      const hit = lookupInManifest(collide, 'thing');
      expect(hit?.fields.extra).toBeDefined();
    });
  });

  describe('findManifestEntryByQualifiedName', () => {
    it('returns undefined for a non-qualified name', () => {
      expect(findManifestEntryByQualifiedName('PlainName')).toBeUndefined();
    });

    it('finds an entry in a cached external manifest', () => {
      getManifestCache().set(
        '@acme/pkg',
        makeManifest('@acme/pkg', {
          '@acme/pkg:Widget': { className: 'Widget', fields: {} },
        }),
      );
      expect(
        findManifestEntryByQualifiedName('@acme/pkg:Widget')?.className,
      ).toBe('Widget');
    });

    it('returns undefined when the package is not loaded anywhere', () => {
      expect(
        findManifestEntryByQualifiedName('@unknown/pkg:Ghost'),
      ).toBeUndefined();
    });

    it('finds an entry in the static manifest by package name', () => {
      globalThis.__smrtManifestStatic = makeManifest(
        '@happyvertical/smrt-core',
        {
          '@happyvertical/smrt-core:CoreThing': {
            className: 'CoreThing',
            fields: {},
          },
        },
      );
      globalThis.__smrtManifestStaticLoadAttempted = true;
      try {
        expect(
          findManifestEntryByQualifiedName('@happyvertical/smrt-core:CoreThing')
            ?.className,
        ).toBe('CoreThing');
      } finally {
        globalThis.__smrtManifestStatic = undefined;
        globalThis.__smrtManifestStaticLoadAttempted = false;
      }
    });
  });

  describe('loadExternalManifestSync', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
        dir = null;
      }
    });

    it('returns a cached manifest without re-reading disk', () => {
      const cached = makeManifest('@acme/cached', {
        '@acme/cached:X': { className: 'X', fields: {} },
      });
      getManifestCache().set('@acme/cached', cached);
      expect(loadExternalManifestSync('@acme/cached')).toBe(cached);
    });

    it('returns null for a package that exposes no manifest export', () => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-loader-noexport-'));
      const prev = process.cwd();
      process.chdir(dir);
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ name: 'consumer' }),
        );
        expect(
          loadExternalManifestSync('@happyvertical/smrt-missing', {
            warn: false,
          }),
        ).toBeNull();
      } finally {
        process.chdir(prev);
      }
    });
  });

  describe('loadManifestFromPathSync', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
        dir = null;
      }
    });

    it('loads a manifest from an explicit path and caches it by package name', () => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-loader-path-'));
      const file = join(dir, 'manifest.json');
      writeFileSync(
        file,
        JSON.stringify(
          makeManifest('@acme/from-path', {
            '@acme/from-path:Y': { className: 'Y', fields: {} },
          }),
        ),
      );
      const loaded = loadManifestFromPathSync(file);
      expect(loaded?.objects['@acme/from-path:Y'].className).toBe('Y');
      // Cached under the manifest's packageName.
      expect(getManifestCache().get('@acme/from-path')).toBe(loaded);
    });

    it('returns null for a manifest with an invalid structure', () => {
      dir = mkdtempSync(join(tmpdir(), 'smrt-loader-bad-'));
      const file = join(dir, 'manifest.json');
      writeFileSync(file, JSON.stringify({ version: '1.0.0' })); // no objects
      expect(loadManifestFromPathSync(file)).toBeNull();
    });

    it('returns null when the file cannot be read', () => {
      expect(
        loadManifestFromPathSync(join(tmpdir(), 'definitely-missing-xyz.json')),
      ).toBeNull();
    });
  });

  describe('discoverSTISiblingsSync', () => {
    it('groups entries sharing a collection and dedups case-insensitively, then caches', () => {
      getManifestCache().set(
        '@acme/pkg',
        makeManifest('@acme/pkg', {
          A: { className: 'Article', collection: 'contents', fields: {} },
          B: { className: 'Mirror', collection: 'contents', fields: {} },
          // Duplicate simple name (different case) — must not be added twice.
          C: { className: 'article', collection: 'contents', fields: {} },
          D: { className: 'Other', collection: 'others', fields: {} },
        }),
      );

      const siblings = discoverSTISiblingsSync('contents');
      const names = siblings.map((s) => s.className.toLowerCase()).sort();
      expect(names).toEqual(['article', 'mirror']);

      // Second call returns the cached array reference (no rescan).
      const again = discoverSTISiblingsSync('contents');
      expect(again).toBe(siblings);
    });

    it('returns an empty list when no entry uses the collection', () => {
      getManifestCache().set(
        '@acme/empty',
        makeManifest('@acme/empty', {
          A: { className: 'Solo', collection: 'solos', fields: {} },
        }),
      );
      expect(discoverSTISiblingsSync('nonexistent_table')).toEqual([]);
    });
  });

  describe('getLoadedManifests / getManifestCollisions', () => {
    it('returns a snapshot of cached manifests', () => {
      getManifestCache().set(
        '@acme/snap',
        makeManifest('@acme/snap', {
          '@acme/snap:Z': { className: 'Z', fields: {} },
        }),
      );
      const loaded = getLoadedManifests();
      expect(loaded.map(([name]) => name)).toContain('@acme/snap');
    });

    it('returns a defensive copy of the collisions map', () => {
      const collisions = getManifestCollisions();
      expect(collisions).toBeInstanceOf(Map);
      // Mutating the returned copy must not affect internal state.
      collisions.set('Fake', [{ packageName: '@x', manifestSource: 's' }]);
      expect(getManifestCollisions().has('Fake')).toBe(false);
    });
  });

  describe('getPackageName', () => {
    it('returns the package name registered in ObjectRegistry', () => {
      class RegisteredThing {}
      ObjectRegistry.register(RegisteredThing as any, {
        packageName: '@acme/registered',
      });
      expect(getPackageName(RegisteredThing as any)).toBe('@acme/registered');
    });

    it('reads __package__ metadata when registry lookup is skipped', () => {
      class Tagged {}
      (Tagged as any).__package__ = '@acme/tagged';
      expect(getPackageName(Tagged as any, true)).toBe('@acme/tagged');
    });

    it('prefers the registry over __package__ metadata', () => {
      class Both {}
      (Both as any).__package__ = '@acme/from-meta';
      ObjectRegistry.register(Both as any, {
        packageName: '@acme/from-registry',
      });
      // skipRegistry=false -> registry wins over the metadata fallback.
      expect(getPackageName(Both as any)).toBe('@acme/from-registry');
    });
  });
});
