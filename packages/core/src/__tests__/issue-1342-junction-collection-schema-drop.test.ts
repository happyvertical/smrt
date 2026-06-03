/**
 * Regression for #1342: cross-package junction tables (e.g. smrt-places
 * `place_assets`) lose their FK / junction columns in the vitest
 * lazy-table-creation path, while a structurally identical junction (e.g.
 * smrt-profiles `profile_assets`) keeps them.
 *
 * Root cause: `isCollectionRegistration()` only treated a registration as a
 * collection when its `extends` chain reached `SmrtCollection`. Junction
 * collections extend `SmrtJunction` (which extends `SmrtCollection`), but the
 * manifest records the *direct* parent `SmrtJunction`, and `SmrtJunction` is a
 * framework base that is not itself registered in a consumer's registry — so
 * the chain walk could not reach `SmrtCollection`. The junction Collection was
 * therefore mistaken for a regular table-bearing class.
 *
 * `getTestDatabase()` iterates every registered class. When the junction
 * Collection registration was iterated *before* its item class (purely a
 * function of registration / iteration order — the only thing that differs
 * between `place_assets` and `profile_assets` on the published packages), it
 * created the table from its own empty field set (base columns only) and
 * marked the table created. The real item class, carrying the full junction
 * schema, was then deduplicated out and never applied — yielding a
 * base-columns-only `place_assets` table missing place_id / asset_id /
 * relationship / sort_order / tenant_id.
 *
 * The fix teaches collection detection that `SmrtJunction` is a collection
 * base, so the junction Collection always redirects to its item class
 * regardless of iteration order.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const PKG = '@happyvertical/smrt-junction-fixture';

/**
 * Item-class manifest entry carrying the full junction schema, mirroring the
 * published `PlaceAsset` / `ProfileAsset` shape (FK + cross-package ref +
 * regular junction columns).
 */
function junctionItemManifest(itemName: string, ownerColumn: string) {
  return {
    className: itemName,
    qualifiedName: `${PKG}:${itemName}`,
    collection: `${itemName.toLowerCase()}s`,
    filePath: `/src/models/${itemName}.ts`,
    packageName: PKG,
    extends: 'SmrtObject',
    fields: {
      tenantId: { type: 'text', required: false },
      [`${ownerColumn}Id`]: {
        type: 'foreignKey',
        required: true,
        related: 'JunctionFixtureOwner',
        _meta: { required: true },
      },
      assetId: {
        type: 'crossPackageRef',
        required: true,
        related: '@happyvertical/smrt-assets-fixture:JunctionFixtureAsset',
      },
      relationship: { type: 'text', required: true, _meta: { required: true } },
      sortOrder: { type: 'integer', required: true, default: 0 },
    },
    methods: {},
    decoratorConfig: {
      tableName: `${ownerColumn}_assets`,
      conflictColumns: [`${ownerColumn}_id`, 'asset_id', 'relationship'],
      api: false,
      mcp: false,
      cli: false,
    },
    schema: {
      tableName: `${ownerColumn}_assets`,
      ddl: '',
      columns: {
        id: { type: 'UUID', primaryKey: true, notNull: true },
        slug: { type: 'TEXT', notNull: true },
        context: { type: 'TEXT', notNull: true, defaultValue: '' },
        created_at: { type: 'TIMESTAMP', notNull: true },
        updated_at: { type: 'TIMESTAMP', notNull: true },
        tenant_id: { type: 'TEXT' },
        [`${ownerColumn}_id`]: { type: 'UUID', notNull: true },
        asset_id: { type: 'UUID', notNull: true },
        relationship: { type: 'TEXT', notNull: true },
        sort_order: { type: 'INTEGER', notNull: true, defaultValue: 0 },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

/**
 * Junction Collection manifest stub, as the published manifest ships it:
 * `extends: 'SmrtJunction'`, a base-columns-only schema, and a `tableName`
 * that points at the junction table.
 */
function junctionCollectionManifest(itemName: string, tableName: string) {
  return {
    className: `${itemName}Collection`,
    qualifiedName: `${PKG}:${itemName}Collection`,
    collection: `${itemName.toLowerCase()}s`,
    filePath: `/src/collections/${itemName}Collection.ts`,
    packageName: PKG,
    extends: 'SmrtJunction',
    extendsTypeArg: itemName,
    fields: {},
    methods: {},
    decoratorConfig: {
      tableName,
      api: false,
      mcp: false,
      cli: false,
    },
    schema: {
      tableName,
      ddl: '',
      columns: {
        id: { type: 'UUID', primaryKey: true, notNull: true },
        slug: { type: 'TEXT', notNull: true },
        context: { type: 'TEXT', notNull: true, defaultValue: '' },
        created_at: { type: 'TIMESTAMP', notNull: true },
        updated_at: { type: 'TIMESTAMP', notNull: true },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1.0.0',
    },
  };
}

async function tableColumns(db: any, table: string): Promise<string[]> {
  const res = await db.query(`PRAGMA table_info(${table})`);
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r: any) => r.name);
}

describe('#1342 junction Collection schema drop', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    ObjectRegistry.clear();
    clearManifestCache();
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('keeps junction columns when the Collection registers before its item class', async () => {
    ObjectRegistry.clear();
    clearManifestCache();

    // The order that reproduces the bug: the junction Collection stub is
    // registered (and therefore iterated by getTestDatabase) BEFORE the real
    // item class. This is exactly the asymmetry between place_assets (broken)
    // and profile_assets (works by luck of order) on the published packages.
    ObjectRegistry.registerFromManifest(
      'PlaceFixtureAssetCollection',
      junctionCollectionManifest('PlaceFixtureAsset', 'place_fixture_assets'),
      PKG,
    );
    ObjectRegistry.registerFromManifest(
      'PlaceFixtureAsset',
      junctionItemManifest('PlaceFixtureAsset', 'place_fixture'),
      PKG,
    );

    const db = await getTestDatabase();
    const cols = await tableColumns(db, 'place_fixture_assets');

    expect(cols).toContain('place_fixture_id');
    expect(cols).toContain('asset_id');
    expect(cols).toContain('relationship');
    expect(cols).toContain('sort_order');
    expect(cols).toContain('tenant_id');
  });

  it('also keeps junction columns when the item class registers first (control)', async () => {
    ObjectRegistry.clear();
    clearManifestCache();

    // Item first, Collection second (the order that already worked for
    // profile_assets). Asserting it here guards against a fix that only moves
    // the breakage to the other order.
    ObjectRegistry.registerFromManifest(
      'ProfileFixtureAsset',
      junctionItemManifest('ProfileFixtureAsset', 'profile_fixture'),
      PKG,
    );
    ObjectRegistry.registerFromManifest(
      'ProfileFixtureAssetCollection',
      junctionCollectionManifest(
        'ProfileFixtureAsset',
        'profile_fixture_assets',
      ),
      PKG,
    );

    const db = await getTestDatabase();
    const cols = await tableColumns(db, 'profile_fixture_assets');

    expect(cols).toContain('profile_fixture_id');
    expect(cols).toContain('asset_id');
    expect(cols).toContain('relationship');
    expect(cols).toContain('sort_order');
    expect(cols).toContain('tenant_id');
  });
});
