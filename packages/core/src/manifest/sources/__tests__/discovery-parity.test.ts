/**
 * Discovery parity gate for Release B.
 *
 * Exercises the full discovery chain end-to-end: a fixture package is
 * written to disk, its manifest is loaded into the embedded cache via
 * `registerPackageManifest`, and then we verify that:
 *
 * 1. `discoverManifestSync(className)` (which now routes through the
 *    CompositeManifestSource) finds the same entry as a direct composite
 *    lookup.
 * 2. `loadAllManifests({ manifestPaths })` registers the same set of
 *    classes as a direct iteration over `ExplicitPathsManifestSource.entries()`.
 * 3. Package-scoped queries correctly disambiguate multi-package collisions
 *    of the same simple class name (Codex's review P1 #2).
 *
 * The 1520 pre-existing core tests form the broader parity net — this test
 * is a focused sanity check that fails loudly if the composite priority or
 * lookup semantics drift.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../../registry.js';
import type { SmartObjectManifest } from '../../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../../test-utils.js';
import {
  clearManifestCache,
  discoverManifestSync,
} from '../../manifest-loader.js';
import {
  getDefaultCompositeSource,
  resetDefaultCompositeSource,
} from '../composite.js';

function fixtureManifest(
  packageName: string,
  objects: Record<string, { fields?: Record<string, { type: string }> }>,
): SmartObjectManifest {
  const qualifiedObjects = Object.fromEntries(
    Object.entries(objects).map(([className, def]) => [
      `${packageName}:${className}`,
      { className, packageName, fields: def.fields ?? {} } as any,
    ]),
  );
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects: qualifiedObjects as any,
  };
}

function writeManifestFile(dir: string, manifest: SmartObjectManifest): string {
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

describe('discovery parity (Release B)', () => {
  let tempRoot = '';
  let restore: () => void;

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-parity-'));
    ObjectRegistry.clear();
    clearManifestCache();
    resetDefaultCompositeSource();
  });

  afterEach(() => {
    restore();
    ObjectRegistry.clear();
    clearManifestCache();
    resetDefaultCompositeSource();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('discoverManifestSync and composite.lookup return the same entry', () => {
    const pkg = '@acme/parity-fixture-a';
    const manifestPath = writeManifestFile(
      tempRoot,
      fixtureManifest(pkg, {
        Widget: { fields: { size: { type: 'text' } } },
      }),
    );
    ObjectRegistry.registerPackageManifest(pathToFileURL(manifestPath));

    const viaDiscover = discoverManifestSync('Widget');
    const viaComposite = getDefaultCompositeSource().lookup({
      className: 'Widget',
    });

    expect(viaDiscover).toBeDefined();
    expect(viaComposite).toBeDefined();
    expect(viaDiscover?.className).toBe(viaComposite?.def.className);
    expect(viaDiscover?.packageName).toBe(viaComposite?.packageName);
  });

  it('loadAllManifests({ manifestPaths }) registers every class the explicit source enumerates', () => {
    const pkgA = '@acme/parity-fixture-b';
    const pkgB = '@acme/parity-fixture-c';
    const subA = join(tempRoot, 'a');
    const subB = join(tempRoot, 'b');
    mkdirSync(subA);
    mkdirSync(subB);

    const pathA = writeManifestFile(
      subA,
      fixtureManifest(pkgA, { WidgetA: {}, GizmoA: {} }),
    );
    const pathB = writeManifestFile(
      subB,
      fixtureManifest(pkgB, { WidgetB: {} }),
    );

    const result = ObjectRegistry.loadAllManifests({
      manifestPaths: [pathA, pathB],
    });

    expect(result.objectsRegistered).toBe(3);
    expect(ObjectRegistry.findClass('WidgetA')).toBeDefined();
    expect(ObjectRegistry.findClass('GizmoA')).toBeDefined();
    expect(ObjectRegistry.findClass('WidgetB')).toBeDefined();
  });

  it('discoverManifestSync disambiguates qualified names across packages (review #1138)', () => {
    // Regression for PR #1138 review P1: discoverManifestSync previously
    // passed only `{ className }` to the composite, dropping the
    // qualified-name context. A query like `@pkg/b:Widget` could fall back
    // to a simple-name match in package A's manifest. Fixed by parsing
    // qualified names at the entry point before delegating.
    const pkgA = '@acme/parity-discover-qualified-a';
    const pkgB = '@acme/parity-discover-qualified-b';
    const subA = join(tempRoot, 'disc-a');
    const subB = join(tempRoot, 'disc-b');
    mkdirSync(subA);
    mkdirSync(subB);
    const pathA = writeManifestFile(
      subA,
      fixtureManifest(pkgA, { Widget: { fields: { a: { type: 'text' } } } }),
    );
    const pathB = writeManifestFile(
      subB,
      fixtureManifest(pkgB, { Widget: { fields: { b: { type: 'text' } } } }),
    );

    ObjectRegistry.registerPackageManifest(pathToFileURL(pathA));
    ObjectRegistry.registerPackageManifest(pathToFileURL(pathB));

    const hitA = discoverManifestSync(`${pkgA}:Widget`);
    const hitB = discoverManifestSync(`${pkgB}:Widget`);

    expect(hitA?.packageName).toBe(pkgA);
    expect(hitB?.packageName).toBe(pkgB);
    expect(hitA?.fields?.a).toBeDefined();
    expect(hitA?.fields?.b).toBeUndefined();
    expect(hitB?.fields?.b).toBeDefined();
    expect(hitB?.fields?.a).toBeUndefined();
  });

  it('package-scoped queries disambiguate same-simple-name collisions across packages', () => {
    // Two packages each define a `Widget`. A lookup with a qualified name
    // must resolve to the correct package's manifest even when both are
    // cached simultaneously.
    const pkgA = '@acme/parity-fixture-colliding-a';
    const pkgB = '@acme/parity-fixture-colliding-b';

    const subDirA = join(tempRoot, 'sub-a');
    mkdirSync(subDirA);
    const pathA = writeManifestFile(
      subDirA,
      fixtureManifest(pkgA, { Widget: { fields: { a: { type: 'text' } } } }),
    );
    const subDirB = join(tempRoot, 'sub-b');
    mkdirSync(subDirB);
    const pathB = writeManifestFile(
      subDirB,
      fixtureManifest(pkgB, { Widget: { fields: { b: { type: 'text' } } } }),
    );

    ObjectRegistry.registerPackageManifest(pathToFileURL(pathA));
    ObjectRegistry.registerPackageManifest(pathToFileURL(pathB));

    const composite = getDefaultCompositeSource();
    const hitA = composite.lookup({
      className: 'Widget',
      qualifiedName: `${pkgA}:Widget`,
    });
    const hitB = composite.lookup({
      className: 'Widget',
      qualifiedName: `${pkgB}:Widget`,
    });

    expect(hitA?.packageName).toBe(pkgA);
    expect(hitB?.packageName).toBe(pkgB);
    expect(hitA?.def.fields?.a).toBeDefined();
    expect(hitB?.def.fields?.b).toBeDefined();
    // Cross-package contamination check: a's manifest must not yield b's field
    expect(hitA?.def.fields?.b).toBeUndefined();
    expect(hitB?.def.fields?.a).toBeUndefined();
  });
});
