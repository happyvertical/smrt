/**
 * AssetAssociation owners whose class moved package (#3338).
 *
 * The owner class declares its old qualified name in
 * `@smrt({ previousQualifiedNames })`. Rows written before the move store the
 * old `metaType`; rows written after store the current one. The polymorphic
 * owner-key reads must see both, and new writes must store the current name.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
