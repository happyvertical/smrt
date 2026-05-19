/**
 * Folder schema + hierarchy smoke tests (R3-D).
 *
 * Confirms that:
 * - Folder is registered as its own table (`folders`), not STI on `assets`.
 * - The schema generator emits a `folders` table with `parent_id`
 *   inherited from SmrtHierarchical.
 * - `Asset` no longer has a `parent_id` column (rename to `source_asset_id`).
 * - Folder inherits SmrtHierarchical traversal helpers and they work
 *   end-to-end against a real in-memory SQLite DB.
 */

import { generateSchema } from '@happyvertical/smrt-core/schema/utils';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asset } from '../asset';
import { Folder } from '../folder';
import { FolderCollection } from '../folders';

describe('Folder schema (R3-D)', () => {
  it('emits its own folders table with inherited parent_id', async () => {
    const schema = await generateSchema(Folder);

    // Folder lives on its own table — not STI on the assets table.
    expect(schema).toContain('CREATE TABLE');
    expect(schema).toContain('folders');
    // parent_id is inherited from SmrtHierarchical
    expect(schema).toContain('"parent_id"');
  });

  it('Asset schema no longer has parent_id — it became source_asset_id', async () => {
    const schema = await generateSchema(Asset);

    expect(schema).toContain('"source_asset_id"');
    expect(schema).not.toContain('"parent_id"');
  });
});

describe('Folder hierarchy traversal', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('inherits getDescendants / getAncestors / moveTo from SmrtHierarchical', async () => {
    const collection = await FolderCollection.create({ db });

    const root = (await collection.create({
      name: 'Root',
      slug: 'root',
    })) as Folder;
    const mid = (await collection.create({
      name: 'Mid',
      slug: 'mid',
      parentId: root.id,
    })) as Folder;
    const leaf = (await collection.create({
      name: 'Leaf',
      slug: 'leaf',
      parentId: mid.id,
    })) as Folder;

    const descendants = await root.getDescendants();
    expect(descendants.map((f) => f.id).sort()).toEqual(
      [mid.id, leaf.id].sort(),
    );

    const ancestors = await leaf.getAncestors();
    expect(ancestors.map((f) => f.id)).toEqual([root.id, mid.id]);
  });

  it('FolderCollection.getTree returns top-level folders when called without rootId', async () => {
    const collection = await FolderCollection.create({ db });
    await collection.create({ name: 'A', slug: 'a' });
    await collection.create({ name: 'B', slug: 'b' });
    const child = (await collection.create({
      name: 'A1',
      slug: 'a1',
    })) as Folder;
    // Child becomes a child of A
    const a = (await collection.get({ slug: 'a' })) as Folder;
    child.parentId = a.id;
    await child.save();

    const tops = await collection.getTree();
    expect(tops.map((f) => f.slug).sort()).toEqual(['a', 'b']);
  });

  it('FolderCollection.getPath walks ancestors + self', async () => {
    const collection = await FolderCollection.create({ db });

    const root = (await collection.create({
      name: 'Root',
      slug: 'r',
    })) as Folder;
    const mid = (await collection.create({
      name: 'Mid',
      slug: 'm',
      parentId: root.id,
    })) as Folder;
    const leaf = (await collection.create({
      name: 'Leaf',
      slug: 'l',
      parentId: mid.id,
    })) as Folder;

    const path = await collection.getPath(leaf.id!);
    expect(path.map((f) => f.slug)).toEqual(['r', 'm', 'l']);
  });

  it('FolderCollection.getTree sorts subtree results by name (R3-D round-2 regression)', async () => {
    const collection = await FolderCollection.create({ db });

    const root = (await collection.create({
      name: 'Root',
      slug: 'root2',
    })) as Folder;
    // Create children out of alphabetical order to verify sort.
    await collection.create({ name: 'Zulu', slug: 'zulu', parentId: root.id });
    await collection.create({
      name: 'Alpha',
      slug: 'alpha',
      parentId: root.id,
    });
    await collection.create({ name: 'Mike', slug: 'mike', parentId: root.id });

    const tree = await collection.getTree(root.id!);
    expect(tree.map((f) => f.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('moveTo refuses to create a cycle', async () => {
    const collection = await FolderCollection.create({ db });

    const a = (await collection.create({ name: 'A', slug: 'a' })) as Folder;
    const b = (await collection.create({
      name: 'B',
      slug: 'b',
      parentId: a.id,
    })) as Folder;

    // Moving A under B would create a cycle (B is a descendant of A).
    await expect(a.moveTo(b)).rejects.toThrow(/cycle/i);
  });
});

describe('Asset derivation chain (R3-D rename)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('Asset.getSource / Asset.getDerivatives walk the rename column', async () => {
    const { AssetCollection } = await import('../assets');
    const collection = await AssetCollection.create({ db });

    const source = (await collection.create({
      name: 'Source',
      slug: 'src',
      mimeType: 'image/jpeg',
      typeSlug: 'image',
    })) as Asset;
    const thumb = (await collection.create({
      name: 'Thumb',
      slug: 'thumb',
      mimeType: 'image/jpeg',
      typeSlug: 'image',
      sourceAssetId: source.id,
    })) as Asset;

    const reloadedSource = await thumb.getSource();
    expect(reloadedSource?.id).toBe(source.id);

    const derivatives = await source.getDerivatives();
    expect(derivatives.map((a) => a.id)).toEqual([thumb.id]);
  });
});
