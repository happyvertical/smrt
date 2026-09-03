/**
 * Regression test for #2642.
 *
 * `@happyvertical/smrt-core` ships a manifest whose only contents are its
 * six abstract framework base classes (`SmrtObject`, `SmrtClass`,
 * `SmrtCollection`, `SmrtHierarchical`, `SmrtJunction`,
 * `SmrtPolymorphicAssociation`). They carry no `@smrt()` decorator and have
 * no independent existence as a resource — but a foundation package declares
 * them as real local classes (there is no other package for them to live
 * in), so `ObjectRegistry.loadAllManifests()` registers them exactly like
 * any genuine domain class when a consumer installs
 * `@happyvertical/smrt-core`, with no decoration or framework-base filter of
 * its own.
 *
 * Confirmed empirically against a real installed multi-package consumer
 * (`packages/template-sveltekit` + its actual `@happyvertical/smrt-*`
 * dependencies, resolved through genuine pnpm workspace symlinks — not a
 * manual registration shortcut): `getAllSchemasAsDefinitions()` and
 * `smrt db:migrate --dry-run` both planned literal
 * `CREATE TABLE IF NOT EXISTS "smrt_objects"` (and `smrt_classes`,
 * `smrt_hierarchicals`, `smrt_polymorphic_associations`, `smrt_collections`)
 * DDL, indistinguishable from real domain tables.
 *
 * This test reproduces the manifest shape directly (mirroring the exact
 * classes core's own `dist/manifest.json` ships) and proves the schema layer
 * — `ObjectRegistry.getAllSchemasAsDefinitions()` — no longer plans a table
 * for any of them, while a genuine `@smrt()`-decorated class in the same
 * registration pass, including one that extends a framework base
 * (`SmrtHierarchical`), still gets its own table untouched.
 *
 * @see https://github.com/happyvertical/smrt/issues/2642
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';

const CORE_PKG = '@happyvertical/smrt-core';
const FIXTURE_PKG = '@happyvertical/smrt-issue-2642-fixture';

function objectDef(
  className: string,
  packageName: string,
  fields: Record<string, FieldDefinition>,
  extendsName?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/fixture/src/${className}.ts`,
    packageName,
    fields,
    methods: {},
    decoratorConfig: {},
    extends: extendsName,
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

/**
 * The exact six classes core's own shipped `dist/manifest.json` contains —
 * see the issue's "already proven" step and this repo's Phase 1
 * verification for #2642.
 */
const FRAMEWORK_BASE_FIXTURE: Record<string, SmartObjectDefinition> = {
  [`${CORE_PKG}:SmrtClass`]: objectDef('SmrtClass', CORE_PKG, {}),
  [`${CORE_PKG}:SmrtCollection`]: objectDef('SmrtCollection', CORE_PKG, {}),
  [`${CORE_PKG}:SmrtObject`]: objectDef('SmrtObject', CORE_PKG, {}),
  [`${CORE_PKG}:SmrtHierarchical`]: objectDef(
    'SmrtHierarchical',
    CORE_PKG,
    { parentId: { type: 'text', required: false } },
    'SmrtObject',
  ),
  [`${CORE_PKG}:SmrtJunction`]: objectDef(
    'SmrtJunction',
    CORE_PKG,
    {},
    'SmrtCollection',
  ),
  [`${CORE_PKG}:SmrtPolymorphicAssociation`]: objectDef(
    'SmrtPolymorphicAssociation',
    CORE_PKG,
    {
      metaType: { type: 'text', required: true },
      metaId: { type: 'text', required: true },
    },
    'SmrtObject',
  ),
};

describe('issue #2642: framework base classes produce no table', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();

    for (const [name, def] of Object.entries(FRAMEWORK_BASE_FIXTURE)) {
      ObjectRegistry.registerFromManifest(name, def, CORE_PKG);
    }

    // A genuine domain class in the SAME registration pass, including one
    // that extends a framework base — proves the fix does not over-broadly
    // suppress real resources or their inherited fields.
    ObjectRegistry.registerFromManifest(
      `${FIXTURE_PKG}:Widget`,
      objectDef('Widget', FIXTURE_PKG, {
        label: { type: 'text', required: false },
      }),
      FIXTURE_PKG,
    );
    // Real manifests ship a subclass's inherited framework-base fields
    // already merged into its own `fields` map (manifest-generator.ts's
    // `FRAMEWORK_ABSTRACT_BASE_NAMES` merge, out of this fix's scope) — this
    // fixture reproduces that shipped shape directly rather than exercising
    // the merge mechanism itself.
    ObjectRegistry.registerFromManifest(
      `${FIXTURE_PKG}:Folder`,
      objectDef(
        'Folder',
        FIXTURE_PKG,
        {
          name: { type: 'text', required: false },
          parentId: { type: 'text', required: false },
        },
        'SmrtHierarchical',
      ),
      FIXTURE_PKG,
    );
  });

  afterAll(() => {
    restoreRegistry();
  });

  it('plans no table for any of the six framework base classes', async () => {
    const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
    const tableNames = Object.keys(schemas);

    const frameworkBaseTables = [
      'smrt_classes',
      'smrt_collections',
      'smrt_hierarchicals',
      'smrt_objects',
      'smrt_junctions',
      'smrt_polymorphic_associations',
    ];
    for (const table of frameworkBaseTables) {
      expect(tableNames, `${table} must not be planned`).not.toContain(table);
    }
  });

  it('still plans a table for a genuine domain class in the same pass', async () => {
    const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.widgets).toBeDefined();
    expect(Object.keys(schemas.widgets?.columns ?? {})).toContain('label');
  });

  it('still plans a table for a domain class that extends a framework base, with the inherited column', async () => {
    const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.folders).toBeDefined();
    const columns = Object.keys(schemas.folders?.columns ?? {});
    expect(columns).toContain('name');
    expect(columns).toContain('parent_id');
  });
});
