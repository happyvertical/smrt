/**
 * AssetAssociation owners whose class moved package (#3338).
 *
 * The owner class declares its old qualified name in
 * `@smrt({ previousQualifiedNames })`. Rows written before the move store the
 * old `metaType`; rows written after store the current one. The polymorphic
 * owner-key reads must see both, and new writes must store the current name.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { loadManifestFromPathSync } from '@happyvertical/smrt-core/manifest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import '../asset';
import '../folder';
import { AssetAssociationCollection } from '../asset-associations';
import { AssetCollection } from '../assets';

const NEW_PKG = '@test-3338/assets-new-owner';
const CURRENT = `${NEW_PKG}:MovedOwner`;
const OLD = '@test-3338/assets-old-owner:MovedOwner';

describe('AssetAssociation owner moved package (#3338)', () => {
  let db: DatabaseInterface;
  let collection: AssetAssociationCollection;

  beforeAll(() => {
    ObjectRegistry.registerFromManifest(
      CURRENT,
      {
        name: 'movedowner',
        className: 'MovedOwner',
        qualifiedName: CURRENT,
        collection: 'movedowners',
        filePath: 'assets-new-owner/src/moved-owner.ts',
        packageName: NEW_PKG,
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: 'moved_owners_3338',
          previousQualifiedNames: [OLD],
        },
        exportName: 'MovedOwner',
        collectionExportName: 'MovedOwnerCollection',
      } as Parameters<typeof ObjectRegistry.registerFromManifest>[1],
      NEW_PKG,
    );
  });

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await AssetAssociationCollection.create({ db });
    const assets = await AssetCollection.create({ db });
    for (const assetId of ['asset-1', 'asset-2', 'asset-3']) {
      await assets.create({ id: assetId, name: `Fixture ${assetId}` });
    }
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function storedMetaTypes(): Promise<string[]> {
    const result = await db.query(
      'SELECT meta_type FROM asset_associations ORDER BY asset_id',
    );
    return (result.rows as Array<{ meta_type: string }>).map(
      (row) => row.meta_type,
    );
  }

  /** Seed a pre-move row: attach, then put the old name back in storage. */
  async function legacyAttach(assetId: string): Promise<void> {
    const link = await collection.attach(CURRENT, 'owner-1', assetId);
    await db.query(
      'UPDATE asset_associations SET meta_type = ? WHERE id = ?',
      OLD,
      link.id,
    );
  }

  it('attach() by the old name stores the current name', async () => {
    const link = await collection.attach(OLD, 'owner-1', 'asset-1');
    expect(link.metaType).toBe(CURRENT);
    expect(await storedMetaTypes()).toEqual([CURRENT]);
  });

  it('byLeft() by either name sees rows stored under both', async () => {
    await legacyAttach('asset-1');
    await collection.attach(CURRENT, 'owner-1', 'asset-2');
    expect(await storedMetaTypes()).toEqual([OLD, CURRENT]);

    for (const name of [CURRENT, OLD]) {
      const found = await collection.byLeft(name, 'owner-1');
      expect(found.map((link) => link.assetId).sort()).toEqual([
        'asset-1',
        'asset-2',
      ]);
    }
  });

  it('detach() and setLinks() remove legacy rows too', async () => {
    await legacyAttach('asset-1');
    await collection.detach(CURRENT, 'owner-1', 'asset-1');
    expect(await storedMetaTypes()).toEqual([]);

    await legacyAttach('asset-2');
    await collection.setLinks(OLD, 'owner-1', ['asset-3']);
    expect(await storedMetaTypes()).toEqual([CURRENT]);
    const found = await collection.byLeft(CURRENT, 'owner-1');
    expect(found.map((link) => link.assetId)).toEqual(['asset-3']);
  });
});

/**
 * Same contract when the owner class is NOT registered yet — only its new
 * owner's manifest is installed/cached (the lazy path, #3338 review F1).
 * Each case uses its own owner class so an earlier case's lazy load cannot
 * register the class a later case depends on.
 */
