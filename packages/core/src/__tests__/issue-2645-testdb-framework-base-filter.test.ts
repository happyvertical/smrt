/**
 * Regression test for #2645.
 *
 * `getTestDatabase()`, when called without an explicit `classes` option,
 * defaults to `ObjectRegistry.getQualifiedClassNames()` — every
 * currently-registered class — and passed each non-STI-child registration
 * straight to `generateSchemaFromRegistry()`/`generateSTISchemaFromRegistry()`
 * with no framework-base filter. Any test environment whose registry has the
 * framework's own abstract base classes registered (which a downstream
 * package's generated manifest typically does, since `manifest-generator.ts`'s
 * dependency aggregation pulls them in from `@happyvertical/smrt-core`) got
 * phantom `smrt_objects`/`smrt_classes`/`smrt_collections`/
 * `smrt_hierarchicals`/`smrt_junctions`/`smrt_polymorphic_associations` tables
 * created in its throwaway in-memory test database.
 *
 * This is pre-existing behavior, unrelated to #2643/#2644 — that work only
 * fixed the separate production `buildMergedTableSchemas()` path
 * (`ObjectRegistry.getAllSchemasAsDefinitions()`/`getAllSchemas()`), covered
 * by `registry/__tests__/issue-2642-framework-base-no-table.test.ts`, whose
 * fixture this test mirrors. `getTestDatabase()` generates schemas directly
 * through the registry (`src/schema/generator.ts`), never through
 * `buildMergedTableSchemas()`, so it needed its own fix and its own coverage.
 *
 * @see https://github.com/happyvertical/smrt/issues/2645
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
} from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const CORE_PKG = '@happyvertical/smrt-core';
const FIXTURE_PKG = '@happyvertical/smrt-issue-2645-fixture';

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
 * mirrors `registry/__tests__/issue-2642-framework-base-no-table.test.ts`'s
 * fixture so both tests exercise the same registration shape.
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

const FRAMEWORK_BASE_TABLES = [
  'smrt_classes',
  'smrt_collections',
  'smrt_hierarchicals',
  'smrt_objects',
  'smrt_junctions',
  'smrt_polymorphic_associations',
];

async function listSqliteTableNames(
  db: Awaited<ReturnType<typeof getTestDatabase>>,
): Promise<string[]> {
  const result = await db.query(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  );
  const rows = Array.isArray(result)
    ? result
    : (result as { rows: Array<{ name: string }> }).rows;
  return rows.map((row) => row.name);
}

describe('issue #2645: getTestDatabase() excludes framework base classes from an implicit class list', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();

    for (const [name, def] of Object.entries(FRAMEWORK_BASE_FIXTURE)) {
      ObjectRegistry.registerFromManifest(name, def, CORE_PKG);
    }

    // A genuine domain class in the same registration pass proves the fix
    // does not over-broadly suppress real resources.
    ObjectRegistry.registerFromManifest(
      `${FIXTURE_PKG}:Widget`,
      objectDef('Widget', FIXTURE_PKG, {
        label: { type: 'text', required: false },
      }),
      FIXTURE_PKG,
    );
  });

  afterAll(() => {
    restoreRegistry();
  });

  it('creates no table for any of the six framework base classes when classes is implicit', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const tableNames = await listSqliteTableNames(db);

      for (const table of FRAMEWORK_BASE_TABLES) {
        expect(tableNames, `${table} must not be created`).not.toContain(table);
      }
      // A genuine domain class registered in the same pass still gets its
      // table — the filter must not be over-broad.
      expect(tableNames).toContain('widgets');
    } finally {
      await db.close?.();
    }
  });

  it('still creates the table for a framework base class named in an explicit classes list', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SmrtObject', 'Widget'],
    });
    try {
      const tableNames = await listSqliteTableNames(db);

      // The caller explicitly asked for SmrtObject, so it must be honored
      // even though it is a framework base class.
      expect(tableNames).toContain('smrt_objects');
      expect(tableNames).toContain('widgets');
    } finally {
      await db.close?.();
    }
  });
});
