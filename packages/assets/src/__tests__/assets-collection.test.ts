/**
 * Coverage for AssetCollection (assets.ts) — tenant-aware queries, classification
 * filters, the raw `asset_tags` join, and the version chain. Real in-memory
 * SQLite per SMRT testing conventions (no DB mocking). Wave-3 coverage uplift
 * to clear the S6 T2 floor and unblock the S10 assets consolidation (#1415).
 */
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset } from '../asset';
import { AssetCollection } from '../assets';

describe('AssetCollection', () => {
  let db: DatabaseInterface;
  let collection: AssetCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    collection = await AssetCollection.create({ db });
    // `asset_tags` is a raw join table (not an SMRT model), so it isn't in the
    // generated schema — create it for the tag tests, mirroring its production DDL.
    await db.query(
      'CREATE TABLE IF NOT EXISTS asset_tags (' +
        'asset_id TEXT NOT NULL, tag_slug TEXT NOT NULL, created_at TEXT, ' +
        'PRIMARY KEY (asset_id, tag_slug))',
    );
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
      await seed({ folderId: 'f1', name: 'inFolder' });
      await seed({ sourceAssetId: source.id, name: 'derived' });

      expect((await collection.getByFolder('f1')).map((a) => a.name)).toEqual([
        'inFolder',
      ]);
      const derivatives = await collection.getDerivatives(source.id as string);
      expect(derivatives.map((a) => a.name)).toEqual(['derived']);
    });
  });

  describe('tags (raw asset_tags join)', () => {
    it('addTag / getByTag / removeTag round-trip', async () => {
      const asset = await seed({ name: 'tagged' });

      await collection.addTag(asset.id as string, 'nature');
      const tagged = await collection.getByTag('nature');
      expect(tagged.map((a) => a.id)).toEqual([asset.id]);

      await collection.removeTag(asset.id as string, 'nature');
      expect(await collection.getByTag('nature')).toEqual([]);
    });

    it('addTag upserts on (asset_id, tag_slug) — no duplicates', async () => {
      const asset = await seed();
      await collection.addTag(asset.id as string, 'dup');
      await collection.addTag(asset.id as string, 'dup');
      expect(await collection.getByTag('dup')).toHaveLength(1);
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
