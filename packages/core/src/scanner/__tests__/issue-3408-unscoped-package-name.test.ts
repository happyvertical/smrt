/**
 * #3408: an app whose package.json name is unscoped must fail at scan time
 * with an actionable message, never emit `pkg:Class` keys that the registry's
 * own isolated-manifest validator rejects (CONFIG_INVALID_ISOLATED_MANIFEST).
 * Scoped names go through generate, register and runtime lookup.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import {
  assertScopedPackageName,
  isQualifiedName,
  isScopedPackageName,
} from '../../utils/qualified-names.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { ScanResult, SmartObjectManifest } from '../types.js';

function scanNote(): ScanResult[] {
  return [
    {
      filePath: 'src/note.ts',
      objects: [
        {
          name: 'note',
          className: 'Note',
          collection: 'notes',
          filePath: 'src/note.ts',
          fields: {},
          methods: {},
          decoratorConfig: { tableName: 'notes' },
          exportName: 'Note',
          collectionExportName: 'NoteCollection',
        },
      ],
      errors: [],
    },
  ];
}

describe('unscoped package names (#3408)', () => {
  afterEach(() => ObjectRegistry.clear());

  it('classifies package names exactly as isQualifiedName does', () => {
    for (const pkg of ['@my-app/start', '@happyvertical/smrt-core']) {
      expect(isScopedPackageName(pkg)).toBe(true);
      expect(isQualifiedName(`${pkg}:Note`)).toBe(true);
    }
    for (const pkg of ['smrt-start', '@smrt-start', 'a/b', '']) {
      expect(isScopedPackageName(pkg)).toBe(false);
      expect(isQualifiedName(`${pkg}:Note`)).toBe(false);
    }
  });

  it('rejects an unscoped name at generation with an actionable message', () => {
    expect(() =>
      new ManifestGenerator().generateManifest(scanNote(), {
        packageName: 'smrt-start',
      }),
    ).toThrow(/scoped package name.*"smrt-start".*@my-app\/smrt-start/s);
    try {
      assertScopedPackageName('smrt-start');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        'CONFIG_UNSCOPED_PACKAGE_NAME',
      );
    }
  });

  it('rejects an unscoped name in the shared generation passes', () => {
    const manifest: SmartObjectManifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: {},
    };
    // No classes, no qualified names: still builds.
    expect(() =>
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: 'smrt-start',
      }),
    ).not.toThrow();
    manifest.objects.note = scanNote()[0].objects[0];
    expect(() =>
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: 'smrt-start',
      }),
    ).toThrow(/scoped package name/);
  });

  it('allows a manifest with no package name (no qualified names generated)', () => {
    const manifest = new ManifestGenerator().generateManifest(scanNote());
    expect(Object.keys(manifest.objects)).toEqual(['note']);
  });

  it('generates, registers and resolves a scoped app name end to end', () => {
    const packageName = '@my-app/start';
    const manifest = new ManifestGenerator().generateManifest(scanNote(), {
      packageName,
    });
    const key = `${packageName}:Note`;
    expect(Object.keys(manifest.objects)).toEqual([key]);
    expect(isQualifiedName(key)).toBe(true);

    class Note extends SmrtObject {}
    const single = {
      ...manifest,
      objects: { [key]: manifest.objects[key] },
    };
    expect(() =>
      ObjectRegistry.register(Note, {
        name: 'Note',
        packageName,
        _manifest: single,
        _manifestKey: key,
      }),
    ).not.toThrow();
    expect(ObjectRegistry.getClass(key)).toBeDefined();
    expect(ObjectRegistry.getClass('Note')).toBeDefined();
  });
});
