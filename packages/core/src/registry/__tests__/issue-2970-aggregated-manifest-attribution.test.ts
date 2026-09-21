/**
 * Regression test for #2970.
 *
 * A consumer app's generated `.smrt/manifest.json` is an AGGREGATE: it holds
 * the app's own scanned objects alongside entries copied verbatim from every
 * consumed package's manifest, each keyed by its qualified name and carrying
 * its own `packageName`. `registerFromManifest()` nevertheless derived a
 * class's qualified identity from the caller-supplied package — the package
 * that owns the *file* the entry was read from — and ignored what the entry
 * itself declares. Every foreign entry in that file was therefore re-attributed
 * to the consumer.
 *
 * Reached through two manifest candidates in one process — the aggregated
 * local manifest that `@happyvertical/smrt-vitest` loads at setup, then the
 * consumer's generated `.smrt/register.js` dynamically imported by a test —
 * one class became two registry entries under two packages, and the simple
 * name went ambiguous:
 *
 *   ConfigurationError: Ambiguous class name "SmrtHierarchical" — found in 2
 *   packages: @anytown/dashboard:SmrtHierarchical,
 *   @happyvertical/smrt-core:SmrtHierarchical
 *
 * Framework base classes are the visible casualty because
 * `@happyvertical/smrt-core`'s manifest contains nothing else, but nothing
 * about the defect is specific to them: any object a consumer aggregates is
 * equally exposed. The fix is identity, not a name list — an entry that names
 * its own package is registered under that package.
 *
 * Genuine cross-package name collisions must still be reported: two packages
 * each declaring their own class called `Invoice` are two different classes,
 * and `findClassStrict()` has to keep throwing for them.
 *
 * @see https://github.com/happyvertical/smrt/issues/2970
 * @see https://github.com/happyvertical/smrt/issues/2923
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectDefinition } from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
// The exact function that throws in the report. It is internal to the
// registry (no `ObjectRegistry.findClassStrict` façade), so the regression is
// pinned against it directly rather than against a proxy.
import { findClassStrict } from '../name-resolver.js';

const CORE_PKG = '@happyvertical/smrt-core';
const CONSUMER_PKG = '@anytown/dashboard';
const OTHER_PKG = '@happyvertical/smrt-sales';

function objectDef(
  className: string,
  packageName: string,
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/${packageName.split('/')[1]}/src/${className}.ts`,
    packageName,
    fields: {},
    methods: {},
    decoratorConfig: {},
    extends: extendsName,
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

describe('issue #2970: aggregated manifest entries keep their own package', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('does not re-attribute a foreign entry to the aggregating consumer', () => {
    // Step 1: smrt-vitest loads the consumer's aggregated `.smrt/manifest.json`
    // and passes that file's own `packageName` for every entry in it.
    ObjectRegistry.registerFromManifest(
      `${CORE_PKG}:SmrtHierarchical`,
      objectDef('SmrtHierarchical', CORE_PKG, 'SmrtObject'),
      CONSUMER_PKG,
    );

    const registered = findClassStrict('SmrtHierarchical');
    expect(registered?.packageName).toBe(CORE_PKG);
    expect(registered?.qualifiedName).toBe(`${CORE_PKG}:SmrtHierarchical`);
  });

  it('dedupes one class reached through two manifest candidates', () => {
    // Candidate 1: the aggregated local manifest, loaded by
    // `@happyvertical/smrt-vitest`'s setup with the consumer's own package
    // name for every entry in the file.
    ObjectRegistry.registerFromManifest(
      `${CORE_PKG}:SmrtHierarchical`,
      objectDef('SmrtHierarchical', CORE_PKG, 'SmrtObject'),
      CONSUMER_PKG,
    );
    // Candidate 2: the same class again, this time as the real constructor
    // the consumer's generated `.smrt/register.js` registers when a test
    // dynamically imports it — which names the declaring package.
    class SmrtHierarchical extends SmrtObject {}
    ObjectRegistry.register(SmrtHierarchical as typeof SmrtObject, {
      name: 'SmrtHierarchical',
      packageName: CORE_PKG,
    });

    expect(() => findClassStrict('SmrtHierarchical')).not.toThrow();

    // And the schema layer — the reported failing surface — completes.
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).not.toThrow();
  });

  it('still reports a genuine cross-package name collision as ambiguous', () => {
    ObjectRegistry.registerFromManifest(
      `${OTHER_PKG}:Invoice`,
      objectDef('Invoice', OTHER_PKG),
      OTHER_PKG,
    );
    // A different class, declared locally by the consumer, that happens to
    // share the simple name. Both entries name their own package, so this is
    // a real ambiguity and must keep throwing.
    ObjectRegistry.registerFromManifest(
      `${CONSUMER_PKG}:Invoice`,
      objectDef('Invoice', CONSUMER_PKG),
      CONSUMER_PKG,
    );

    expect(() => findClassStrict('Invoice')).toThrow(
      /Ambiguous class name "Invoice"/,
    );
  });

  it('falls back to the caller package when an entry declares none', () => {
    const def = objectDef('LocalWidget', CONSUMER_PKG);
    def.packageName = undefined;
    def.qualifiedName = undefined;

    ObjectRegistry.registerFromManifest('LocalWidget', def, CONSUMER_PKG);

    const registered = findClassStrict('LocalWidget');
    expect(registered?.packageName).toBe(CONSUMER_PKG);
    expect(registered?.qualifiedName).toBe(`${CONSUMER_PKG}:LocalWidget`);
  });
});
