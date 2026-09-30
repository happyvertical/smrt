/**
 * Coverage for AssetCollection (assets.ts) — tenant-aware queries, classification
 * filters, the `asset_tags` join (AssetTag), and the version chain. Real in-memory
 * SQLite per SMRT testing conventions (no DB mocking). Wave-3 coverage uplift
 * to clear the S6 T2 floor and unblock the S10 assets consolidation (#1415).
 */
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { TagCollection } from '@happyvertical/smrt-tags';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset } from '../asset';
import { AssetTagCollection } from '../asset-tags';
import { ASSET_TAG_CONTEXT, AssetCollection } from '../assets';
import { FolderCollection } from '../folders';

describe('AssetCollection', () => {
  let db: DatabaseInterface;
  let collection: AssetCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await AssetCollection.create({ db });
  });

  afterEach(async () => {
    await db.close?.();
  });

  function seed(overrides: Partial<Asset> = {}): Promise<Asset> {
    return collection.create({
      name: 'asset',
      typeSlug: 'image',
      statusSlug: 'published',
      mimeType: 'image/png',
      sourceUri: 'file:///x.png',
      ...overrides,
    }) as Promise<Asset>;
  }

  describe('tenant-aware queries', () => {
    it('findByTenant returns only that tenant’s assets', async () => {
      await seed({ tenantId: 't1', name: 'a' });
      await seed({ tenantId: 't2', name: 'b' });
      await seed({ tenantId: null, name: 'g' });

      const result = await collection.findByTenant('t1');
      expect(result.map((a) => a.name)).toEqual(['a']);
    });

    it('findGlobal returns only tenantless assets', async () => {
      await seed({ tenantId: 't1', name: 'a' });
      await seed({ tenantId: null, name: 'g' });

      const result = await collection.findGlobal();
      expect(result.map((a) => a.name)).toEqual(['g']);
      expect(result.every((a) => a.tenantId === null)).toBe(true);
    });

    it('findWithGlobals returns the tenant’s assets plus globals', async () => {
      await seed({ tenantId: 't1', name: 'a' });
      await seed({ tenantId: 't2', name: 'b' });
      await seed({ tenantId: null, name: 'g' });

      const result = await collection.findWithGlobals('t1');
      expect(result.map((a) => a.name).sort()).toEqual(['a', 'g']);
    });
  });

  describe('classification queries', () => {
    it('getByType / getByStatus / getByOwner filter on their column', async () => {
      await seed({
        typeSlug: 'image',
        statusSlug: 'published',
        ownerProfileId: 'p1',
        name: 'img',
      });
      await seed({
        typeSlug: 'video',
        statusSlug: 'draft',
        ownerProfileId: 'p2',
        name: 'vid',
      });

      expect((await collection.getByType('image')).map((a) => a.name)).toEqual([
        'img',
      ]);
      expect(
        (await collection.getByStatus('draft')).map((a) => a.name),
      ).toEqual(['vid']);
      expect((await collection.getByOwner('p1')).map((a) => a.name)).toEqual([
        'img',
      ]);
    });

    it('getByMimeType matches a wildcard pattern', async () => {
      await seed({ mimeType: 'image/png', name: 'png' });
      await seed({ mimeType: 'image/jpeg', name: 'jpg' });
      await seed({ mimeType: 'video/mp4', name: 'mp4' });

      const images = await collection.getByMimeType('image/*');
      expect(images.map((a) => a.name).sort()).toEqual(['jpg', 'png']);
    });

    it('getByFolder / getDerivatives filter on their FK', async () => {
      const source = await seed({ name: 'source' });
      const folders = await FolderCollection.create({ db });
      await folders.create({ id: 'f1', name: 'Fixture folder' });
      await seed({ folderId: 'f1', name: 'inFolder' });
      await seed({ sourceAssetId: source.id, name: 'derived' });

      expect((await collection.getByFolder('f1')).map((a) => a.name)).toEqual([
        'inFolder',
      ]);
      const derivatives = await collection.getDerivatives(source.id as string);
      expect(derivatives.map((a) => a.name)).toEqual(['derived']);
    });
  });

  describe('tags (asset_tags → smrt-tags Tag)', () => {
    it('addTag / getByTag / removeTag round-trip', async () => {
      const asset = await seed({ name: 'tagged' });

      await collection.addTag(asset.id as string, 'nature');
      const tagged = await collection.getByTag('nature');
      expect(tagged.map((a) => a.id)).toEqual([asset.id]);
      expect(await asset.hasTag('nature')).toBe(true);

      await collection.removeTag(asset.id as string, 'nature');
      expect(await collection.getByTag('nature')).toEqual([]);
      expect(await asset.hasTag('nature')).toBe(false);
    });

    it('addTag is idempotent — one link, one tag', async () => {
      const asset = await seed();
      const first = await collection.addTag(asset.id as string, 'dup');
      const second = await collection.addTag(asset.id as string, 'dup');
      expect(second.id).toBe(first.id);
      expect(await collection.getByTag('dup')).toHaveLength(1);
      expect(await asset.getTags()).toHaveLength(1);
    });

    it('accepts a label, stores its slug and keeps the label as the name', async () => {
      const asset = await seed();
      const tag = await collection.addTag(asset.id as string, 'Town hall');
      expect(tag.slug).toBe('town-hall');
      expect(tag.name).toBe('Town hall');
      expect(tag.context).toBe(ASSET_TAG_CONTEXT);
      expect((await collection.getByTag('town-hall')).map((a) => a.id)).toEqual(
        [asset.id],
      );
    });

    it('creates the tag in the asset tenant and never reuses another tenant tag', async () => {
      const a = await seed({ tenantId: 't1' });
      const b = await seed({ tenantId: 't2' });
      const tagA = await collection.addTag(a.id as string, 'park');
      const tagB = await collection.addTag(b.id as string, 'park');
      expect(tagA.tenantId).toBe('t1');
      expect(tagB.tenantId).toBe('t2');
      expect(tagB.id).not.toBe(tagA.id);

      const links = await AssetTagCollection.create({ db });
      const rows = await links.list({});
      expect(
        rows.map((row) => [row.assetId, row.tagId, row.tenantId]).sort(),
      ).toEqual(
        [
          [a.id, tagA.id, 't1'],
          [b.id, tagB.id, 't2'],
        ].sort(),
      );
    });

    it('setTags replaces the asset tags; getTagsForAssets batches them', async () => {
      const one = await seed({ name: 'one' });
      const two = await seed({ name: 'two' });
      await collection.setTags(one.id as string, ['Park', 'Spring']);
      await collection.setTags(one.id as string, ['park', 'Landmark']);
      await collection.addTag(two.id as string, 'spring');

      const map = await collection.getTagsForAssets([
        one.id as string,
        two.id as string,
        'missing',
      ]);
      expect(map.get(one.id as string)?.map((t) => t.slug)).toEqual([
        'landmark',
        'park',
      ]);
      expect(map.get(two.id as string)?.map((t) => t.slug)).toEqual(['spring']);
      expect(map.get('missing')).toEqual([]);
    });

    it('deleting the asset removes its tag links but keeps the tag', async () => {
      const asset = await seed();
      const tag = await collection.addTag(asset.id as string, 'gone');
      await asset.delete();

      const links = await AssetTagCollection.create({ db });
      expect(await links.list({})).toEqual([]);
      const tags = await TagCollection.create({ db });
      expect((await tags.get({ id: tag.id as string }))?.slug).toBe('gone');
    });

    it('rejects an empty tag and an unknown asset', async () => {
      const asset = await seed();
      await expect(
        collection.addTag(asset.id as string, '  !! '),
      ).rejects.toThrow(/letter or digit/);
      await expect(collection.addTag('no-such-asset', 'x')).rejects.toThrow(
        /not found/,
      );
    });
  });

  describe('version chain', () => {
    it('createNewVersion chains off the primary, incrementing version', async () => {
      const v1 = await seed({ name: 'doc', sourceUri: 'file:///v1' });

      const v2 = await collection.createNewVersion(
        v1.id as string,
        'file:///v2',
      );
      expect(v2.version).toBe(2);
      expect(v2.primaryVersionId).toBe(v1.id);
      expect(v2.sourceUri).toBe('file:///v2');

      const v3 = await collection.createNewVersion(
        v1.id as string,
        'file:///v3',
      );
      expect(v3.version).toBe(3);
    });

    it('listVersions returns the whole chain ordered by version', async () => {
      const v1 = await seed();
      await collection.createNewVersion(v1.id as string, 'file:///v2');
      await collection.createNewVersion(v1.id as string, 'file:///v3');

      const versions = await collection.listVersions(v1.id as string);
      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it('getLatestVersion returns the highest version, or null when unknown', async () => {
      const v1 = await seed();
      await collection.createNewVersion(v1.id as string, 'file:///v2');

      expect(
        (await collection.getLatestVersion(v1.id as string))?.version,
      ).toBe(2);
      expect(await collection.getLatestVersion('does-not-exist')).toBeNull();
    });

    it('createNewVersion throws for an unknown primary version', async () => {
      await expect(
        collection.createNewVersion('does-not-exist', 'file:///x'),
      ).rejects.toThrow(/No asset found/);
    });

    it('createNewVersion keeps a distinct slug when the base already ends in -vN', async () => {
      // A primary slug shaped like `<x>-vN` must not regenerate to a slug that
      // collides with the primary (which would upsert-overwrite it).
      const v1 = await seed({ slug: 'spec-v2', name: 'spec' });
      const v2 = await collection.createNewVersion(
        v1.id as string,
        'file:///v2',
      );

      expect(v2.slug).not.toBe(v1.slug);
      const versions = await collection.listVersions(v1.id as string);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
    });

    it('rollbackToVersion creates a new version copying the target’s content', async () => {
      const v1 = await seed({ sourceUri: 'file:///v1' });
      await collection.createNewVersion(v1.id as string, 'file:///v2');

      const rolled = await collection.rollbackToVersion(v1.id as string, 1);
      expect(rolled.version).toBe(3);
      expect(rolled.sourceUri).toBe('file:///v1');
    });

    it('rollbackToVersion throws for a missing target version', async () => {
      const v1 = await seed();
      await expect(
        collection.rollbackToVersion(v1.id as string, 99),
      ).rejects.toThrow(/not found/);
    });
  });
});