describe('AssetAssociation owner moved package, owner not yet registered (#3338)', () => {
  const LAZY_PKG = '@test-3338/assets-lazy-owner';
  const LAZY_OLD_PKG = '@test-3338/assets-lazy-old';
  const current = (n: number) => `${LAZY_PKG}:LazyOwner${n}`;
  const old = (n: number) => `${LAZY_OLD_PKG}:LazyOwner${n}`;
  let db: DatabaseInterface;
  let collection: AssetAssociationCollection;
  let manifestDir: string;

  beforeAll(() => {
    manifestDir = mkdtempSync(join(tmpdir(), 'smrt-3338-assets-lazy-'));
    const manifestPath = join(manifestDir, 'manifest.json');
    const objects: Record<string, unknown> = {};
    for (const n of [1, 2, 3, 4]) {
      objects[current(n)] = {
        name: `lazyowner${n}`,
        className: `LazyOwner${n}`,
        qualifiedName: current(n),
        collection: `lazyowner${n}s`,
        filePath: `assets-lazy-owner/src/lazy-owner-${n}.ts`,
        packageName: LAZY_PKG,
        fields: {},
        methods: {},
        decoratorConfig: {
          tableName: `lazy_owner_${n}_3338`,
          previousQualifiedNames: [old(n)],
        },
        exportName: `LazyOwner${n}`,
        collectionExportName: `LazyOwner${n}Collection`,
      };
    }
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: '1.0.0',
        timestamp: 0,
        packageName: LAZY_PKG,
        objects,
      }),
    );
    loadManifestFromPathSync(manifestPath);
  });

  afterAll(() => {
    rmSync(manifestDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await AssetAssociationCollection.create({ db });
    const assets = await AssetCollection.create({ db });
    for (const assetId of ['a1', 'a2', 'a3']) {
      await assets.create({ id: assetId, name: `Fixture ${assetId}` });
    }
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function rows(): Promise<
    Array<{ asset_id: string; meta_type: string }>
  > {
    const result = await db.query(
      'SELECT asset_id, meta_type FROM asset_associations ORDER BY asset_id',
    );
    return (result.rows as Array<{ asset_id: string; meta_type: string }>).map(
      ({ asset_id, meta_type }) => ({ asset_id, meta_type }),
    );
  }

  /** A pre-move row stored under the old name, written with raw SQL. */
  async function seedLegacy(n: number, assetId: string): Promise<void> {
    await db.query(
      `INSERT INTO asset_associations (id, slug, context, asset_id, meta_type, meta_id, role, sort_order)
       VALUES (?, ?, '', ?, ?, 'o', 'default', 0)`,
      `legacy-${n}-${assetId}`,
      `legacy-${n}-${assetId}`,
      assetId,
      old(n),
    );
  }

  it('attach() by the old name stores the current name', async () => {
    expect(ObjectRegistry.getClassByQualifiedName(current(1))).toBeUndefined();
    await collection.attach(old(1), 'o', 'a1');
    expect(await rows()).toEqual([{ asset_id: 'a1', meta_type: current(1) }]);
  });

  it('byLeft(current) includes legacy rows', async () => {
    expect(ObjectRegistry.getClassByQualifiedName(current(2))).toBeUndefined();
    await seedLegacy(2, 'a1');
    const found = await collection.byLeft(current(2), 'o');
    expect(found.map((link) => link.assetId)).toEqual(['a1']);
  });

  it('setLinks(current) replaces legacy rows too', async () => {
    expect(ObjectRegistry.getClassByQualifiedName(current(3))).toBeUndefined();
    await seedLegacy(3, 'a1');
    await collection.setLinks(current(3), 'o', ['a2']);
    expect(await rows()).toEqual([{ asset_id: 'a2', meta_type: current(3) }]);
  });

  it('detach(current) removes a legacy row', async () => {
    expect(ObjectRegistry.getClassByQualifiedName(current(4))).toBeUndefined();
    await seedLegacy(4, 'a3');
    await collection.detach(current(4), 'o', 'a3');
    expect(await rows()).toEqual([]);
  });
});
